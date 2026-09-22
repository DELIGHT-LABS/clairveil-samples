import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalCustodyBridge, REQUEST_CHANNEL, RESPONSE_CHANNEL } from '../public/custody-bridge.js';
function fixture() {
  const events = new Set(), sent = [];
  const page = { location: { origin: 'http://127.0.0.1:4320' }, addEventListener: (_, fn) => events.add(fn), removeEventListener: (_, fn) => events.delete(fn), postMessage: message => sent.push(message) };
  return { page, sent, deliver(data, fields = {}) { for (const fn of events) fn({ source: page, origin: page.location.origin, data, ...fields }); } };
}
test('CC-004 bridge sends bounded raw extension-v1 frames and correlates replies', async () => {
  const f = fixture(), bridge = createLocalCustodyBridge(f.page);
  const request = { id: 'one', jsonrpc: '2.0', method: 'clairveil_getCapabilities', params: { protocolVersion: '1' } };
  const reply = { channel: RESPONSE_CHANNEL, payload: JSON.stringify({ id: 'one', jsonrpc: '2.0', result: {} }) };
  const pending = bridge.exchange(request);
  assert.deepEqual(f.sent[0], { channel: REQUEST_CHANNEL, payload: JSON.stringify(request) });
  f.deliver(reply, { source: {} }); f.deliver(reply, { origin: 'https://wrong.example' });
  f.deliver({ source: 'cc002-host', response: JSON.parse(reply.payload) });
  f.deliver({ channel: RESPONSE_CHANNEL, payload: '{' });
  f.deliver({ channel: RESPONSE_CHANNEL, payload: JSON.stringify({ id: 'other' }) });
  f.deliver(reply); assert.equal(await pending, reply.payload); bridge.close();
});
test('raw duplicate JSON members reach the SDK validator without normalization', async () => {
  const f = fixture(), bridge = createLocalCustodyBridge(f.page);
  const pending = bridge.exchange({ id: 'one' });
  const raw = '{"id":"one","jsonrpc":"2.0","result":{},"result":{}}';
  f.deliver({ channel: RESPONSE_CHANNEL, payload: raw }); assert.equal(await pending, raw); bridge.close();
});
test('closure rejects pending work and late replies never restore authority', async () => {
  const f = fixture(), bridge = createLocalCustodyBridge(f.page); let invalidations = 0;
  bridge.subscribe(() => invalidations++);
  const pending = bridge.exchange({ id: 'one' }), rejected = assert.rejects(pending);
  bridge.close(); await rejected;
  f.deliver({ channel: RESPONSE_CHANNEL, payload: '{"id":"one","result":{}}' });
  await assert.rejects(bridge.exchange({ id: 'two' })); assert.equal(invalidations, 1);
});
test('absent extension times out and wrong origins or oversize requests send nothing', async () => {
  const f = fixture(), bridge = createLocalCustodyBridge(f.page, { timeoutMs: 10 });
  await assert.rejects(bridge.exchange({ id: 'one' }), /CC-004/);
  await assert.rejects(bridge.exchange({ id: 'large', value: '가'.repeat(12000) }));
  f.page.location.origin = 'http://127.0.0.1:5173';
  await assert.rejects(bridge.exchange({ id: 'two' })); assert.equal(f.sent.length, 1); bridge.close();
});
test('oversize responses are ignored and an outstanding ID cannot be reused', async () => {
  const f = fixture(), bridge = createLocalCustodyBridge(f.page, { timeoutMs: 10 });
  const pending = bridge.exchange({ id: 'one' });
  await assert.rejects(bridge.exchange({ id: 'one' }));
  f.deliver({ channel: RESPONSE_CHANNEL, payload: JSON.stringify({ id: 'one', result: '가'.repeat(180000) }) });
  await assert.rejects(pending); bridge.close();
});
