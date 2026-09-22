import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createCustodyPreviewServer } from '../tools/serve-custody.mjs';

async function fixture(t, respond = () => new Response('{"ok":true}')) {
  const calls = [];
  const server = createCustodyPreviewServer({ fetchImpl: async (...args) => { calls.push(args); return respond(...args); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  function send(path, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: { host: '127.0.0.1:4320', ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }); req.on('error', reject); req.end(body);
    });
  }
  return { send, calls };
}

test('preview serves isolated custody HTML and rejects unrelated files and hostile Host', async t => {
  const f = await fixture(t);
  const response = await f.send('/'); assert.equal(response.status, 200); assert.match(response.body, /custody.bundle.js/); assert.doesNotMatch(response.body, /src="\/app.bundle.js/);
  assert.equal((await f.send('/custody')).body, response.body);
  assert.equal((await f.send('/custody.html')).body, response.body);
  assert.equal((await f.send('/app.bundle.js')).status, 404);
  assert.equal((await f.send('/../../package.json')).status, 404);
  assert.equal((await f.send('/', { headers: { host: 'attacker.example' } })).status, 403);
});

test('broadcast requires same-origin JSON and proxy only permits read RPC methods', async t => {
  const f = await fixture(t), body = JSON.stringify({ tx_bytes: 'AQID', mode: 'BROADCAST_MODE_SYNC' });
  assert.equal((await f.send('/custody-broadcast', { method: 'POST', body })).status, 403);
  assert.equal((await f.send('/cosmos-rpc', { method: 'POST', body: JSON.stringify({ method: 'broadcast_tx_sync' }) })).status, 403);
  assert.equal((await f.send('/cosmos-rpc/broadcast_tx_commit?tx=1')).status, 404);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.send('/custody-broadcast', { method: 'POST', body, headers: { origin: 'http://127.0.0.1:4320', 'content-type': 'application/json' } })).status, 200);
  assert.equal(f.calls[0][0], 'http://127.0.0.1:1317/cosmos/tx/v1beta1/txs');
  assert.equal((await f.send('/cosmos-rpc/status')).status, 200);
  assert.equal(f.calls[1][0], 'http://127.0.0.1:26657/status');
});

test('custody proxy retains its smaller request limit and never retries a failed broadcast', async t => {
  const f = await fixture(t, () => { throw new Error('synthetic response lost'); });
  const headers = { origin: 'http://127.0.0.1:4320', 'content-type': 'application/json' };
  const oversized = JSON.stringify({ tx_bytes: 'A'.repeat(65536), mode: 'BROADCAST_MODE_SYNC' });
  assert.equal((await f.send('/custody-broadcast', { method: 'POST', headers, body: oversized })).status, 502);
  assert.equal(f.calls.length, 0);
  const body = JSON.stringify({ tx_bytes: 'AQID', mode: 'BROADCAST_MODE_SYNC' });
  assert.equal((await f.send('/custody-broadcast', { method: 'POST', headers, body })).status, 502);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].credentials, 'omit');
  assert.equal(f.calls[0][1].redirect, 'error');
});

test('custody proxy bounds upstream bodies across chunks', async t => {
  const f = await fixture(t, () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    }
  })));
  assert.equal((await f.send('/cosmos-rpc/status')).status, 502);
  assert.equal(f.calls.length, 1);
});
