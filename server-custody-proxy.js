import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoundedBody } from './server-bounded-body.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');
const assets = { '/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css', '/app.bundle.js': 'app.bundle.js', '/custody-profiles.json': 'custody-profiles.json' };
const readMethods = new Set(['status', 'abci_info', 'abci_query', 'block', 'block_results', 'blockchain', 'commit', 'genesis', 'validators', 'tx', 'tx_search', 'health', 'net_info']);
const origin = 'http://127.0.0.1:4320';

export function createSamplePreviewServer({ publicDirectory = root, fetchImpl = fetch } = {}) {
  return createServer(async (request, response) => {
    const finish = (code, body, type = 'application/json') => {
      response.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
      response.end(body);
    };
    try {
      if (request.headers.host !== '127.0.0.1:4320') return finish(403, '{"error":"Local origin required"}');
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
        const name = assets[url.pathname], type = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/json';
        return finish(200, await readFile(path.join(publicDirectory, name)), type);
      }
      let upstream, body;
      if (url.pathname === '/custody-broadcast' && request.method === 'POST') {
        if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') return finish(403, '{"error":"Same-origin JSON required"}');
        const params = JSON.parse((await readBoundedBody(request, 65536)).toString());
        if (Object.keys(params).sort().join() !== 'mode,tx_bytes' || params.mode !== 'BROADCAST_MODE_SYNC' || typeof params.tx_bytes !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(params.tx_bytes)) return finish(400, '{"error":"Invalid transaction envelope"}');
        upstream = 'http://127.0.0.1:1317/cosmos/tx/v1beta1/txs'; body = JSON.stringify(params);
      } else if (url.pathname.startsWith('/evm-rest/') && request.method === 'GET') {
        upstream = `http://127.0.0.1:1417${url.pathname.slice('/evm-rest'.length)}${url.search}`;
      } else if (url.pathname.startsWith('/evm-rpc/') && request.method === 'GET' && readMethods.has(url.pathname.slice('/evm-rpc/'.length))) {
        upstream = `http://127.0.0.1:27657${url.pathname.slice('/evm-rpc'.length)}${url.search}`;
      } else if (url.pathname.startsWith('/cosmos-rest/') && request.method === 'GET') {
        upstream = `http://127.0.0.1:1317${url.pathname.slice('/cosmos-rest'.length)}${url.search}`;
      } else if (url.pathname.startsWith('/cosmos-rpc')) {
        const route = url.pathname.slice('/cosmos-rpc'.length);
        if (request.method === 'GET' && readMethods.has(route.slice(1))) upstream = `http://127.0.0.1:26657${route}${url.search}`;
        else if (request.method === 'POST' && (route === '' || route === '/')) {
          const params = JSON.parse((await readBoundedBody(request, 65536)).toString());
          if (!readMethods.has(params.method)) return finish(403, '{"error":"Read-only RPC proxy"}');
          upstream = 'http://127.0.0.1:26657'; body = JSON.stringify(params);
        }
      }
      if (!upstream) return finish(404, '{"error":"Not found"}');
      const signal = AbortSignal.timeout(20000);
      const upstreamResponse = await fetchImpl(upstream, { method: body ? 'POST' : 'GET', body, signal,
        headers: body ? { 'content-type': 'application/json' } : {}, redirect: 'error', credentials: 'omit' });
      const bytes = await readBoundedBody(upstreamResponse.body, 2 * 1024 * 1024);
      return finish(upstreamResponse.status, bytes);
    } catch { finish(502, '{"error":"Local chain unavailable or request rejected; do not automatically resubmit"}'); }
  });
}
