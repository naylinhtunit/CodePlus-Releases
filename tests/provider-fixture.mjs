import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
export function providerFixture(fetcher = fetch) {
  const sandbox = { fetch: fetcher, ollamaFetch: fetcher, process: { env: {} }, console };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('const OPENAI_COMPATIBLE ='), source.indexOf('const DOWNLOAD_ASSETS =')) + '\nthis.api = { askModel, ollamaBody, parseOllamaReply, geminiContents, toOpenAIMessages };', sandbox);
  return sandbox.api;
}
