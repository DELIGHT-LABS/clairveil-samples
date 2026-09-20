import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustodySession, depositMethods } from '../public/custody-session.js';
import { custodyActions } from '../public/custody-state.js';

function fixture(overrides = {}) {
  const actor = { namespace: 'eip155', chainId: '0x32f', address: '0x' + '11'.repeat(20) };
  const profile = { id: 'local', transport: 'evm', chainId: 'maroo-zerofee-2', evmChainId: '0x32f', caip: 'eip155:815', profileDigest: 'digest', denom: 'aokrw' };
  const listeners = new Set(), calls = [];
  const provider = { onInvalidation(fn) { listeners.add(fn); return () => listeners.delete(fn); }, invalidate() { for (const fn of listeners) fn(); } };
  const connection = { permissions: ['deposit.request'], chainActors: [{ accountId: `${profile.caip}:${actor.address}`, chainActorHandle: 'actor' }], sessionHandle: 'session', accountHandle: 'account', networkHandle: 'network' };
  let operation = { operationId: 'connect', kind: 'connect', state: 'completed', connection };
  const client = {
    getCapabilities: async () => ({ methods: depositMethods, networks: [{ networkId: profile.id, chainId: profile.caip, profileDigest: profile.profileDigest }] }),
    connect: async params => { calls.push(['connect', params]); return { operationId: 'connect', state: 'awaiting_approval' }; },
    getOperation: async () => operation,
    prepareDeposit: async params => { calls.push(['deposit', params]); return { operationId: 'deposit', state: 'awaiting_approval' }; },
    submit: async params => { calls.push(['submit', params]); return { invoked: true }; },
    reconcile: async params => { calls.push(['reconcile', params]); },
    cancelOperation: async () => ({ operation: { ...operation, state: 'cancelled' } }),
    disconnect: async () => provider.invalidate(),
    ...overrides.client
  };
  const wallet = { connect: async () => actor, getActor: async () => actor, ...overrides.wallet };
  const session = createCustodySession({ client, provider, wallet, profile, checkAvailability: overrides.checkAvailability });
  return { session, provider, calls, actor, connection, client, setOperation: value => { operation = value; },
    async connect() { await session.connectWallet(); await session.connectCustody(); await session.refresh(); } };
}

test('custody flow requests deposit permission and submits once through the SDK coordinator', async () => {
  const f = fixture(); await f.connect();
  await f.session.deposit('7');
  assert.equal(f.calls[0][1].permissions.join(), 'deposit.request');
  assert.equal(f.calls[1][1].protocol.amountBaseUnits, '7');
  assert.equal(f.calls[1][1].chainActorHandle, 'actor');
  f.setOperation({ operationId: 'deposit', kind: 'deposit', state: 'awaiting_chain_signature', publicArtifact: {} });
  await f.session.refresh(); await f.session.submit();
  assert.equal(custodyActions(f.session.state).submit, false);
  await assert.rejects(f.session.submit());
  assert.equal(f.calls.filter(x => x[0] === 'submit').length, 1);
  f.setOperation({ operationId: 'deposit', kind: 'deposit', state: 'submitted' });
  await f.session.refresh(); await f.session.reconcile();
  assert.equal(f.calls.at(-1)[0], 'reconcile');
  assert.equal(f.session.state.operation.state, 'submitted', 'reconcile acceptance is not fabricated confirmation');
  f.setOperation({ operationId: 'deposit', kind: 'deposit', state: 'confirmed' });
  await f.session.refresh(); assert.equal(f.session.state.operation.state, 'confirmed');
  assert.equal(custodyActions(f.session.state).deposit, true);
  assert.equal(custodyActions(f.session.state).poll, false);
});

test('missing capability and mismatched profile stop before connect', async () => {
  for (const caps of [
    { methods: depositMethods.slice(0, -1), networks: [] },
    { methods: depositMethods, networks: [{ networkId: 'local', chainId: 'eip155:815', profileDigest: 'wrong' }] }
  ]) {
    const f = fixture({ client: { getCapabilities: async () => caps } });
    await f.session.connectWallet(); await assert.rejects(f.session.connectCustody()); assert.deepEqual(f.calls, []);
  }
});

test('lost mutation response blocks another deposit instead of creating a new idempotency key', async () => {
  let deposits = 0;
  const f = fixture({ client: { prepareDeposit: async () => { deposits++; throw new Error('Timeout'); } } });
  await f.connect(); await assert.rejects(f.session.deposit('7')); await assert.rejects(f.session.deposit('7'));
  assert.equal(deposits, 1); assert.equal(f.session.state.uncertain, true);
  assert.equal(custodyActions(f.session.state).deposit, false);
});

test('wallet account change blocks preparation and revokes the connection', async () => {
  let switched = false;
  const f = fixture({ wallet: { getActor: async () => switched ? { ...f.actor, address: '0x' + '22'.repeat(20) } : f.actor } });
  await f.connect(); switched = true; await assert.rejects(f.session.deposit('7'));
  assert.equal(f.session.state.invalidated, true); assert.equal(f.calls.filter(x => x[0] === 'deposit').length, 0);
});

test('invalidation fences a late response and leaves no restored connection', async () => {
  let resolve;
  const f = fixture({ client: { connect: () => new Promise(r => { resolve = r; }) } });
  await f.session.connectWallet(); const pending = f.session.connectCustody();
  await new Promise(r => setImmediate(r)); f.provider.invalidate(); resolve({ operationId: 'stale', state: 'awaiting_approval' });
  await assert.rejects(pending); assert.equal(f.session.state.operation, null); assert.equal(f.session.state.connection, null);
});

test('concurrent mutation, unsupported amounts and wrong approval actor are rejected', async () => {
  const f = fixture(); await f.connect();
  for (const amount of ['0', '-1', '1.2', '1000', '01', '1e2']) await assert.rejects(f.session.deposit(amount));
  const pending = f.session.deposit('7'); await assert.rejects(f.session.deposit('8')); await pending;
  assert.equal(f.calls.filter(x => x[0] === 'deposit').length, 1);
  const wrong = fixture(); await wrong.session.connectWallet(); await wrong.session.connectCustody();
  wrong.setOperation({ operationId: 'connect', kind: 'connect', state: 'completed', connection: { ...wrong.connection, chainActors: [] } });
  await assert.rejects(wrong.session.refresh()); assert.equal(wrong.session.state.connection, null);
});

test('uncertain submission never enables a second wallet dispatch', async () => {
  let submissions = 0;
  const f = fixture({ client: { submit: async () => { submissions++; throw new Error('Unknown'); } } }); await f.connect(); await f.session.deposit('7');
  f.setOperation({ operationId: 'deposit', kind: 'deposit', state: 'awaiting_chain_signature' }); await f.session.refresh();
  await assert.rejects(f.session.submit()); await assert.rejects(f.session.submit()); assert.equal(submissions, 1);
  await assert.rejects(f.session.cancel());
});

test('missing or unprepared extension is explained before any RPC or new authorization', async () => {
  const cases = { missing: '확장 응답', closed: '작업창이 닫혀', setup_required: '계정 설정이 필요', preparing: '준비 중', failed: '준비가 실패', unavailable: '연결이 끊겼' };
  for (const [workbench, message] of Object.entries(cases)) {
    let discovery = 0;
    const f = fixture({ checkAvailability: async () => ({ workbench }), client: { getCapabilities: async () => { discovery++; } } });
    await f.session.connectWallet(); await assert.rejects(f.session.connectCustody());
    assert.ok(f.session.state.error.includes(message), workbench);
    assert.equal(discovery, 0); assert.equal(f.calls.length, 0); assert.equal(f.session.state.uncertain, false);
  }
});

test('4112 after dispatch explains timeout/limit and preserves the uncertain-request fence', async () => {
  let requests = 0;
  const f = fixture({ client: { connect: async () => { requests++; throw Object.assign(new Error('RESOURCE_LIMIT'), { code: 4112 }); } } });
  await f.session.connectWallet(); await assert.rejects(f.session.connectCustody());
  assert.match(f.session.state.error, /응답 시간이 초과/);
  assert.equal(f.session.state.uncertain, true); await assert.rejects(f.session.connectCustody()); assert.equal(requests, 1);
  assert.equal(custodyActions(f.session.state).connect, false);
});

test('UI actions and command admission agree across deposit preparation, signing and unknown submission', async () => {
  const f = fixture();
  await f.connect();
  await f.session.deposit('7');
  f.setOperation({ operationId: 'deposit', kind: 'deposit', state: 'awaiting_approval' });
  await f.session.refresh();
  assert.equal(custodyActions(f.session.state).cancel, true);
  await f.session.cancel();
  assert.equal(custodyActions(f.session.state).deposit, true);

  for (const state of ['preparing', 'awaiting_chain_signature', 'submission_unknown', 'submitted', 'failed', 'expired']) {
    f.setOperation({ operationId: 'deposit', kind: 'deposit', state });
    await f.session.refresh();
    const actions = custodyActions(f.session.state);
    assert.equal(actions.deposit, false, state);
    assert.equal(actions.cancel, false, state);
    assert.equal(actions.submit, state === 'awaiting_chain_signature', state);
    assert.equal(actions.reconcile, ['submission_unknown', 'submitted'].includes(state), state);
    assert.equal(actions.poll, !['failed', 'expired'].includes(state), state);
    await assert.rejects(f.session.deposit('7'));
    await assert.rejects(f.session.cancel());
    if (!actions.submit) await assert.rejects(f.session.submit());
    if (!actions.reconcile) await assert.rejects(f.session.reconcile());
  }
  assert.equal(f.calls.filter(([method]) => method === 'deposit').length, 1);
  assert.equal(f.calls.some(([method]) => ['submit', 'reconcile'].includes(method)), false);
});
