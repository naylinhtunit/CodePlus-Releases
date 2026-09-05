use futures_util::StreamExt;
mod runtime;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use wait_timeout::ChildExt;
#[cfg(unix)] use std::os::unix::process::CommandExt;

static DEV_SERVERS: OnceLock<Mutex<HashMap<String, std::process::Child>>> = OnceLock::new();
fn dev_servers() -> &'static Mutex<HashMap<String, std::process::Child>> {
  DEV_SERVERS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
  let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid external URL.".to_string())?;
  if !matches!(parsed.scheme(), "http" | "https") {
    return Err("Only http and https links can be opened.".to_string());
  }
  app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|error| error.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateInfo {
  current_version: String,
  version: String,
}

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
  app.package_info().version.to_string()
}

#[tauri::command]
async fn check_app_update(app: tauri::AppHandle) -> Result<Option<AppUpdateInfo>, String> {
  let current_version = app.package_info().version.to_string();
  let update = app.updater().map_err(|error| error.to_string())?
    .check().await.map_err(|error| error.to_string())?;
  Ok(update.map(|item| AppUpdateInfo { current_version, version: item.version }))
}

#[tauri::command]
async fn install_app_update(app: tauri::AppHandle) -> Result<(), String> {
  let update = app.updater().map_err(|error| error.to_string())?
    .check().await.map_err(|error| error.to_string())?
    .ok_or_else(|| "CodePlus is already up to date.".to_string())?;
  let progress_app = app.clone();
  let finished_app = app.clone();
  let mut downloaded = 0_u64;
  update.download_and_install(
    move |chunk_length, content_length| {
      downloaded = downloaded.saturating_add(chunk_length as u64);
      let _ = progress_app.emit("app-update-progress", json!({
        "stage": "downloading",
        "downloaded": downloaded,
        "total": content_length
      }));
    },
    move || {
      let _ = finished_app.emit("app-update-progress", json!({ "stage": "installing" }));
    }
  ).await.map_err(|error| error.to_string())?;
  let _ = app.emit("app-update-progress", json!({ "stage": "restarting" }));
  app.restart();
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct ToolCall { id: String, name: String, arguments: Value, #[serde(default, skip_serializing_if = "Option::is_none")] thought_signature: Option<String> }

#[derive(Debug, Deserialize, Serialize, Clone)]
struct Message { role: String, content: String, #[serde(default, skip_serializing_if = "Option::is_none")] tool_calls: Option<Vec<ToolCall>>, #[serde(default, skip_serializing_if = "Option::is_none")] tool_call_id: Option<String>, #[serde(default, skip_serializing_if = "Option::is_none")] name: Option<String> }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRequest { provider: String, model: String, messages: Vec<Message>, local_url: Option<String>, api_key: Option<String>, context: Option<Vec<CtxItem>>, tools_enabled: Option<bool>, require_tool: Option<bool> }
#[derive(Debug, Deserialize, Clone)]
struct CtxItem { name: String, #[serde(default)] content: String }

#[derive(Debug, Serialize)]
struct AskResponse { content: String, tool_calls: Option<Vec<ToolCall>> }

fn with_context(mut messages: Vec<Message>, context: &Option<Vec<CtxItem>>) -> Vec<Message> {
  if let Some(items) = context {
    let text: String = items.iter()
      .filter(|item| !item.content.is_empty())
      .map(|item| format!("\n<attachment name=\"{}\">\n{}\n</attachment>", item.name.replace(['<', '>', '&', '"'], ""), item.content))
      .collect();
    if !text.is_empty() {
      let sys = Message { role: "system".into(), content: format!("The user attached these project files and command outputs as context:{text}"), tool_calls: None, tool_call_id: None, name: None };
      if let Some(idx) = messages.iter().position(|m| m.role == "system") {
        let orig = messages.remove(idx);
        messages.insert(0, orig);
        messages.insert(1, sys);
      } else {
        messages.insert(0, sys);
      }
    }
  }
  messages
}

fn agent_tools() -> Value {
  json!([
    {"type":"function","function":{"name":"read","description":"Read file content. Use to understand codebase before editing.","parameters":{"type":"object","properties":{"filePath":{"type":"string","description":"Relative path from project root, e.g. src/app/page.tsx"}},"required":["filePath"]}}},
    {"type":"function","function":{"name":"write","description":"Create new file or overwrite existing one. Use for new files; prefer edit for surgical changes.","parameters":{"type":"object","properties":{"filePath":{"type":"string"},"content":{"type":"string","description":"Full file content"}},"required":["filePath","content"]}}},
    {"type":"function","function":{"name":"edit","description":"Exact string replacement in an existing file. oldString must match exactly including whitespace.","parameters":{"type":"object","properties":{"filePath":{"type":"string"},"oldString":{"type":"string"},"newString":{"type":"string"},"replaceAll":{"type":"boolean"}},"required":["filePath","oldString","newString"]}}},
    {"type":"function","function":{"name":"bash","description":"Run a shell command in the project root. Use for git, npm, tests. Timeout 30s.","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}},
    {"type":"function","function":{"name":"glob","description":"Find files by glob pattern. Returns matching paths.","parameters":{"type":"object","properties":{"pattern":{"type":"string","description":"Glob pattern, e.g. src/**/*.tsx"}},"required":["pattern"]}}},
    {"type":"function","function":{"name":"grep","description":"Search file contents with regex.","parameters":{"type":"object","properties":{"pattern":{"type":"string"},"include":{"type":"string","description":"Optional glob to filter files"}},"required":["pattern"]}}},
    {"type":"function","function":{"name":"todowrite","description":"Track progress on multi-step tasks.","parameters":{"type":"object","properties":{"todos":{"type":"array","items":{"type":"object","properties":{"content":{"type":"string"},"status":{"type":"string","enum":["pending","in_progress","completed","cancelled"]},"priority":{"type":"string","enum":["high","medium","low"]}},"required":["content","status","priority"]}}},"required":["todos"]}}}
  ])
}

fn anthropic_tools() -> Value {
  agent_tools().as_array().unwrap().iter().map(|t| {
    let f = &t["function"];
    json!({"name": f["name"], "description": f["description"], "input_schema": f["parameters"]})
  }).collect::<Vec<_>>().into()
}

fn gemini_tools() -> Value {
  let declarations = agent_tools().as_array().unwrap().iter().map(|t| {
    let f = &t["function"];
    json!({"name": f["name"], "description": f["description"], "parameters": f["parameters"]})
  }).collect::<Vec<_>>();
  json!([{"functionDeclarations": declarations}])
}

fn gemini_contents(messages: &[Message]) -> Vec<Value> {
  let mut tool_names = HashMap::new();
  for message in messages {
    if let Some(calls) = &message.tool_calls {
      for call in calls { tool_names.insert(call.id.clone(), call.name.clone()); }
    }
  }
  let contents: Vec<Value> = messages.iter().filter(|m| m.role != "system").map(|m| {
    if m.role == "tool" {
      let name = m.name.clone().or_else(|| m.tool_call_id.as_ref().and_then(|id| tool_names.get(id).cloned())).unwrap_or_else(|| "tool".into());
      json!({"role":"user","parts":[{"functionResponse":{"name":name,"response":{"output":m.content}}}]})
    } else if let Some(calls) = &m.tool_calls {
      let mut parts = Vec::new();
      if !m.content.is_empty() { parts.push(json!({"text":m.content})); }
      parts.extend(calls.iter().map(|call| {
        let mut part = json!({"functionCall":{"name":call.name,"args":call.arguments}});
        if let Some(signature) = &call.thought_signature { part["thoughtSignature"] = json!(signature); }
        part
      }));
      json!({"role":"model","parts":parts})
    } else {
      json!({"role": if m.role == "assistant" {"model"} else {"user"}, "parts":[{"text":m.content}]})
    }
  }).collect();
  let mut out: Vec<Value> = Vec::new();
  for item in contents {
    if let Some(previous) = out.last_mut() {
      if previous["role"] == item["role"] {
        previous["parts"].as_array_mut().unwrap().extend(item["parts"].as_array().unwrap().iter().cloned());
        continue;
      }
    }
    out.push(item);
  }
  out
}

fn anthropic_messages(messages: &[Message]) -> Vec<Value> {
  let mut out: Vec<Value> = Vec::new();
  for message in messages.iter().filter(|m| m.role != "system") {
    let (role, mut blocks) = if message.role == "tool" {
      ("user", vec![json!({"type":"tool_result","tool_use_id":message.tool_call_id.clone().unwrap_or_default(),"content":message.content})])
    } else if let Some(calls) = &message.tool_calls {
      let mut content = Vec::new();
      if !message.content.is_empty() { content.push(json!({"type":"text","text":message.content})); }
      content.extend(calls.iter().map(|call| json!({"type":"tool_use","id":call.id,"name":call.name,"input":call.arguments})));
      ("assistant", content)
    } else {
      (if message.role == "assistant" { "assistant" } else { "user" }, vec![json!({"type":"text","text":message.content})])
    };
    if let Some(previous) = out.last_mut() {
      if previous["role"].as_str() == Some(role) {
        if let Some(content) = previous["content"].as_array_mut() { content.append(&mut blocks); continue; }
      }
    }
    out.push(json!({"role":role,"content":blocks}));
  }
  out
}

#[tauri::command]
fn run_shell_command(root: Option<String>, command: String) -> Result<String, String> {
  if command.trim().is_empty() { return Err("Enter a command to run.".into()); }
  let cwd = root.unwrap_or_else(|| std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| ".".into()));
  let mut process = runtime::shell_command(&command);
  let mut child = process.current_dir(&cwd).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("Could not run the command: {e}"))?;
  let mut stdout = child.stdout.take().ok_or("Could not capture command output")?;
  let mut stderr = child.stderr.take().ok_or("Could not capture command errors")?;
  let stdout_reader = std::thread::spawn(move || { let mut data = Vec::new(); let _ = stdout.read_to_end(&mut data); data });
  let stderr_reader = std::thread::spawn(move || { let mut data = Vec::new(); let _ = stderr.read_to_end(&mut data); data });
  let (status, timed_out) = match child.wait_timeout(Duration::from_secs(30)).map_err(|e| e.to_string())? {
    Some(status) => (status, false),
    None => { let _ = child.kill(); (child.wait().map_err(|e| e.to_string())?, true) }
  };
  let stdout = stdout_reader.join().unwrap_or_default();
  let stderr = stderr_reader.join().unwrap_or_default();
  let mut result = String::from_utf8_lossy(&stdout).into_owned();
  let stderr = String::from_utf8_lossy(&stderr);
  if !stderr.trim().is_empty() { result.push_str(if result.is_empty() {"[stderr]\n"} else {"\n[stderr]\n"}); result.push_str(&stderr); }
  result.push_str(runtime::missing_node_hint(&stderr));
  if timed_out { result.push_str(if result.is_empty() {"[command timed out after 30s]"} else {"\n[command timed out after 30s]"}); }
  else if !status.success() { result.push_str(&format!("{}[exit code {}]", if result.is_empty() {""} else {"\n"}, status.code().unwrap_or(1))); }
  Ok(result.chars().take(24000).collect())
}

#[derive(Debug, Deserialize)]
struct OllamaModel { name: String, size: Option<u64>, modified_at: Option<String> }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalModel { name: String, size: Option<u64>, modified_at: Option<String> }

fn ollama_endpoint(endpoint: &Option<String>) -> String {
  endpoint.clone().unwrap_or_else(|| "http://127.0.0.1:11434".into()).trim_end_matches('/').to_string()
}

#[tauri::command]
async fn list_local_models(endpoint: Option<String>) -> Result<Vec<LocalModel>, String> {
  let response = Client::new().get(format!("{}/api/tags", ollama_endpoint(&endpoint)))
    .send().await.map_err(|e| format!("Could not contact Ollama at {}: {e}. Is Ollama installed and running? Try: ollama serve", ollama_endpoint(&endpoint)))?;
  let status = response.status();
  let text = response.text().await.map_err(|e| e.to_string())?;
  if !status.is_success() {
    if let Ok(data) = serde_json::from_str::<Value>(&text) {
      if let Some(err) = data["error"].as_str() { return Err(err.to_string()); }
    }
    return Err(if text.trim().is_empty() { "Could not read the Ollama model list".to_string() } else { text.trim().to_string() });
  }
  let data: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
  Ok(data["models"].as_array().unwrap_or(&Vec::new()).iter().filter_map(|item| {
    serde_json::from_value::<OllamaModel>(item.clone()).ok().map(|model| LocalModel { name: model.name, size: model.size, modified_at: model.modified_at })
  }).collect())
}

fn provider_model_endpoint(provider: &str) -> Option<(String, &'static str)> {
  match provider {
    "openai" => Some(("https://api.openai.com/v1/models".into(), "OPENAI_API_KEY")),
    "anthropic" => Some(("https://api.anthropic.com/v1/models?limit=1000".into(), "ANTHROPIC_API_KEY")),
    "gemini" => Some(("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000".into(), "GEMINI_API_KEY")),
    _ => compat_provider(provider).map(|(base, env)| (format!("{base}/models"), env)),
  }
}

fn normalize_provider_models(provider: &str, data: &Value) -> Vec<Value> {
  let source = data.as_array().cloned()
    .or_else(|| data["data"].as_array().cloned())
    .or_else(|| data["models"].as_array().cloned())
    .or_else(|| data["items"].as_array().cloned())
    .unwrap_or_default();
  let mut seen = HashSet::new();
  source.into_iter().filter_map(|model| {
    if provider == "gemini" {
      if let Some(methods) = model["supportedGenerationMethods"].as_array() {
        if !methods.iter().any(|method| method.as_str() == Some("generateContent")) { return None; }
      }
    }
    if provider == "together" {
      if let Some(kind) = model["type"].as_str() {
        if !matches!(kind, "chat" | "language" | "code") { return None; }
      }
    }
    if provider == "mistral" && model["capabilities"]["completion_chat"].as_bool() == Some(false) { return None; }
    let raw_id = model["id"].as_str().or_else(|| model["name"].as_str()).unwrap_or("");
    let id = if provider == "gemini" { raw_id.trim_start_matches("models/") } else { raw_id }.to_string();
    let lowered = id.to_ascii_lowercase();
    if id.is_empty() || ["embedding", "rerank", "moderation", "whisper", "transcri", "speech", "tts", "dall-e", "image", "sora"].iter().any(|part| lowered.contains(part)) || !seen.insert(id.clone()) { return None; }
    let display = model["displayName"].as_str().or_else(|| model["display_name"].as_str()).or_else(|| if provider == "gemini" { model["baseModelId"].as_str() } else { None }).or_else(|| model["name"].as_str()).unwrap_or(&id).trim_start_matches("models/");
    Some(json!({"id":id,"name":display,"pricing":model["pricing"],"context_length":model["context_length"].as_u64().or_else(|| model["contextLength"].as_u64()).or_else(|| model["inputTokenLimit"].as_u64()),"created":model["created"]}))
  }).collect()
}

#[tauri::command]
async fn list_provider_models(provider: String, api_key: String) -> Result<Vec<Value>, String> {
  let (url, env) = provider_model_endpoint(&provider).ok_or_else(|| format!("Unknown cloud provider: {provider}"))?;
  let key = if api_key.trim().is_empty() { std::env::var(env).unwrap_or_default() } else { api_key.trim().to_string() };
  if key.is_empty() { return Err(format!("{} API key required. Paste it in settings.", provider)); }
  let client = Client::new();
  let mut request = if provider == "gemini" {
    client.get(&url).query(&[("key", key.as_str())])
  } else if provider == "anthropic" {
    client.get(&url).header("x-api-key", &key).header("anthropic-version", "2023-06-01")
  } else {
    client.get(&url).header("Authorization", format!("Bearer {key}"))
  };
  if provider == "openrouter" { request = request.header("HTTP-Referer", "http://localhost:4173").header("X-Title", "CodePlus"); }
  let response = request.send().await.map_err(|e| e.to_string())?;
  let status = response.status();
  let text = response.text().await.map_err(|e| e.to_string())?;
  let data: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
  if !status.is_success() {
    return Err(data["error"]["message"].as_str().or_else(|| data["error"].as_str()).or_else(|| data["message"].as_str()).unwrap_or_else(|| if text.trim().is_empty() { "Could not fetch provider models" } else { text.trim() }).chars().take(500).collect());
  }
  Ok(normalize_provider_models(&provider, &data))
}

#[tauri::command]
async fn pull_local_model(window: tauri::Window, endpoint: Option<String>, model: String) -> Result<(), String> {
  if model.is_empty() || model.len() > 160 || !model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '-')) { return Err("Choose a valid Ollama model name".into()); }
  let response = Client::new().post(format!("{}/api/pull", ollama_endpoint(&endpoint)))
    .json(&json!({"model": &model, "stream": true})).send().await.map_err(|e| format!("Could not contact Ollama at {}: {e}", ollama_endpoint(&endpoint)))?;
  let status = response.status();
  if !status.is_success() {
    let text = response.text().await.unwrap_or_default();
    if let Ok(data) = serde_json::from_str::<Value>(&text) {
      if let Some(err) = data["error"].as_str() { return Err(err.to_string()); }
    }
    return Err(if text.trim().is_empty() { "Could not download the Ollama model".to_string() } else { text.trim().to_string() });
  }
  let mut stream = response.bytes_stream();
  let mut buffer = String::new();
  while let Some(chunk) = stream.next().await {
    buffer.push_str(&String::from_utf8_lossy(&chunk.map_err(|e| format!("Could not read Ollama progress: {e}"))?));
    while let Some(end) = buffer.find(char::from(10)) {
      let line = buffer.drain(..=end).collect::<String>();
      let line = line.trim();
      if line.is_empty() { continue; }
      let mut data: Value = serde_json::from_str(line).map_err(|e| format!("Could not read Ollama progress: {e}"))?;
      if let Some(error) = data["error"].as_str() { return Err(error.to_string()); }
      if let Some(progress) = data.as_object_mut() { progress.insert("model".into(), Value::String(model.clone())); }
      window.emit("ollama-pull-progress", &data).map_err(|e| e.to_string())?;
    }
  }
  let line = buffer.trim();
  if !line.is_empty() {
    let mut data: Value = serde_json::from_str(line).map_err(|e| format!("Could not read Ollama progress: {e}"))?;
    if let Some(error) = data["error"].as_str() { return Err(error.to_string()); }
    if let Some(progress) = data.as_object_mut() { progress.insert("model".into(), Value::String(model.clone())); }
    window.emit("ollama-pull-progress", &data).map_err(|e| e.to_string())?;
  }
  Ok(())
}

#[tauri::command]
async fn delete_local_model(endpoint: Option<String>, model: String) -> Result<(), String> {
  if model.is_empty() || model.len() > 160 || !model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '-')) { return Err("Choose a valid Ollama model name".into()); }
  let response = Client::new().delete(format!("{}/api/delete", ollama_endpoint(&endpoint)))
    .json(&json!({"model": model, "name": model})).send().await.map_err(|e| format!("Could not contact Ollama at {}: {e}", ollama_endpoint(&endpoint)))?;
  let status = response.status();
  if status.is_success() { return Ok(()); }
  let text = response.text().await.unwrap_or_default();
  if let Ok(data) = serde_json::from_str::<Value>(&text) {
    if let Some(err) = data["error"].as_str() { return Err(err.to_string()); }
  }
  Err(if text.trim().is_empty() { format!("Could not delete {model}: {}", status) } else { text.trim().to_string() })
}

fn workspace_ignored(name: &str) -> bool {
  matches!(name, "node_modules" | ".git" | ".codeplus" | ".next" | ".nuxt" | "dist" | "build" | "target" | "venv" | ".venv" | "__pycache__" | ".DS_Store")
}

fn workspace_text_file(name: &str) -> bool {
  const DENY: [&str; 45] = ["png","jpg","jpeg","gif","webp","avif","ico","icns","pdf","zip","gz","tgz","bz2","xz","7z","rar","dmg","iso","exe","msi","dll","so","dylib","bin","o","a","class","jar","war","woff","woff2","ttf","otf","eot","mp3","wav","ogg","mp4","webm","mov","avi","mkv","sqlite","db","pdb"];
  match name.rsplit_once('.') {
    Some((_, ext)) if !ext.is_empty() => !DENY.contains(&ext.to_ascii_lowercase().as_str()),
    _ => true,
  }
}

fn workspace_join(root: &str, relative: &str) -> Result<PathBuf, String> {
  let rel = Path::new(relative);
  if relative.is_empty() || rel.is_absolute() || rel.components().any(|part| !matches!(part, Component::Normal(_))) {
    return Err("Invalid workspace path. Use a relative path inside the open project.".into());
  }
  let base = std::fs::canonicalize(root).map_err(|e| format!("Could not open workspace: {e}"))?;
  let target = base.join(rel);
  let mut probe = target.clone();
  while !probe.exists() && probe != base { probe.pop(); }
  let canonical_probe = std::fs::canonicalize(&probe).map_err(|e| e.to_string())?;
  if canonical_probe != base && !canonical_probe.starts_with(&base) { return Err("Workspace path resolves outside the open project.".into()); }
  Ok(target)
}

#[tauri::command]
fn pick_workspace_folder() -> Result<Option<String>, String> {
  Ok(rfd::FileDialog::new().set_title("Choose a project folder").pick_folder().map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn list_workspace_tree(root: String) -> Result<Vec<String>, String> {
  fn walk(dir: &std::path::Path, base: &std::path::Path, out: &mut Vec<String>, depth: usize) {
    if depth > 10 || out.len() > 8000 { return; }
    let entries = match std::fs::read_dir(dir) { Ok(entries) => entries, Err(_) => return };
    let mut items: Vec<_> = entries.filter_map(|entry| entry.ok()).collect();
    items.sort_by_key(|item| item.path());
    for item in items {
      let name = item.file_name().to_string_lossy().into_owned();
      if workspace_ignored(&name) { continue; }
      let path = item.path();
      let file_type = match item.file_type() { Ok(kind) => kind, Err(_) => continue };
      if file_type.is_symlink() { continue; }
      if file_type.is_dir() { walk(&path, base, out, depth + 1); }
      else if file_type.is_file() && workspace_text_file(&name) {
        if let Ok(rel) = path.strip_prefix(base) { out.push(rel.to_string_lossy().replace('\\', "/")); }
      }
    }
  }
  let base = std::fs::canonicalize(&root).map_err(|e| format!("Could not open workspace: {e}"))?;
  let mut out = Vec::new();
  walk(&base, &base, &mut out, 0);
  out.sort();
  Ok(out)
}

#[tauri::command]
fn read_workspace_file(root: String, relative: String) -> Result<String, String> {
  std::fs::read_to_string(workspace_join(&root, &relative)?).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_workspace_file(root: String, relative: String, content: String) -> Result<(), String> {
  let path = workspace_join(&root, &relative)?;
  if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
  std::fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_workspace_dir(parent: String, name: String) -> Result<String, String> {
  let path = workspace_join(&parent, &name)?;
  std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
  Ok(path.to_string_lossy().into_owned())
}

fn detect_dev_port(abs: &std::path::Path, pkg_text: &str) -> u16 {
  if let Ok(pkg) = serde_json::from_str::<Value>(pkg_text) {
    if let Some(script) = pkg.get("scripts").and_then(|s| s.get("dev")).and_then(|d| d.as_str()) {
      let tokens: Vec<&str> = script.split_whitespace().collect();
      for (i, token) in tokens.iter().enumerate() {
        let candidate = if *token == "-p" || *token == "--port" {
          tokens.get(i + 1).map(|s| s.to_string())
        } else if let Some(v) = token.strip_prefix("--port=") {
          Some(v.to_string())
        } else if let Some(v) = token.strip_prefix("-p") {
          Some(v.to_string())
        } else { None };
        if let Some(v) = candidate {
          if let Ok(p) = v.parse::<u16>() { if p > 0 { return p; } }
        }
      }
    }
  }
  if pkg_text.contains("vite") || abs.join("vite.config.js").exists() || abs.join("vite.config.ts").exists() { 5173 } else { 3000 }
}

async fn probe_port(client: &Client, port: u16) -> bool {
  if let Ok(resp) = client.head(format!("http://127.0.0.1:{port}/")).send().await {
    let s = resp.status().as_u16();
    return (200..500).contains(&s);
  }
  false
}

fn kill_port(port: u16) {
  #[cfg(unix)] { let _ = Command::new("sh").args(["-c", &format!("lsof -ti:{port} 2>/dev/null | xargs kill -9 2>/dev/null || true")]).output(); }
  #[cfg(windows)] { let _ = Command::new("cmd").args(["/C", &format!("for /f \"tokens=5\" %a in ('netstat -aon ^| findstr :{port}') do taskkill /PID %a /F 2>nul")]).output(); }
}

fn read_tail<R: std::io::Read>(mut stream: R, tail: std::sync::Arc<Mutex<String>>) {
  let mut buf = [0u8; 4096];
  loop {
    match <R as std::io::Read>::read(&mut stream, &mut buf) {
      Ok(0) | Err(_) => break,
      Ok(n) => {
        if let Ok(mut t) = tail.lock() {
          t.push_str(&String::from_utf8_lossy(&buf[..n]));
          let len = t.len();
          if len > 4000 { t.drain(..len - 4000); }
        }
      }
    }
  }
}

fn tail_output(tail: &std::sync::Arc<Mutex<String>>) -> String {
  let text = tail.lock().map(|t| t.clone()).unwrap_or_default();
  let count = text.chars().count();
  if count <= 1500 { text } else { text.chars().skip(count - 1500).collect() }
}

#[tauri::command]
async fn start_dev_server(root: String) -> Result<String, String> {
  let abs = std::path::PathBuf::from(&root);
  if !abs.is_dir() { return Err(format!("Project folder not found: {}", root)); }
  let pkg_path = abs.join("package.json");
  if !pkg_path.exists() { return Err("No package.json in this project".into()); }
  let pkg_text = std::fs::read_to_string(&pkg_path).map_err(|e| e.to_string())?;
  let pkg: Value = serde_json::from_str(&pkg_text).map_err(|e| e.to_string())?;
  if pkg.get("scripts").and_then(|s| s.get("dev")).is_none() { return Err("No \"dev\" script in package.json".into()); }
  let port = detect_dev_port(&abs, &pkg_text);
  let url = format!("http://localhost:{}/", port);
  let client = Client::builder().timeout(std::time::Duration::from_millis(1200)).build().map_err(|e| e.to_string())?;
  // already tracked & alive → wait until it actually answers
  let tracked_alive = {
    let mut map = dev_servers().lock().map_err(|_| "Dev server lock failed".to_string())?;
    match map.get_mut(&root) {
      Some(child) => match child.try_wait() {
        Ok(None) => true,
        _ => { map.remove(&root); false }
      },
      None => false
    }
  };
  if tracked_alive {
    for _ in 0..60 {
      if probe_port(&client, port).await { return Ok(url); }
      tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    return Ok(url);
  }
  // adopt a dev server that is already listening on the project port
  if probe_port(&client, port).await { return Ok(url); }
  // clear stale listeners on the exact port so the dev server can bind
  kill_port(port);
  tokio::time::sleep(std::time::Duration::from_millis(400)).await;
  // auto-install if node_modules missing
  if !abs.join("node_modules").exists() {
    let out = runtime::shell_command("npm install").current_dir(&abs).output()
      .map_err(|e| format!("Failed to run npm install: {e} — is npm installed?"))?;
    if !out.status.success() {
      let stderr = String::from_utf8_lossy(&out.stderr);
      return Err(format!("npm install failed — {}{}", stderr.trim(), runtime::missing_node_hint(&stderr)));
    }
  }
  let mut cmd = runtime::shell_command(if cfg!(windows) { "npm run dev" } else { "exec npm run dev" });
  #[cfg(unix)] { cmd.process_group(0); }
  cmd.current_dir(&abs).env("PORT", port.to_string()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
  let mut child = cmd.spawn()
    .map_err(|e| format!("Failed to start dev server: {e}. Is npm installed? Try installing Node.js from https://nodejs.org"))?;
  let tail = std::sync::Arc::new(Mutex::new(String::new()));
  if let Some(out) = child.stdout.take() { let tail = tail.clone(); std::thread::spawn(move || read_tail(out, tail)); }
  if let Some(err) = child.stderr.take() { let tail = tail.clone(); std::thread::spawn(move || read_tail(err, tail)); }
  dev_servers().lock().map_err(|_| "lock failed".to_string())?.insert(root.clone(), child);
  // wait until the dev server actually accepts connections (up to 90s)
  let started = std::time::Instant::now();
  loop {
    {
      let mut map = dev_servers().lock().map_err(|_| "lock failed".to_string())?;
      match map.get_mut(&root) {
        Some(child) => {
          if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            map.remove(&root);
            return Err(format!("Dev server exited immediately — last output:\n{}", tail_output(&tail)));
          }
        }
        None => return Err("Dev server exited immediately.".into())
      }
    }
    if probe_port(&client, port).await { return Ok(url); }
    if started.elapsed() > std::time::Duration::from_secs(90) {
      if let Some(mut child) = dev_servers().lock().map_err(|_| "lock failed".to_string())?.remove(&root) { let _ = child.kill(); }
      return Err(format!("Dev server did not become ready within 90s — last output:\n{}", tail_output(&tail)));
    }
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
  }
}

#[tauri::command]
fn stop_dev_server(root: String) -> Result<(), String> {
  let targets: Vec<String> = if root.is_empty() { dev_servers().lock().map_err(|_| "lock failed".to_string())?.keys().cloned().collect() } else { vec![root.clone()] };
  {
    let mut map = dev_servers().lock().map_err(|_| "lock failed".to_string())?;
    for key in &targets {
      if let Some(mut child) = map.remove(key) {
        #[cfg(unix)] {
          // try to kill the whole process group (npm -> dev server)
          let pid = child.id();
          let _ = child.kill();
          let _ = std::process::Command::new("sh").args(["-c", &format!("kill -TERM -{pid} 2>/dev/null; kill -KILL -{pid} 2>/dev/null")]).output();
        }
        #[cfg(windows)] { let _ = child.kill(); }
      }
    }
  }
  // also kill the project's own dev port (e.g. `next dev -p 9002`) — covers adopted servers
  if !root.is_empty() {
    let abs = std::path::PathBuf::from(&root);
    if let Ok(pkg_text) = std::fs::read_to_string(abs.join("package.json")) {
      kill_port(detect_dev_port(&abs, &pkg_text));
    }
  }
  // also kill anything still listening on default dev ports (covers manually started terminals)
  #[cfg(unix)] { let _ = std::process::Command::new("sh").args(["-c", "lsof -ti:3000,5173 2>/dev/null | xargs kill -9 2>/dev/null || true"]).output(); }
  #[cfg(windows)] { let _ = std::process::Command::new("cmd").args(["/C", "for /f \"tokens=5\" %a in ('netstat -aon ^| findstr :3000') do taskkill /PID %a /F 2>nul & for /f \"tokens=5\" %a in ('netstat -aon ^| findstr :5173') do taskkill /PID %a /F 2>nul"]).output(); }
  Ok(())
}

#[tauri::command]
async fn dev_server_status(root: String) -> Result<bool, String> {
  {
    let mut map = dev_servers().lock().map_err(|_| "lock failed".to_string())?;
    if let Some(child) = map.get_mut(&root) {
      match child.try_wait() {
        Ok(None) => return Ok(true),
        Ok(Some(_)) => { map.remove(&root); },
        Err(_) => { map.remove(&root); }
      }
    }
  }
  // also detect a dev server started manually in a terminal (project port first)
  let client = Client::builder().timeout(std::time::Duration::from_millis(900)).build().map_err(|e| e.to_string())?;
  let mut ports = vec![3000u16, 5173];
  if let Ok(pkg_text) = std::fs::read_to_string(std::path::PathBuf::from(&root).join("package.json")) {
    let detected = detect_dev_port(&std::path::PathBuf::from(&root), &pkg_text);
    ports.insert(0, detected);
  }
  for port in ports {
    if probe_port(&client, port).await { return Ok(true); }
  }
  Ok(false)
}

#[tauri::command]
fn start_vscode_web(accept_license: bool) -> Result<String, String> {
  if !accept_license { return Err("Accept the VS Code Server license terms to continue.".into()); }
  let root = std::env::current_dir().map_err(|e| e.to_string())?;
  let args = ["serve-web", "--host", "127.0.0.1", "--port", "8765", "--without-connection-token", "--accept-server-license-terms", "--disable-telemetry", "--default-folder"];
  let code_cli = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
  let spawned = if cfg!(windows) {
    // The Windows CLI is code.cmd, which CreateProcess cannot execute directly.
    Command::new("cmd").arg("/C").arg("code").args(args).arg(&root).spawn()
  } else if std::path::Path::new(code_cli).exists() {
    Command::new(code_cli).args(args).arg(&root).spawn()
  } else {
    Command::new("code").args(args).arg(&root).spawn()
  };
  spawned.map(|_| "http://127.0.0.1:8765/".into()).map_err(|_| "VS Code was not found. Install Visual Studio Code, then enable its “code” command in PATH.".into())
}

fn compat_provider(provider: &str) -> Option<(&'static str, &'static str)> {
  match provider {
    "groq" => Some(("https://api.groq.com/openai/v1", "GROQ_API_KEY")),
    "deepseek" => Some(("https://api.deepseek.com/v1", "DEEPSEEK_API_KEY")),
    "mistral" => Some(("https://api.mistral.ai/v1", "MISTRAL_API_KEY")),
    "xai" => Some(("https://api.x.ai/v1", "XAI_API_KEY")),
    "openrouter" => Some(("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY")),
    "together" => Some(("https://api.together.xyz/v1", "TOGETHER_API_KEY")),
    "fireworks" => Some(("https://api.fireworks.ai/inference/v1", "FIREWORKS_API_KEY")),
    "cerebras" => Some(("https://api.cerebras.ai/v1", "CEREBRAS_API_KEY")),
    _ => None,
  }
}

fn to_openai_messages(messages: &[Message]) -> Vec<Value> {
  messages.iter().map(|m| {
    if m.role == "tool" {
      json!({"role":"tool","tool_call_id": m.tool_call_id.clone().unwrap_or_default(),"content": m.content})
    } else if let Some(tcs) = &m.tool_calls {
      json!({"role": m.role, "content": m.content, "tool_calls": tcs.iter().map(|tc| json!({"id": tc.id, "type":"function","function":{"name": tc.name, "arguments": serde_json::to_string(&tc.arguments).unwrap_or_else(|_| "{}".into())}})).collect::<Vec<_>>()})
    } else {
      json!({"role": m.role, "content": m.content})
    }
  }).collect()
}

fn to_ollama_messages(messages: &[Message]) -> Vec<Value> {
  messages.iter().map(|m| {
    if m.role == "tool" {
      let name = m.name.clone().or_else(|| messages.iter().filter_map(|m| m.tool_calls.as_ref()).flatten().find(|tc| Some(&tc.id) == m.tool_call_id.as_ref()).map(|tc| tc.name.clone()));
      json!({"role":"tool","content": m.content,"tool_name":name})
    } else if let Some(tcs) = &m.tool_calls {
      json!({"role": m.role, "content": m.content, "tool_calls": tcs.iter().map(|tc| json!({"function":{"name": tc.name, "arguments": tc.arguments}})).collect::<Vec<_>>()})
    } else {
      json!({"role": m.role, "content": m.content})
    }
  }).collect()
}
fn fix_model(provider: &str, model: &str) -> String {
  if provider == "openrouter" && (model == "openrouter/free" || model == "openrouter") {
    return "qwen/qwen3-coder:free".to_string();
  }
  if provider == "gemini" && (model == "gemini-2.5-flash" || model == "models/gemini-2.5-flash") {
    return "gemini-3.6-flash".to_string();
  }
  model.to_string()
}

async fn chat_completions(client: &Client, provider: &str, base: &str, key: &str, model: &str, messages: &[Message], tools_enabled: bool, require_tool: bool) -> Result<AskResponse, String> {
  let model = if model == "openrouter/free" || model == "openrouter" { "qwen/qwen3-coder:free" } else { model };
  let openai_messages = to_openai_messages(messages);
  let mut body = json!({"model": model, "messages": openai_messages});
  if tools_enabled {
    body["tools"] = agent_tools();
    body["tool_choice"] = json!(if require_tool { "required" } else { "auto" });
  }
  let mut request = client.post(format!("{}/chat/completions", base.trim_end_matches('/'))).json(&body);
  if !key.is_empty() { request = request.bearer_auth(key); }
  let response = request.send().await.map_err(network_error)?;
  let data = model_response(response, provider).await?;
  let msg = &data["choices"][0]["message"];
  if let Some(tcs) = msg["tool_calls"].as_array() {
    let tool_calls = tcs.iter().filter_map(|tc| {
      let id = tc["id"].as_str().unwrap_or("").to_string();
      let name = tc["function"]["name"].as_str()?.to_string();
      let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
      let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));
      Some(ToolCall { thought_signature: None, id: if id.is_empty() { format!("call_{}", rand_id()) } else { id }, name, arguments: normalize_tool_args(args) })
    }).collect::<Vec<_>>();
    if !tool_calls.is_empty() {
      return Ok(AskResponse { content: msg["content"].as_str().unwrap_or("").to_string(), tool_calls: Some(tool_calls) });
    }
  }
  if let Some(fb) = parse_tool_calls_fallback(msg["content"].as_str().unwrap_or("")) {
    return Ok(AskResponse { content: "".into(), tool_calls: Some(fb) });
  }
  let content = msg["content"].as_str().unwrap_or("");
  if content.trim().is_empty() { return Err(format!("The model returned no answer (finish reason: {}). Retry or select another model.", data["choices"][0]["finish_reason"].as_str().unwrap_or("empty response"))); }
  Ok(AskResponse { content: content.to_string(), tool_calls: None })
}

fn normalize_tool_args(v: Value) -> Value {
  if let Value::Object(map) = v {
    let mut out = serde_json::Map::new();
    for (k, val) in map {
      if let Value::Object(inner) = &val {
        if inner.contains_key("content") && inner.contains_key("type") {
          if let Some(Value::String(s)) = inner.get("content") { out.insert(k, Value::String(s.clone())); continue; }
        }
      }
      out.insert(k, val);
    }
    return Value::Object(out);
  }
  v
}
fn extract_all_tool_calls(s: &str) -> Vec<ToolCall> {
  let mut out = Vec::new();
  let mut idx = 0;
  let bytes = s.as_bytes();
  while let Some(rel) = s[idx..].find("{\"name\"") {
    let start = idx + rel;
    let mut depth: i32 = 0;
    let mut in_str = false;
    let mut esc = false;
    let mut end: Option<usize> = None;
    for i in start..s.len() {
      let ch = bytes[i] as char;
      if in_str {
        if esc { esc = false; } else if ch == '\\' { esc = true; } else if ch == '"' { in_str = false; }
      } else {
        if ch == '"' { in_str = true; } else if ch == '{' { depth += 1; } else if ch == '}' {
          depth -= 1;
          if depth == 0 { end = Some(i); break; }
        }
      }
    }
    if let Some(e) = end {
      let slice = &s[start..=e];
      if let Ok(obj) = serde_json::from_str::<Value>(slice) {
        if let (Some(name), Some(args)) = (obj.get("name").and_then(|v| v.as_str()), obj.get("arguments")) {
          out.push(ToolCall { thought_signature: None, id: rand_id(), name: name.to_string(), arguments: normalize_tool_args(args.clone()) });
        }
      }
      idx = e + 1;
    } else { break; }
  }
  out
}
fn parse_tool_calls_fallback(content: &str) -> Option<Vec<ToolCall>> {
  if content.is_empty() { return None; }
  // 1. all <tool_call> blocks
  if content.contains("<tool_call>") {
    let mut calls = Vec::new();
    let mut rest = content;
    while let Some(s) = rest.find("<tool_call>") {
      if let Some(e) = rest.find("</tool_call>") {
        let inner = &rest[s + "<tool_call>".len()..e];
        if let Ok(obj) = serde_json::from_str::<Value>(inner.trim()) {
          if let (Some(name), Some(args)) = (obj.get("name").and_then(|v| v.as_str()), obj.get("arguments")) {
            calls.push(ToolCall { thought_signature: None, id: rand_id(), name: name.to_string(), arguments: normalize_tool_args(args.clone()) });
          } else if let Some(arr) = obj.as_array() {
            for item in arr { if let (Some(n), Some(a)) = (item.get("name").and_then(|v| v.as_str()), item.get("arguments")) { calls.push(ToolCall { thought_signature: None, id: rand_id(), name: n.to_string(), arguments: normalize_tool_args(a.clone()) }); } }
          }
        } else {
          let extracted = extract_all_tool_calls(inner);
          calls.extend(extracted);
        }
        rest = &rest[e + "</tool_call>".len()..];
      } else { break; }
    }
    if !calls.is_empty() { return Some(calls); }
  }
  // 2. all ``` code blocks
  if content.contains("```") {
    let mut calls = Vec::new();
    let mut rest = content;
    while let Some(s) = rest.find("```") {
      let after = &rest[s + 3..];
      if let Some(e) = after.find("```") {
        let inner = after[..e].trim().trim_start_matches("json").trim();
        if !inner.is_empty() {
          if let Ok(obj) = serde_json::from_str::<Value>(inner) {
            if let (Some(name), Some(args)) = (obj.get("name").and_then(|v| v.as_str()), obj.get("arguments")) {
              calls.push(ToolCall { thought_signature: None, id: rand_id(), name: name.to_string(), arguments: normalize_tool_args(args.clone()) });
            } else if let Some(arr) = obj.as_array() {
              for item in arr { if let (Some(n), Some(a)) = (item.get("name").and_then(|v| v.as_str()), item.get("arguments")) { calls.push(ToolCall { thought_signature: None, id: rand_id(), name: n.to_string(), arguments: normalize_tool_args(a.clone()) }); } }
            } else {
              let ex = extract_all_tool_calls(inner);
              calls.extend(ex);
            }
          } else {
            let ex = extract_all_tool_calls(inner);
            calls.extend(ex);
          }
        }
        rest = &after[e + 3..];
      } else { break; }
    }
    if !calls.is_empty() { return Some(calls); }
  }
  // 3. raw content: extract all {"name":...} objects
  let raw = extract_all_tool_calls(content);
  if !raw.is_empty() { return Some(raw); }
  // 4. whole content as JSON
  if let Ok(obj) = serde_json::from_str::<Value>(content.trim()) {
    if let (Some(name), Some(args)) = (obj.get("name").and_then(|v| v.as_str()), obj.get("arguments")) {
      return Some(vec![ToolCall { thought_signature: None, id: rand_id(), name: name.to_string(), arguments: normalize_tool_args(args.clone()) }]);
    }
    if let Some(arr) = obj.as_array() {
      let mut out = Vec::new();
      for item in arr { if let (Some(n), Some(a)) = (item.get("name").and_then(|v| v.as_str()), item.get("arguments")) { out.push(ToolCall { thought_signature: None, id: rand_id(), name: n.to_string(), arguments: normalize_tool_args(a.clone()) }); } }
      if !out.is_empty() { return Some(out); }
    }
  }
  None
}
fn rand_id() -> String { use std::time::{SystemTime, UNIX_EPOCH}; format!("{:x}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos() & 0xffffff) }

fn ollama_body(model: &str, messages: &[Message], tools_enabled: bool) -> Value {
  let family = model.rsplit('/').next().unwrap_or(model).to_ascii_lowercase();
  let think = if family == "gpt-oss" || family.starts_with("gpt-oss:") || family.starts_with("gpt-oss-") { json!(if tools_enabled { "medium" } else { "low" }) } else { json!(false) };
  let mut body = json!({"model":model,"messages":to_ollama_messages(messages),"stream":false,"think":think,"options":{"num_ctx":16384,"num_predict":8192}});
  if tools_enabled { body["tools"] = agent_tools(); }
  body
}

fn parse_ollama_reply(data: &Value) -> Result<Option<AskResponse>, String> {
  let msg = &data["message"];
  let content = msg["content"].as_str().unwrap_or("");
  let mut calls = Vec::new();
  for tc in msg["tool_calls"].as_array().into_iter().flatten() {
    if let Some(name) = tc["function"]["name"].as_str() {
      let args = &tc["function"]["arguments"];
      let args = if let Some(text) = args.as_str() { serde_json::from_str(text).map_err(|_| "Ollama returned invalid tool arguments. Retry the request.")? } else { args.clone() };
      calls.push(ToolCall { id: tc["id"].as_str().map(str::to_string).unwrap_or_else(rand_id), name: name.into(), arguments: normalize_tool_args(args), thought_signature: None });
    }
  }
  if !calls.is_empty() { return Ok(Some(AskResponse { content: content.into(), tool_calls: Some(calls) })); }
  if let Some(calls) = parse_tool_calls_fallback(content) { return Ok(Some(AskResponse { content: "".into(), tool_calls: Some(calls) })); }
  if !content.trim().is_empty() { return Ok(Some(AskResponse { content: content.into(), tool_calls: None })); }
  Ok(None) // Never execute reasoning text or present it as a final answer.
}

fn network_error(error: reqwest::Error) -> String {
  format!("Model connection failed: {}. Check your network, proxy and provider settings.", error.without_url())
}

async fn model_response(response: reqwest::Response, provider: &str) -> Result<Value, String> {
  let status = response.status();
  let text = response.text().await.map_err(network_error)?;
  let data = serde_json::from_str::<Value>(&text).map_err(|_| format!("{provider} returned HTTP {status} with an invalid response. Check the provider service or proxy."))?;
  if !status.is_success() {
    let detail = data["error"]["message"].as_str().or_else(|| data["error"].as_str()).unwrap_or("Model request failed");
    return Err(format!("{provider} HTTP {status}: {detail}"));
  }
  Ok(data)
}

#[tauri::command]
async fn ask_model(request: ChatRequest) -> Result<AskResponse, String> {
  let client = Client::new();
  let tools_enabled = request.tools_enabled.unwrap_or(true);
  let require_tool = tools_enabled && request.require_tool.unwrap_or(false);
  let messages = with_context(request.messages, &request.context);
  let model = fix_model(&request.provider, &request.model);
  if request.provider == "local" {
    let endpoint = request.local_url.unwrap_or_else(|| "http://127.0.0.1:11434".into());
    let mut body = ollama_body(&model, &messages, tools_enabled);
    let mut empty_retries = 0;
    loop {
      let response = client.post(format!("{}/api/chat", endpoint.trim_end_matches('/')))
        .json(&body).send().await.map_err(network_error)?;
      let status = response.status();
      let data: Value = response.json().await.map_err(network_error)?;
      if !status.is_success() {
        let error = data["error"].as_str().unwrap_or("Local model request failed");
        if body.get("tools").is_some() && error.to_ascii_lowercase().contains("not support tools") {
          body.as_object_mut().unwrap().remove("tools"); continue;
        }
        return Err(format!("Ollama HTTP {status}: {error}"));
      }
      if let Some(result) = parse_ollama_reply(&data)? { return Ok(result); }
      if empty_retries == 0 {
        empty_retries += 1;
        body["messages"].as_array_mut().unwrap().push(json!({"role":"user","content":"Return a final answer or a tool call for the pending request. Do not repeat tools already completed."}));
        continue;
      }
      return Err(format!("Ollama ({model}) returned no answer or tool call after one retry (reason: {}). Try a shorter conversation or another installed model. Existing edits are preserved.", data["done_reason"].as_str().unwrap_or("empty response")));
    }
  }
  if request.provider == "anthropic" {
    let key = request.api_key.or_else(|| std::env::var("ANTHROPIC_API_KEY").ok()).ok_or("Add an Anthropic API key in settings or set ANTHROPIC_API_KEY before launching CodePlus.".to_string())?;
    let system = messages.iter().filter(|m| m.role == "system").map(|m| m.content.clone()).collect::<Vec<_>>().join("\n\n");
    let chat = anthropic_messages(&messages);
    let mut body = json!({"model": model, "max_tokens": 8192, "messages": chat});
    if tools_enabled {
      body["tools"] = anthropic_tools();
      if require_tool { body["tool_choice"] = json!({"type":"any"}); }
    }
    if !system.is_empty() { body["system"] = json!(system); }
    let response = client.post("https://api.anthropic.com/v1/messages")
      .header("x-api-key", key).header("anthropic-version", "2023-06-01")
      .json(&body).send().await.map_err(network_error)?;
    let data = model_response(response, "Anthropic").await?;
    let blocks = data["content"].as_array().cloned().unwrap_or_default();
    let tool_calls = blocks.iter().filter(|b| b["type"] == "tool_use").map(|b| ToolCall { thought_signature: None, id: b["id"].as_str().unwrap_or("").to_string(), name: b["name"].as_str().unwrap_or("").to_string(), arguments: b["input"].clone() }).collect::<Vec<_>>();
    let text = blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n");
    if !tool_calls.is_empty() { return Ok(AskResponse { content: text, tool_calls: Some(tool_calls) }); }
    if text.trim().is_empty() { return Err("Anthropic returned no answer. Retry or select another model.".into()); }
    return Ok(AskResponse { content: text, tool_calls: None });
  }
  if request.provider == "gemini" {
    let key = request.api_key.or_else(|| std::env::var("GEMINI_API_KEY").ok()).ok_or("Add a Gemini API key in settings or set GEMINI_API_KEY before launching CodePlus.".to_string())?;
    let system = messages.iter().filter(|m| m.role == "system").map(|m| m.content.clone()).collect::<Vec<_>>().join("\n\n");
    let mut body = json!({"contents": gemini_contents(&messages)});
    if tools_enabled {
      body["tools"] = gemini_tools();
      body["toolConfig"] = json!({"functionCallingConfig":{"mode":if require_tool { "ANY" } else { "AUTO" }}});
    }
    if !system.is_empty() { body["systemInstruction"] = json!({"parts":[{"text":system}]}); }
    let response = client.post(format!("https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",model))
      .header("x-goog-api-key", &key).json(&body).send().await.map_err(network_error)?;
    let data = model_response(response, "Gemini").await?;
    let parts = data["candidates"][0]["content"]["parts"].as_array().cloned().unwrap_or_default();
    let tool_calls = parts.iter().filter_map(|part| {
      let call = part.get("functionCall")?;
      Some(ToolCall { thought_signature: part["thoughtSignature"].as_str().map(str::to_string), id: rand_id(), name: call["name"].as_str()?.to_string(), arguments: normalize_tool_args(call["args"].clone()) })
    }).collect::<Vec<_>>();
    let text = parts.iter().filter(|part| part["thought"] != true).filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("");
    if !tool_calls.is_empty() { return Ok(AskResponse { content: text, tool_calls: Some(tool_calls) }); }
    if let Some(fallback) = parse_tool_calls_fallback(&text) { return Ok(AskResponse { content: "".into(), tool_calls: Some(fallback) }); }
    if text.trim().is_empty() { return Err(format!("Gemini returned no answer ({}). Retry or choose another model.", data["promptFeedback"]["blockReason"].as_str().or_else(|| data["candidates"][0]["finishReason"].as_str()).unwrap_or("empty response"))); }
    return Ok(AskResponse { content: text, tool_calls: None });
  }
  if request.provider == "openai" {
    let key=request.api_key.or_else(|| std::env::var("OPENAI_API_KEY").ok()).ok_or("Add an OpenAI API key in settings or set OPENAI_API_KEY before launching CodePlus.".to_string())?;
    chat_completions(&client, "OpenAI", "https://api.openai.com/v1", &key, &model, &messages, tools_enabled, require_tool).await
  } else if let Some((base, env)) = compat_provider(&request.provider) {
    let key = request.api_key.or_else(|| std::env::var(env).ok()).ok_or(format!("Add an API key in settings or set {env} before launching CodePlus."))?;
    chat_completions(&client, &request.provider, base, &key, &model, &messages, tools_enabled, require_tool).await
  } else {
    Err(format!("Unknown provider: {}", request.provider))
  }
}

#[cfg(test)]
mod provider_tests {
  use super::*;

  fn tool_history() -> Vec<Message> {
    vec![
      Message { role: "user".into(), content: "Read the README".into(), tool_calls: None, tool_call_id: None, name: None },
      Message {
        role: "assistant".into(), content: "".into(), tool_call_id: None, name: None,
        tool_calls: Some(vec![ToolCall {
          id: "call_read".into(), name: "read".into(),
          arguments: json!({"filePath":"README.md"}), thought_signature: Some("opaque-signature".into())
        }])
      },
      Message { role: "tool".into(), content: "# CodePlus".into(), tool_calls: None, tool_call_id: Some("call_read".into()), name: Some("read".into()) }
    ]
  }

  #[test]
  fn serializes_tool_history_for_each_native_provider_protocol() {
    let history = tool_history();
    let openai = to_openai_messages(&history);
    assert_eq!(openai[1]["tool_calls"][0]["function"]["arguments"], "{\"filePath\":\"README.md\"}");
    assert_eq!(openai[2]["tool_call_id"], "call_read");

    let gemini = gemini_contents(&history);
    assert_eq!(gemini[1]["parts"][0]["thoughtSignature"], "opaque-signature");
    assert_eq!(gemini[2]["parts"][0]["functionResponse"]["name"], "read");

    let anthropic = anthropic_messages(&history);
    assert_eq!(anthropic[1]["content"][0]["type"], "tool_use");
    assert_eq!(anthropic[2]["content"][0]["type"], "tool_result");
  }

  #[test]
  fn gpt_oss_thinking_and_ollama_tool_results_are_native_safe() {
    let history = tool_history();
    let body = ollama_body("gpt-oss:20b", &history, true);
    assert_eq!(body["think"], "medium");
    assert_eq!(body["options"]["num_predict"], 8192);
    assert_eq!(body["messages"][2]["tool_name"], "read");
    assert!(ollama_body("gpt-oss:20b", &history, false).get("tools").is_none());
    assert_eq!(ollama_body("gpt-oss:20b", &history, false)["think"], "low");

    let reply = parse_ollama_reply(&json!({"message":{"content":"","tool_calls":[{"function":{"name":"read","arguments":"{\"filePath\":\"README.md\"}"}}]}})).unwrap().unwrap();
    assert_eq!(reply.tool_calls.unwrap()[0].arguments["filePath"], "README.md");
    assert!(parse_ollama_reply(&json!({"message":{"content":"","thinking":"hidden"}})).unwrap().is_none());
  }

  #[test]
  fn migrates_unavailable_gemini_legacy_default() {
    assert_eq!(fix_model("gemini", "gemini-2.5-flash"), "gemini-3.6-flash");
    assert_eq!(fix_model("gemini", "models/gemini-2.5-flash"), "gemini-3.6-flash");
    assert_eq!(fix_model("gemini", "gemini-3.6-flash"), "gemini-3.6-flash");
  }
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .invoke_handler(tauri::generate_handler![open_external_url, app_version, check_app_update, install_app_update, ask_model, list_local_models, pull_local_model, delete_local_model, list_provider_models, start_vscode_web, pick_workspace_folder, list_workspace_tree, read_workspace_file, write_workspace_file, create_workspace_dir, run_shell_command, start_dev_server, stop_dev_server, dev_server_status])
    .run(tauri::generate_context!())
    .expect("error while running CodePlus");
}
