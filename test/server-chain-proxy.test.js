import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createLocalChainProxy } from '../server-chain-proxy.js';

async function fixture(t, respond = () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })) {
  const calls = [];
  const server = createServer(createLocalChainProxy({ origin: 'http://127.0.0.1:5173', rpc: 'tcp://127.0.0.1:26657', rest: 'http://127.0.0.1:1317',
    fetchImpl: async (...args) => { calls.push(args); return respond(...args); } }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const send = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { host: '127.0.0.1:5173', ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    }); req.on('error', reject); req.end(body);
  });
  return { send, calls };
}
const jsonRpc = (method, params = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

test('chain reads use fixed endpoints without forwarding credentials or enabling CORS', async t => {
  const f = await fixture(t);
  const result = await f.send('/chain-rest/clairveil/privacy/v1/tree_state?height=2', { headers: { authorization: 'synthetic', cookie: 'synthetic=1' } });
  assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.equal(f.calls[0][0], 'http://127.0.0.1:1317/clairveil/privacy/v1/tree_state?height=2');
  assert.deepEqual(f.calls[0][1].headers, { accept: 'application/json' });
  assert.equal(f.calls[0][1].redirect, 'error'); assert.equal(f.calls[0][1].credentials, 'omit');
  assert.equal((await f.send('/chain-rpc/status')).status, 200);
  assert.equal((await f.send('/chain-rpc', jsonRpc('abci_query', { path: '/store/test' }))).status, 200);
});

test('broadcast is explicit, same-origin, synchronous and forwarded exactly once', async t => {
  const f = await fixture(t), input = jsonRpc('broadcast_tx_sync', { tx: 'AQID' });
  assert.equal((await f.send('/chain-rpc', { ...input, headers: { ...input.headers, origin: 'https://other.example' } })).status, 403);
  assert.equal((await f.send('/chain-rpc/broadcast_tx_sync?tx=AQID')).status, 404);
  assert.equal((await f.send('/chain-rpc', jsonRpc('unsafe_flush_mempool'))).status, 403);
  assert.equal((await f.send('/chain-rest/cosmos/tx/v1beta1/txs', input)).status, 404);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.send('/chain-rpc', input)).status, 200); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].body, input.body);
});

test('ambiguous broadcast failure is not retried and malformed requests never reach the chain', async t => {
  const f = await fixture(t, () => { throw new Error('synthetic connection lost'); });
  assert.equal((await f.send('/chain-rpc', jsonRpc('broadcast_tx_sync', { tx: 'AQID' }))).status, 502);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.send('/chain-rpc/status', { headers: { host: 'hostile.example' } })).status, 403);
  assert.equal((await f.send('/chain-rpc', { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.send('/chain-rpc', { ...jsonRpc('status'), body: '[]' })).status, 400);
  assert.equal((await f.send('/chain-rpc', { ...jsonRpc('status'), body: 'x'.repeat(2 * 1024 * 1024 + 1) })).status, 502);
  assert.equal(f.calls.length, 1);
});

test('upstream response limits and loopback endpoint validation fail closed', async t => {
  const f = await fixture(t, () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }));
  assert.equal((await f.send('/chain-rpc/status')).status, 502);
  for (const rest of ['http://remote.example', 'http://user:secret@127.0.0.1:1317', 'http://127.0.0.1:1317/path']) {
    assert.throws(() => createLocalChainProxy({ origin: 'http://127.0.0.1:5173', rpc: 'http://127.0.0.1:26657', rest }), /loopback/);
  }
});
