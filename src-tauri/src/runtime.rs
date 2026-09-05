use std::{env, ffi::OsString, path::{Path, PathBuf}, process::Command};

// Finder/Start-menu launches do not inherit a terminal's Node/version-manager PATH.
// Keep existing entries first, then add only existing, user-owned install locations.
fn append_dir(paths: &mut Vec<PathBuf>, path: PathBuf) {
  if path.is_dir() && !paths.contains(&path) { paths.push(path); }
}

fn version_bins(paths: &mut Vec<PathBuf>, base: &Path, suffix: &str) {
  let mut versions: Vec<_> = std::fs::read_dir(base).into_iter().flatten().filter_map(Result::ok).map(|e| e.path()).collect();
  versions.sort_by_key(|p| p.file_name().unwrap_or_default().to_string_lossy().trim_start_matches('v').split('.').map(|n| n.parse::<u32>().unwrap_or(0)).collect::<Vec<_>>());
  for version in versions.into_iter().rev() { append_dir(paths, version.join(suffix)); }
}

fn supplemented_path(inherited: OsString, home: Option<PathBuf>) -> OsString {
  let mut paths: Vec<_> = env::split_paths(&inherited).filter(|p| !p.as_os_str().is_empty()).collect();
  for (key, suffix) in [("NVM_BIN", ""), ("NVM_SYMLINK", ""), ("VOLTA_HOME", "bin"), ("FNM_MULTISHELL_PATH", "bin")] {
    if let Some(value) = env::var_os(key) { append_dir(&mut paths, PathBuf::from(value).join(suffix)); }
  }
  if cfg!(windows) {
    for key in ["ProgramFiles", "ProgramFiles(x86)"] {
      if let Some(value) = env::var_os(key) { append_dir(&mut paths, PathBuf::from(value).join("nodejs")); }
    }
    if let Some(value) = env::var_os("LOCALAPPDATA") {
      let base = PathBuf::from(value);
      append_dir(&mut paths, base.join("Programs/nodejs"));
      append_dir(&mut paths, base.join("Volta/bin"));
      version_bins(&mut paths, &base.join("fnm/node-versions"), "installation");
    }
    if let Some(value) = env::var_os("NVM_HOME") { version_bins(&mut paths, &PathBuf::from(value), ""); }
  } else {
    for path in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] { append_dir(&mut paths, path.into()); }
  }
  if let Some(home) = home {
    for suffix in [".volta/bin", ".asdf/shims", ".local/share/mise/shims", ".local/bin", "scoop/apps/nodejs/current", "scoop/apps/nodejs-lts/current", "AppData/Roaming/npm"] {
      append_dir(&mut paths, home.join(suffix));
    }
    let nvm = env::var_os("NVM_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".nvm"));
    version_bins(&mut paths, &nvm.join("versions/node"), "bin");
    for suffix in [".local/share/fnm/node-versions", "Library/Application Support/fnm/node-versions"] {
      version_bins(&mut paths, &home.join(suffix), if cfg!(windows) { "installation" } else { "installation/bin" });
    }
  }
  env::join_paths(paths).unwrap_or(inherited)
}

pub fn shell_command(command: &str) -> Command {
  let mut process = if cfg!(windows) {
    let mut cmd = Command::new(env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()));
    cmd.args(["/D", "/S", "/C"]).arg(command); cmd
  } else {
    let mut cmd = Command::new("/bin/sh"); cmd.arg("-c").arg(command); cmd
  };
  let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
  process.env("PATH", supplemented_path(env::var_os("PATH").unwrap_or_default(), home));
  process
}

pub fn missing_node_hint(stderr: &str) -> &'static str {
  let text = stderr.to_ascii_lowercase();
  if (text.contains("npm") || text.contains("node")) && (text.contains("not found") || text.contains("not recognized")) {
    "\nNode.js/npm could not be found. Install Node.js LTS from https://nodejs.org, then fully quit and reopen CodePlus. If using a version manager, activate a Node version first."
  } else { "" }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn discovers_version_manager_node_without_terminal_path() {
    let root = env::temp_dir().join(format!("codeplus-runtime-{}", std::process::id()));
    let bin = root.join(".nvm/versions/node/v22.0.0/bin");
    std::fs::create_dir_all(&bin).unwrap();
    let inherited = OsString::from(if cfg!(windows) { r"C:\Windows\System32" } else { "/usr/bin:/bin" });
    let path = supplemented_path(inherited.clone(), Some(root.clone()));
    assert!(env::split_paths(&path).any(|p| p == bin));
    assert_eq!(env::split_paths(&path).next(), env::split_paths(&inherited).next());
    std::fs::remove_dir_all(root).unwrap();
  }
  #[test]
  fn shell_finds_node_and_npm() {
    let out = shell_command("node --version && npm --version").output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stdout).contains('v'));
  }
  #[test]
  fn explains_missing_runtime_on_both_platforms() {
    assert!(!missing_node_hint("sh: npm: command not found").is_empty());
    assert!(!missing_node_hint("'npm' is not recognized as an internal or external command").is_empty());
    assert!(missing_node_hint("TypeScript compile error").is_empty());
  }
}
