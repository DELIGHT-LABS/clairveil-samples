import { readBoundedBody } from './server-bounded-body.js';

// Opt-in browser access to fixed local chain endpoints. No signing or retries.
const readMethods = new Set(['status', 'health', 'abci_info', 'abci_query', 'block', 'block_results',
  'blockchain', 'commit', 'genesis', 'genesis_chunked', 'validators', 'tx', 'tx_search', 'block_search', 'net_info']);
const maximum = 2 * 1024 * 1024;

export function createLocalChainProxy({ origin, rpc, rest, fetchImpl = fetch }) {
  const localOrigin = new URL(origin);
  if (localOrigin.protocol !== 'http:' || localOrigin.hostname !== '127.0.0.1') throw new Error('Local chain proxy requires a loopback web server');
  const upstream = Object.fromEntries(Object.entries({ rpc, rest }).map(([kind, endpoint]) => {
    const url = new URL(endpoint.replace(/^tcp:/, 'http:'));
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw new Error('Local chain proxy requires fixed loopback endpoint origins');
    return [kind, url.origin];
  }));
  let inFlight = 0;
  return async function handleChainProxy(request, response) {
    const finish = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(body);
    };
    const reject = status => finish(status, '{"error":"Local chain proxy rejected the request"}');
    if (request.headers.host !== localOrigin.host) return reject(403);
    if (inFlight >= 16) return reject(429);
    inFlight++;
    try {
      const url = new URL(request.url, origin);
      let target, body;
      if (url.pathname.startsWith('/chain-rest/') && request.method === 'GET') {
        target = upstream.rest + url.pathname.slice('/chain-rest'.length) + url.search;
      } else if (url.pathname === '/chain-rpc' || url.pathname.startsWith('/chain-rpc/')) {
        const route = url.pathname.slice('/chain-rpc'.length);
        if (request.method === 'GET' && readMethods.has(route.slice(1))) target = upstream.rpc + route + url.search;
        else if (request.method === 'POST' && (route === '' || route === '/')) {
          if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) return reject(415);
          const message = JSON.parse((await readBoundedBody(request, maximum)).toString('utf8'));
          if (!message || Array.isArray(message) || message.jsonrpc !== '2.0'
            || !['string', 'number'].includes(typeof message.id)) return reject(400);
          if (message.method === 'broadcast_tx_sync') {
            if (request.headers.origin !== origin || !message.params || Object.keys(message.params).join() !== 'tx'
              || typeof message.params.tx !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(message.params.tx)) return reject(403);
          } else if (!readMethods.has(message.method)) return reject(403);
          target = upstream.rpc; body = JSON.stringify(message);
        }
      }
      if (!target) return reject(404);
      const result = await fetchImpl(target, { method: body ? 'POST' : 'GET', body,
        headers: body ? { 'content-type': 'application/json' } : { accept: 'application/json' },
        redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000) });
      if (!result.headers.get('content-type')?.includes('application/json')) {
        await result.body?.cancel(); throw new Error('UPSTREAM_JSON_REQUIRED');
      }
      finish(result.status, await readBoundedBody(result.body, maximum));
    } catch {
      finish(502, '{"error":"Local chain response unavailable; do not automatically resubmit a transaction"}');
    } finally { inFlight--; }
  };
}
