import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function implementation(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1);
  const next = source.slice(start + 1).search(/^(?:async )?function /m);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}
function fixture() {
  const calls = [], handlers = new Map(), buttons = new Map();
  let renders = 0, cleaned = 0;
  const state = { localUrl:'http://127.0.0.1:11434', provider:'local', model:'test:a', localModels:[], pullProgress:{}, modelPickerOpen:true, settingsOpen:false };
  const sandbox = {
    state, console, TextDecoder, Uint8Array, CSS:{escape:s=>s},
    listen:(element,type,handler)=>element?.addEventListener(type,handler),
    app:()=>renders++, localStorage:{setItem(){}, removeItem(){}},
    refreshLocalModels:async()=>{},
    updatePullProgressDOM:(model, percent)=>{state.pullProgress[model]=percent;},
    document:{querySelector:key=>buttons.get(key), querySelectorAll:()=>[buttons.get('delete')].filter(Boolean)},
    window:{__TAURI_INTERNALS__:{invoke:async(command, payload)=>{calls.push({command,payload});}},
      __TAURI__:{event:{listen:async(event, handler)=>{handlers.set(event,handler);return async()=>{cleaned++;};}}},
      confirm:()=>{throw new Error('Browser confirm must not be used');}}
  };
  const context = vm.createContext(sandbox);
  for (const name of ['tauriInvoke','tauriListen','localModelRequest','streamPullLocalModel','localModelError','bindLocalModelDeletion','pullLocalModel','deleteLocalModel']) vm.runInContext(implementation(name),context);
  return {context,state,calls,handlers,buttons,get renders(){return renders;},get cleaned(){return cleaned;}};
}
test('packaged static desktop exposes the supported event API',()=>{
  const config=JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json',import.meta.url)));
  assert.equal(config.app.withGlobalTauri,true);
  assert.doesNotMatch(implementation('tauriListen'), /import\(/);
});
test('desktop pull invokes native command, handles progress and unregisters listener',async()=>{
  const f=fixture();
  f.context.window.__TAURI_INTERNALS__.invoke=async(command,payload)=>{
    f.calls.push({command,payload});
    f.handlers.get('ollama-pull-progress')({payload:{model:'test:a',total:100,completed:42}});
    assert.equal(f.state.pullProgress['test:a'],42);
    f.handlers.get('ollama-pull-progress')({payload:{model:'different',total:100,completed:90}});
    assert.equal(f.state.pullProgress['test:a'],42);
  };
  await f.context.streamPullLocalModel('test:a','http://localhost:11434');
  assert.equal(f.calls[0].command,'pull_local_model');
  assert.equal(f.calls[0].payload.endpoint,'http://localhost:11434');
  assert.equal(f.state.pullProgress['test:a'],100);
  assert.equal(f.cleaned,1);
});
test('native string errors are shown and model-picker progress resets for retry',async()=>{
  const f=fixture();
  f.context.window.__TAURI_INTERNALS__.invoke=async()=>{throw 'Ollama is not running';};
  await f.context.pullLocalModel('test:a');
  assert.equal(f.state.localModelsError,'Ollama is not running');
  assert.equal(f.state.pullProgress['test:a'],undefined);
  assert.equal(f.cleaned,1);
  assert.equal(f.renders,2);
});
test('parallel downloads remain independent and duplicate clicks do not start another pull',async()=>{
  const f=fixture(), finish={};
  f.context.streamPullLocalModel=(model)=>new Promise(resolve=>{finish[model]=resolve;});
  const a=f.context.pullLocalModel('test:a'), b=f.context.pullLocalModel('test:b');
  await f.context.pullLocalModel('test:a');
  assert.equal(Object.keys(finish).length,2);
  finish['test:a'](); await a;
  assert.equal(f.state.pullProgress['test:a'],undefined);
  assert.equal(f.state.pullProgress['test:b'],0);
  finish['test:b'](); await b;
  assert.equal(Object.keys(f.state.pullProgress).length,0);
});
test('delete requires in-app confirmation; cancel makes no native call',async()=>{
  const f=fixture(), clicks={};
  for(const key of ['delete','#cancel-delete-model','#confirm-delete-model']) f.buttons.set(key,{dataset:{deleteModel:'test:a'},addEventListener:(_,fn)=>{clicks[key]=fn;}});
  f.context.bindLocalModelDeletion(()=>f.state.localUrl);
  clicks.delete();
  assert.equal(f.calls.length,0);
  clicks['#cancel-delete-model']();
  assert.equal(f.state.modelDeleteConfirm,null);
  assert.equal(f.calls.length,0);
  clicks.delete(); clicks['#confirm-delete-model']();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].command,'delete_local_model');
  assert.equal(f.calls[0].payload.model,'test:a');
  assert.equal(f.state.removingModel,'');
});
test('failed native delete displays its actual error and reenables retry',async()=>{
  const f=fixture();
  f.context.window.__TAURI_INTERNALS__.invoke=async()=>{throw 'permission denied';};
  await f.context.deleteLocalModel('test:a');
  assert.equal(f.state.localModelsError,'permission denied');
  assert.equal(f.state.removingModel,'');
  assert.equal(f.state.model,'test:a');
});
test('web deletion still uses the server API',async()=>{
  const f=fixture(); delete f.context.window.__TAURI_INTERNALS__;
  f.context.fetch=async(url,options)=>{
    assert.equal(url,'/api/models/delete'); assert.equal(options.method,'POST');
    assert.equal(JSON.parse(options.body).model,'test:a');
    return {ok:true,json:async()=>({ok:true})};
  };
  await f.context.deleteLocalModel('test:a');
  assert.equal(f.state.localModelsError,'');
});
test('errors remain visible even when another model is installed',()=>{
  const f=fixture(); f.context.localModelCatalog=[]; f.context.escape=s=>s;
  f.context.compactModelName=s=>s;
  f.state.localModels=[{name:'test:a'}]; f.state.localModelsError='Failed to pull';
  vm.runInContext(implementation('localModelField'),f.context);
  assert.match(f.context.localModelField(),/role="alert">Failed to pull/);
});
test('web pull handles split NDJSON progress and final success',async()=>{
  const f=fixture(); delete f.context.window.__TAURI_INTERNALS__;
  const chunks=['{"total":100,','"completed":30}\n','{"status":"success"}'];
  let index=0;
  f.context.fetch=async(url,options)=>{
    assert.equal(url,'/api/models/pull');
    assert.equal(JSON.parse(options.body).endpoint,f.state.localUrl);
    return {ok:true,body:{getReader:()=>({read:async()=>index<chunks.length
      ? {done:false,value:new TextEncoder().encode(chunks[index++])} : {done:true}})}};
  };
  await f.context.streamPullLocalModel('test:a');
  assert.equal(f.state.pullProgress['test:a'],100);
});
test('missing desktop event bridge shows actionable error before requesting a pull',async()=>{
  const f=fixture(); delete f.context.window.__TAURI__;
  await f.context.pullLocalModel('test:a');
  assert.match(f.state.localModelsError,/latest CodePlus desktop release/);
  assert.equal(f.calls.length,0);
  assert.equal(f.state.pullProgress['test:a'],undefined);
});
