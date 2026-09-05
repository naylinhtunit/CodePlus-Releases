// Isolated browser/WebKit regression fixture. No workspace, model or key APIs.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
const publicRoot = new URL('../public/', import.meta.url);
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  try {
    let body, type = 'text/javascript';
    if (pathname === '/app') {
      type = 'text/html';
      body = '<!doctype html><link rel="stylesheet" href="/styles.css"><div id="app"></div><div style="position:fixed;bottom:30px;left:280px;z-index:9999;background:#111;color:white"><button id="run-regression">Run regression tests</button><pre id="test-results">Ready</pre></div><script type="module" src="/regression.js"></script>';
    } else if (pathname === '/frame') {
      type = 'text/html'; body = '<!doctype html><h1>Stable preview fixture</h1><input aria-label="Preview draft"><div style="height:2000px">Scroll stays here</div>';
    } else if (pathname === '/regression.js') {
      body = await readFile(new URL('./workspace-browser.js', import.meta.url));
    } else if (pathname === '/app.js') {
      const source = await readFile(new URL('app.js', publicRoot), 'utf8');
      body = source.slice(0, source.lastIndexOf('\napp();')) + '\nexport { state, app };';
    } else if (['/workspace-dom.js', '/agent-history.js', '/agent-turn.js', '/prompt-intent.js', '/styles.css', '/assets/codeplus-logo.png'].includes(pathname)) {
      type = pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.png') ? 'image/png' : type;
      body = await readFile(new URL(pathname.slice(1), publicRoot));
    } else { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': type.startsWith('text/') ? `${type}; charset=utf-8` : type, 'Cache-Control': 'no-store' }); response.end(body);
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
server.listen(4175, '127.0.0.1', () => console.log('Regression fixture: http://127.0.0.1:4175/app'));
