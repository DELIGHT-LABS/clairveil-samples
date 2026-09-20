import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalCustodyBridge } from '../public/custody-bridge.js';

function pageFixture() {
  const events = new Set(), sent = [];
  const page = { location: { origin: 'http://127.0.0.1:4320' }, addEventListener: (_, fn) => events.add(fn), removeEventListener: (_, fn) => events.delete(fn), postMessage: message => sent.push(message) };
  return { page, sent, deliver(data, fields = {}) { for (const fn of events) fn({ source: page, origin: page.location.origin, data, ...fields }); } };
}

test('local bridge correlates replies and ignores other windows/origins', async () => {
  const f = pageFixture(), bridge = createLocalCustodyBridge(f.page);
  const response = { id: 'one', jsonrpc: '2.0', result: {} };
  const p = bridge.exchange({ id: 'one' });
  f.deliver({ source: 'cc002-host', response }, { source: {} });
  f.deliver({ source: 'cc002-host', response }, { origin: 'https://wrong.example' });
  f.deliver({ source: 'cc002-host', response: { ...response, id: 'other' } });
  f.deliver({ source: 'cc002-host', response }); assert.equal(await p, response); bridge.close();
});

test('invalidation rejects pending exchanges and cannot be undone by a late reply', async () => {
  const f = pageFixture(), bridge = createLocalCustodyBridge(f.page); let invalidations = 0;
  bridge.subscribe(() => invalidations++);
  const p = bridge.exchange({ id: 'one' }), rejected = assert.rejects(p);
  f.deliver({ source: 'cc002-host', invalidated: true }); await rejected;
  f.deliver({ source: 'cc002-host', response: { id: 'one', result: {} } });
  await assert.rejects(bridge.exchange({ id: 'two' })); assert.equal(invalidations, 1); bridge.close();
});

test('absent extension times out and wrong page origins do not send requests', async () => {
  const f = pageFixture(), bridge = createLocalCustodyBridge(f.page, { timeoutMs: 10 });
  await assert.rejects(bridge.exchange({ id: 'one' })); bridge.close();
  f.page.location.origin = 'http://127.0.0.1:5173';
  const other = createLocalCustodyBridge(f.page); await assert.rejects(other.exchange({ id: 'two' }));
  assert.equal(f.sent.length, 1); other.close();
});

test('readiness probe uses a separate correlated channel and sends no custody RPC', async () => {
  const f = pageFixture(), bridge = createLocalCustodyBridge(f.page);
  const pending = bridge.probe(), probe = f.sent[0];
  assert.equal(probe.source, 'cc002-preview'); assert.equal(probe.request, undefined);
  f.deliver({ source: 'cc002-preview', type: 'status', nonce: 'wrong', workbench: 'ready' });
  f.deliver({ source: 'cc002-preview', type: 'status', nonce: probe.nonce, workbench: 'ready' }, { source: {} });
  f.deliver({ source: 'cc002-preview', type: 'status', nonce: probe.nonce, workbench: 'setup_required' });
  assert.deepEqual(await pending, { workbench: 'setup_required' }); bridge.close();
});

test('missing extension reports absence without surfacing SDK RESOURCE_LIMIT', async () => {
  const f = pageFixture(), bridge = createLocalCustodyBridge(f.page, { probeTimeoutMs: 10 });
  assert.deepEqual(await bridge.probe(), { workbench: 'missing' });
  const pending = bridge.probe(); bridge.close(); assert.deepEqual(await pending, { workbench: 'unavailable' });
});
