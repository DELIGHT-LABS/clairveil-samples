import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustodySession, depositMethods, fullFlowMethods } from '../public/custody-session.js';
import { custodyActions, canResetCustodySession } from '../public/custody-state.js';

function fixture(overrides = {}) {
  const actor = { namespace: 'eip155', chainId: '0x32f', address: '0x' + '11'.repeat(20) };
  const profile = { id: 'local', transport: 'evm', chainId: 'maroo-zerofee-2', evmChainId: '0x32f', caip: 'eip155:815', profileDigest: 'digest', denom: 'aokrw' };
  const listeners = new Set(), calls = [];
  const provider = { onInvalidation(fn) { listeners.add(fn); return () => listeners.delete(fn); }, invalidate() { for (const fn of listeners) fn(); } };
  const connection = { permissions: ['deposit.request'], chainActors: [{ accountId: `${profile.caip}:${actor.address}`, chainActorHandle: 'C'.repeat(42) + 'A' }], sessionHandle: 'S'.repeat(42) + 'A', accountHandle: 'A'.repeat(43), networkHandle: 'N'.repeat(42) + 'A' };
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
  const session = createCustodySession({ client, provider, wallet, profile, now: overrides.now, onChange: overrides.onChange });
  return { session, provider, calls, actor, connection, client, setOperation: value => { operation = value; },
    async connect() { await session.connectWallet(); await session.connectCustody(); await session.refresh(); } };
}

test('custody flow requests deposit permission and submits once through the SDK coordinator', async () => {
  const f = fixture(); await f.connect();
  await f.session.deposit('7');
  assert.equal(f.calls[0][1].permissions.join(), 'deposit.request');
  assert.equal(f.calls[1][1].protocol.amountBaseUnits, '7');
  assert.equal(f.calls[1][1].chainActorHandle, f.connection.chainActors[0].chainActorHandle);
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

test('unavailable pending connection stops polling and allows explicit fresh consent without granting deposit', async () => {
  const f = fixture(); await f.session.connectWallet(); await f.session.connectCustody();
  const original = f.session.state.operation;
  f.client.getOperation = async () => { throw Object.assign(new Error('Unauthorized'), { code: 4103 }); };
  await assert.rejects(f.session.refresh(), { code: 4103 });
  assert.equal(f.session.state.connectionUnavailable, true);
  assert.deepEqual(f.session.state.operation, original, 'retain the last host snapshot without inventing a terminal state');
  assert.equal(custodyActions(f.session.state).poll, false);
  assert.equal(custodyActions(f.session.state).connect, true);
  assert.equal(custodyActions(f.session.state).deposit, false);
  assert.equal(canResetCustodySession(f.session.state), true);
  assert.match(f.session.state.error, /연결.*다시/);
  assert.equal(f.calls.filter(([kind]) => kind === 'connect').length, 1, 'no automatic retry');
  await f.session.connectCustody();
  assert.equal(f.session.state.connectionUnavailable, false);
  assert.equal(custodyActions(f.session.state).connect, false);
  assert.equal(custodyActions(f.session.state).deposit, false);
  assert.equal(f.calls.filter(([kind]) => kind === 'connect').length, 2);
  assert.notEqual(f.calls[0][1].idempotencyKey, f.calls[1][1].idempotencyKey);
});

test('only a definitive unauthorized connection lookup releases consent retry, never unknown or chain work', async () => {
  for (const code of [4104, 4112, undefined]) {
    const f = fixture(); await f.session.connectWallet(); await f.session.connectCustody();
    f.client.getOperation = async () => { throw Object.assign(new Error('Unavailable'), { code }); };
    await assert.rejects(f.session.refresh());
    assert.equal(custodyActions(f.session.state).connect, false);
    assert.equal(canResetCustodySession(f.session.state), false);
  }
  const renewal = fixture(); await renewal.session.connectWallet(); await renewal.session.connectCustody();
  renewal.client.getOperation = async () => { throw Object.assign(new Error('Unauthorized'), { code: 4103 }); };
  await assert.rejects(renewal.session.refresh());
  renewal.client.connect = async () => { throw Object.assign(new Error('Lost renewal reply'), { code: 4112 }); };
  await assert.rejects(renewal.session.connectCustody());
  assert.equal(renewal.session.state.connectionUnavailable, false);
  assert.equal(renewal.session.state.uncertain, true);
  assert.equal(custodyActions(renewal.session.state).connect, false);
  assert.equal(canResetCustodySession(renewal.session.state), false);
  assert.doesNotMatch(renewal.session.state.error, /Request custody connection을 다시/);
  const f = fixture(); await f.connect(); await f.session.deposit('7');
  f.client.getOperation = async () => { throw Object.assign(new Error('Unauthorized'), { code: 4103 }); };
  await assert.rejects(f.session.refresh(), { code: 4103 });
  assert.equal(f.session.state.invalidated, true);
  assert.equal(custodyActions(f.session.state).connect, false);
  assert.equal(canResetCustodySession(f.session.state), false);
  assert.equal(f.session.state.operation.operationId, 'deposit');
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

test('deposit checks its live connection before presenting or dispatching and leaves expired consent resettable', async () => {
  for (const failure of ['expired', 'revoked', 'locked']) {
    const f = fixture(); await f.connect();
    const before = f.session.state.operation;
    let presented = 0, reads = 0;
    if (failure === 'expired') f.connection.expiresAtUnix = String(Math.floor(Date.now() / 1000) - 1);
    f.client.getOperation = async () => { reads++; throw Object.assign(new Error(failure), { code: failure === 'locked' ? 4104 : 4103 }); };
    await assert.rejects(f.session.deposit('7', { beforeRequest: async () => { presented++; } }));
    assert.equal(presented, 0); assert.equal(f.calls.filter(([kind]) => kind === 'deposit').length, 0);
    assert.equal(f.session.state.uncertain, false); assert.equal(f.session.state.invalidated, true);
    assert.deepEqual(f.session.state.operation, before);
    assert.equal(canResetCustodySession(f.session.state), true);
    if (failure === 'expired') assert.equal(reads, 0);
  }
});

test('deposit connection preflight fences late replies while authorization loss after dispatch remains uncertain', async () => {
  const f = fixture(); await f.connect();
  let resolve, presented = 0;
  f.client.getOperation = () => new Promise(done => { resolve = done; });
  const pending = f.session.deposit('7', { beforeRequest: async () => { presented++; } });
  await new Promise(done => setImmediate(done));
  f.provider.invalidate(); resolve({ operationId: 'connect', kind: 'connect', state: 'completed', connection: f.connection });
  await assert.rejects(pending);
  assert.equal(presented, 0); assert.equal(f.calls.filter(([kind]) => kind === 'deposit').length, 0);
  assert.equal(f.session.state.connection, null);
  for (const code of [4103, 4104, 4112]) {
    const uncertain = fixture({ client: { prepareDeposit: async () => { throw Object.assign(new Error('After dispatch'), { code }); } } });
    await uncertain.connect(); await assert.rejects(uncertain.session.deposit('7'));
    assert.equal(uncertain.session.state.uncertain, true);
    assert.equal(canResetCustodySession(uncertain.session.state), false);
  }
});

test('backup rejection before deposit admission permits an explicit retry without losing the approved connection', async () => {
  const requests = [];
  let verified = false;
  const f = fixture({ client: { prepareDeposit: async params => {
    requests.push(params);
    if (!verified) throw Object.assign(new Error('BACKUP_REQUIRED'), { code: 4114 });
    return { operationId: 'deposit', state: 'awaiting_approval' };
  } } });
  await f.connect();
  const prior = f.session.state.operation;
  await assert.rejects(f.session.deposit('7'), { code: 4114 });
  assert.equal(f.session.state.uncertain, false);
  assert.deepEqual(f.session.state.operation, prior);
  assert.deepEqual(f.session.state.connection, f.connection);
  assert.equal(custodyActions(f.session.state).deposit, true);
  assert.equal(canResetCustodySession(f.session.state), true);
  assert.match(f.session.state.error, /저장한 백업 확인/);
  assert.equal(requests.length, 1, 'backup rejection never retries automatically');
  verified = true;
  await f.session.deposit('7');
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].idempotencyKey, requests[1].idempotencyKey);
  assert.equal(f.session.state.operation.kind, 'deposit');
  assert.equal(custodyActions(f.session.state).deposit, false);
  assert.equal(f.calls.some(([kind]) => kind === 'submit'), false);
});

test('backup retry exception never releases unknown deposit outcomes or a late invalidated response', async () => {
  for (const error of [new Error('Timeout'), ...[4112, 4113].map(code => Object.assign(new Error('Unavailable'), { code })),
    Object.assign(new Error('Unexpected operation binding'), { code: 4114, data: { operationId: 'unknown-deposit' } })]) {
    const f = fixture({ client: { prepareDeposit: async () => { throw error; } } });
    await f.connect(); await assert.rejects(f.session.deposit('7'));
    assert.equal(f.session.state.uncertain, true);
    assert.equal(custodyActions(f.session.state).deposit, false);
    assert.equal(canResetCustodySession(f.session.state), false);
  }
  let reject;
  const f = fixture({ client: { prepareDeposit: () => new Promise((_, failed) => { reject = failed; }) } });
  await f.connect();
  const pending = f.session.deposit('7');
  await new Promise(resolve => setImmediate(resolve));
  f.provider.invalidate();
  reject(Object.assign(new Error('BACKUP_REQUIRED'), { code: 4114 }));
  await assert.rejects(pending);
  assert.equal(f.session.state.uncertain, true);
  assert.equal(f.session.state.invalidated, true);
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
  for (const amount of ['0', '-1', '1.2', '18446744073709551616', '01', '1e2']) await assert.rejects(f.session.deposit(amount));
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

test('background confirmation reconciles the existing attempt with bounded backoff and never signs again', async () => {
  let time = 0;
  const f = fixture({ now: () => time }); await f.connect(); await f.session.deposit('7');
  const pending = { operationId: 'deposit', kind: 'deposit', state: 'submission_unknown', statusRevision: '3',
    submissionAttempt: { attemptId: 'attempt', state: 'unresolved' }, jobState: 'queued' };
  f.setOperation(pending);
  await f.session.poll();
  assert.equal(f.calls.filter(([name]) => name === 'reconcile').length, 1);
  assert.equal(f.session.state.operation.state, 'submission_unknown', 'a reconciliation ACK is not confirmation');
  for (let i = 0; i < 5; i++) await f.session.poll();
  assert.equal(f.calls.filter(([name]) => name === 'reconcile').length, 1, 'no tight reconciliation loop');
  time = 5000; f.setOperation({ ...pending, jobState: 'running' }); await f.session.poll();
  assert.equal(f.calls.filter(([name]) => name === 'reconcile').length, 1, 'same-revision running job suppresses duplicate scheduling');
  f.setOperation(pending);
  for (let i = 0; i < 10; i++) { time += 30000; await f.session.poll(); }
  assert.equal(f.calls.filter(([name]) => name === 'reconcile').length, 6, 'automatic checks have a finite budget');
  assert.equal(f.session.state.reconciliationExhausted, true);
  assert.equal(custodyActions(f.session.state).deposit, false);
  assert.equal(custodyActions(f.session.state).submit, false);
  assert.equal(f.calls.filter(([name]) => name === 'submit').length, 0);
  await f.session.reconcile();
  assert.equal(f.calls.filter(([name]) => name === 'reconcile').length, 7, 'explicit inspection stays available');
  f.setOperation({ ...pending, state: 'confirmed', statusRevision: '4', transactionHash: 'a'.repeat(64) });
  await f.session.poll();
  assert.equal(f.session.state.operation.state, 'confirmed');
  assert.equal(f.session.state.reconciliationExhausted, false);
});

test('background reads coalesce while a foreground action waits and rechecks the newest status', async () => {
  const f = fixture(); await f.connect(); await f.session.deposit('7');
  f.setOperation({ operationId: 'deposit', kind: 'deposit', state: 'awaiting_chain_signature', statusRevision: '2' });
  await f.session.refresh();
  let resolve, reads = 0;
  f.client.getOperation = () => { reads++; return new Promise(done => { resolve = done; }); };
  const poll = f.session.poll(), duplicate = f.session.poll();
  assert.equal(f.session.state.busy, false, 'background status read is not a user action');
  const submit = f.session.submit();
  assert.equal(f.session.state.busy, true);
  resolve({ operationId: 'deposit', kind: 'deposit', state: 'confirmed', statusRevision: '3' });
  await Promise.all([poll, duplicate]);
  await assert.rejects(submit, /서명 준비/);
  assert.equal(reads, 1);
  assert.equal(f.calls.filter(([name]) => name === 'submit').length, 0, 'a click cannot dispatch against stale state');
});

test('background confirmation fences invalidated replies and never reconciles missing attempts or approval work', async () => {
  for (const state of ['awaiting_approval', 'awaiting_chain_signature', 'submission_unknown']) {
    const f = fixture(); await f.connect(); await f.session.deposit('7');
    f.setOperation({ operationId: 'deposit', kind: 'deposit', state }); await f.session.poll();
    assert.equal(f.calls.some(([name]) => name === 'reconcile'), false);
  }
  const f = fixture(); await f.connect(); await f.session.deposit('7');
  let resolve;
  f.client.getOperation = () => new Promise(done => { resolve = done; });
  const poll = f.session.poll(); f.provider.invalidate();
  resolve({ operationId: 'deposit', kind: 'deposit', state: 'submission_unknown', submissionAttempt: { attemptId: 'attempt' } });
  await assert.rejects(poll);
  assert.equal(f.session.state.invalidated, true);
  assert.equal(f.session.state.operation.state, 'awaiting_approval');
  assert.equal(f.calls.some(([name]) => name === 'reconcile'), false);
});

test('CC-004 locked vault is explained after read-only discovery without new authorization', async () => {
  const f = fixture({ client: { getCapabilities: async () => { throw Object.assign(new Error('VAULT_LOCKED'), { code: 4104 }); } } });
  await f.session.connectWallet(); await assert.rejects(f.session.connectCustody());
  assert.match(f.session.state.error, /금고/);
  assert.equal(f.calls.length, 0); assert.equal(f.session.state.uncertain, false);
});

test('4112 after dispatch explains timeout/limit and preserves the uncertain-request fence', async () => {
  let requests = 0;
  const f = fixture({ client: { connect: async () => { requests++; throw Object.assign(new Error('RESOURCE_LIMIT'), { code: 4112 }); } } });
  await f.session.connectWallet(); await assert.rejects(f.session.connectCustody());
  assert.match(f.session.state.error, /응답 시간이 초과/);
  assert.equal(f.session.state.uncertain, true); await assert.rejects(f.session.connectCustody()); assert.equal(requests, 1);
  assert.equal(custodyActions(f.session.state).connect, false);
});

test('4105 explains restored-vault restrictions without retrying or invoking the wallet', async () => {
  let preparations = 0, submissions = 0;
  const f = fixture({ client: {
    prepareDeposit: async () => { preparations++; throw Object.assign(new Error('RECOVERY_REQUIRED'), { code: 4105 }); },
    submit: async () => { submissions++; }
  } });
  await f.connect(); await assert.rejects(f.session.deposit('7'));
  assert.match(f.session.state.error, /복구 제한/);
  assert.match(f.session.state.error, /지원하는 프로필의 새 입금은 별도 승인 후 가능/);
  assert.match(f.session.state.error, /백업 검증이나 스캔만으로는 이 제한이 해제되지 않습니다/);
  await assert.rejects(f.session.deposit('7')); await assert.rejects(f.session.submit());
  assert.equal(preparations, 1); assert.equal(submissions, 0);
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


test('balance permission is explicit, capability-gated and clears stale data on failure', async () => {
  const f = fixture(); await f.session.connectWallet();
  await assert.rejects(f.session.connectCustody({ readBalances: true }), /잔액 조회/);
  assert.equal(f.calls.length, 0);
  await f.session.connectCustody(); await f.session.refresh();
  await assert.rejects(f.session.balances(), /권한/);
  f.connection.permissions.push('balance.read');
  f.client.getBalances = async () => ({ syncStatus: 'current', rows: [{ assetDenom: 'aokrw', verificationState: 'verified', spendableBaseUnits: '7', reservedBaseUnits: '0' }] });
  await f.session.balances(); assert.equal(f.session.state.balances.rows[0].spendableBaseUnits, '7');
  f.client.getBalances = async () => { throw new Error('Synthetic read failure'); };
  await assert.rejects(f.session.balances()); assert.equal(f.session.state.balances, null);
});

function fullFixture() {
  const f = fixture();
  f.client.getCapabilities = async () => ({ methods: [...depositMethods, ...fullFlowMethods], networks: [{ networkId: 'local', chainId: 'eip155:815', profileDigest: 'digest' }] });
  f.client.connect = async params => { f.connection.permissions = params.permissions; f.connection.recoveryAccess = params.recoveryAccess; if (params.recoveryAccess) f.connection.chainActors = []; f.calls.push(['connect', params]); return { operationId: 'connect', state: 'awaiting_approval' }; };
  f.client.getPublicAccount = async () => ({ protocol: { shieldedAddress: 'clairs1qqqqqqqq' } });
  f.client.authorizeTransfer = async params => { f.calls.push(['transfer', params]); return { operationId: 'transfer', state: 'awaiting_approval' }; };
  f.client.authorizeWithdraw = async params => { f.calls.push(['withdraw', params]); return { operationId: 'withdraw', state: 'awaiting_approval' }; };
  f.client.requestDisclosure = async params => { f.calls.push(['disclosure', params]); return { operationId: 'disclosure', state: 'awaiting_approval' }; };
  f.connectFull = async () => { await f.session.connectWallet(); await f.session.connectCustody({ fullFlow: true }); await f.session.refresh(); };
  return f;
}

test('full flow is explicitly negotiated; self-transfer uses only the granted public address', async () => {
  const f = fullFixture(); await f.connectFull();
  assert.deepEqual(f.calls[0][1].permissions, ['deposit.request', 'balance.read', 'account.read', 'transfer.request', 'withdraw.request', 'disclosure.request']);
  await assert.rejects(f.session.transfer('7'));
  await f.session.publicAccount(); await f.session.transfer('7');
  const request = f.calls.at(-1)[1];
  assert.equal(request.protocol.recipientShieldedAddress, 'clairs1qqqqqqqq');
  assert.deepEqual(request.protocol.disclosure, { policy: 'all-private', mode: 'none' });
  assert.equal(request.protocol.selfViewEnabled, true);
  assert.equal(f.calls.some(([method]) => method === 'submit'), false);
});

test('local spend schema errors are correctable without dispatch or an uncertain session', async () => {
  const f = fullFixture(); await f.connectFull(); await f.session.publicAccount();
  await assert.rejects(f.session.transfer('7', { recipientShieldedAddress: 'not-a-shielded-address' }), { code: -32602 });
  await assert.rejects(f.session.withdraw('7', { recipientAddress: 'a'.repeat(513) }), { code: -32602 });
  assert.equal(f.calls.filter(([method]) => ['transfer', 'withdraw'].includes(method)).length, 0);
  assert.equal(f.session.state.uncertain, false);
  assert.equal(custodyActions(f.session.state).deposit, true);
  assert.equal(custodyActions(f.session.state).disclosure, true);
  await f.session.transfer('7', { recipientShieldedAddress: 'clairs1pppppppp' });
  assert.equal(f.calls.filter(([method]) => method === 'transfer').length, 1);
});

test('spend errors after dispatch preserve uncertainty even for a remote invalid-params error', async () => {
  for (const error of [new Error('Lost reply'), Object.assign(new Error('Remote invalid params'), { code: -32602 })]) {
    const f = fullFixture(); await f.connectFull(); await f.session.publicAccount();
    let calls = 0; f.client.authorizeTransfer = async () => { calls++; throw error; };
    await assert.rejects(f.session.transfer('7'));
    assert.equal(f.session.state.uncertain, true);
    await assert.rejects(f.session.transfer('7')); assert.equal(calls, 1);
  }
});

test('transfer helper and final child each require one explicit submission; parent remains authoritative', async () => {
  const f = fullFixture(); await f.connectFull(); await f.session.publicAccount(); await f.session.transfer('7');
  let child = 'helper', revision = '1', phase = 'awaiting_chain_signature';
  f.client.getOperation = async ({ operationId }) => operationId === 'transfer'
    ? { operationId, kind: 'transfer', state: 'preparing', statusRevision: revision, steps: [{ operationId: child, stepKind: child === 'helper' ? 'zero_helper' : 'final_transfer', state: phase }] }
    : { operationId, parentOperationId: 'transfer', kind: child === 'helper' ? 'zero_helper' : 'final_transfer', state: phase, statusRevision: revision };
  await f.session.refresh(); assert.equal(f.session.state.activeOperation.operationId, 'helper');
  await f.session.submit(); await assert.rejects(f.session.submit());
  revision = '2'; phase = 'confirmed'; await f.session.refresh();
  assert.equal(f.session.state.operation.state, 'preparing'); assert.equal(custodyActions(f.session.state).deposit, false);
  child = 'final'; revision = '3'; phase = 'awaiting_chain_signature'; await f.session.refresh();
  await f.session.submit(); await assert.rejects(f.session.submit());
  assert.deepEqual(f.calls.filter(([method]) => method === 'submit').map(([, params]) => params.operation.operationId), ['helper', 'final']);
});

test('older revisions and mismatched operation replies cannot regress or authorize submission', async () => {
  const f = fullFixture(); await f.connectFull(); await f.session.deposit('7');
  f.setOperation({ operationId: 'deposit', kind: 'deposit', state: 'submitted', statusRevision: '9' }); await f.session.refresh();
  f.setOperation({ operationId: 'deposit', kind: 'deposit', state: 'awaiting_chain_signature', statusRevision: '8' }); await f.session.refresh();
  assert.equal(f.session.state.operation.state, 'submitted'); await assert.rejects(f.session.submit());
  f.setOperation({ operationId: 'unrelated', kind: 'deposit', state: 'awaiting_chain_signature', statusRevision: '10' });
  await assert.rejects(f.session.refresh(), /응답 작업/); assert.equal(f.session.state.operation.state, 'submitted');
});

test('withdraw is exact intent to the current ordinary actor and disclosure defaults to amount', async () => {
  const f = fullFixture(); await f.connectFull(); await f.session.withdraw('7');
  const withdraw = f.calls.at(-1)[1]; assert.equal(withdraw.protocol.recipientAddress, f.actor.address);
  assert.equal(withdraw.protocol.amountBaseUnits, '7'); assert.equal(withdraw.protocol.recipientShieldedAddress, undefined);
  f.setOperation({ operationId: 'withdraw', kind: 'withdraw', state: 'confirmed' }); await f.session.refresh();
  await f.session.disclosure({ transactionHash: 'ab'.repeat(32), plane: 'self_view', delivery: 'page' });
  assert.deepEqual(f.calls.at(-1)[1].requestedFields, ['amount']);
  assert.equal(f.calls.at(-1)[1].protocol.transactionHash, '0x' + 'ab'.repeat(32));
  assert.equal(f.calls.at(-1)[1].delivery, 'page'); assert.equal(f.calls.some(([method]) => method === 'submit'), false);
});

test('invalid disclosure fields remain correctable before dispatch', async () => {
  const f = fullFixture(); await f.connectFull();
  for (const requestedFields of [[], ['unknown'], ['from', 'from'], ['amount', 'from', 'to', 'extra']]) {
    await assert.rejects(f.session.disclosure({ transactionHash: 'ab'.repeat(32), requestedFields }), { code: -32602 });
    assert.equal(f.session.state.uncertain, false);
  }
  assert.equal(f.calls.some(([kind]) => kind === 'disclosure'), false);
  await f.session.disclosure({ transactionHash: 'ab'.repeat(32), requestedFields: ['from', 'to'] });
  assert.deepEqual(f.calls.at(-1)[1].requestedFields, ['from', 'to']);
});

test('known terminal consent operations can reset without clearing uncertain or chain authority', () => {
  for (const kind of ['connect', 'disclosure']) for (const terminal of ['failed', 'expired']) {
    const state = { actor: {}, operation: { kind, state: terminal }, uncertain: false, submissionAttempted: false };
    assert.equal(canResetCustodySession(state), true);
    assert.equal(custodyActions(state).connect, kind === 'connect');
    for (const change of [{ uncertain: true }, { busy: true }, { submissionAttempted: true },
      { operation: { ...state.operation, publicArtifact: {} } }, { operation: { ...state.operation, submissionAttempt: {} } }]) {
      assert.equal(canResetCustodySession({ ...state, ...change }), false);
    }
  }
  for (const kind of ['deposit', 'transfer', 'withdraw']) {
    const state = { actor: {}, connection: { permissions: ['deposit.request', 'transfer.request', 'withdraw.request', 'disclosure.request'] }, operation: { kind, state: 'failed' } };
    assert.equal(canResetCustodySession(state), false);
    for (const action of ['deposit', 'transfer', 'withdraw', 'disclosure']) assert.equal(custodyActions(state)[action], false);
  }
});

test('privacy requests accept protocol uint64 amounts without rounding or preview limits', async () => {
  for (const method of ['deposit', 'transfer', 'withdraw']) {
    for (const amount of ['1000', '9007199254740993', '18446744073709551615']) {
      const f = fullFixture(); await f.connectFull(); await f.session.publicAccount();
      await f.session[method](amount);
      assert.equal(f.calls.at(-1)[1].protocol.amountBaseUnits, amount, method);
    }
    const f = fullFixture(); await f.connectFull(); await f.session.publicAccount();
    for (const amount of ['18446744073709551616', '1'.repeat(80), '1.0', '0', '-1', '01']) {
      await assert.rejects(f.session[method](amount), /정수/);
      assert.equal(f.session.state.uncertain, false);
    }
    assert.equal(f.calls.some(([kind]) => kind === method), false);
  }
});

test('exact-note preparation and withdrawal resumption require separate explicit requests', async () => {
  const f = fullFixture(); await f.connectFull();
  const recipient = '0x' + '22'.repeat(20);
  await f.session.withdraw('1000', { recipientAddress: recipient });
  f.setOperation({ operationId: 'withdraw', kind: 'withdraw', state: 'failed', failure: { code: 4202 } }); await f.session.refresh();
  assert.equal(custodyActions(f.session.state).prepareWithdraw, true);
  assert.equal(f.calls.some(([kind]) => kind === 'transfer'), false);
  await f.session.prepareWithdrawNote();
  assert.deepEqual(f.calls.at(-1)[1].protocol.disclosure, { policy: 'all-private', mode: 'none' });
  assert.equal(f.calls.at(-1)[1].protocol.recipientShieldedAddress, 'clairs1qqqqqqqq');
  assert.equal(f.calls.at(-1)[1].protocol.amountBaseUnits, '1000');
  await assert.rejects(f.session.resumeWithdraw());
  f.client.getOperation = async ({ operationId }) => operationId === 'transfer'
    ? { operationId, kind: 'transfer', state: 'preparing', steps: [{ operationId: 'helper', state: 'confirmed' }] }
    : { operationId, parentOperationId: 'transfer', kind: 'zero_helper', state: 'confirmed' };
  await f.session.refresh(); await assert.rejects(f.session.resumeWithdraw());
  f.client.getOperation = async () => ({ operationId: 'transfer', kind: 'transfer', state: 'confirmed' });
  await f.session.refresh();
  assert.equal(f.calls.filter(([kind]) => kind === 'withdraw').length, 1, 'polling must not request another withdrawal');
  await f.session.resumeWithdraw();
  assert.equal(f.calls.at(-1)[1].protocol.recipientAddress, recipient);
  assert.equal(f.calls.at(-1)[1].protocol.amountBaseUnits, '1000');
  assert.equal(f.calls.some(([kind]) => kind === 'submit'), false);
});

test('unresolved failure and exported authority never enable withdrawal preparation or session reset', async () => {
  for (const extra of [{ failure: { code: 4201 } }, { submissionAttempt: { state: 'unresolved' } }, { publicArtifact: {} }]) {
    const f = fullFixture(); await f.connectFull(); await f.session.withdraw('1');
    f.setOperation({ operationId: 'withdraw', kind: 'withdraw', state: 'failed', failure: { code: 4202 }, ...extra }); await f.session.refresh();
    assert.equal(custodyActions(f.session.state).prepareWithdraw, false);
    await assert.rejects(f.session.prepareWithdrawNote()); await assert.rejects(f.session.disconnect());
    assert.equal(f.calls.some(([kind]) => kind === 'transfer'), false);
  }
});

test('malformed disclosure hashes remain correctable before dispatch or uncertainty', async () => {
  const f = fullFixture(); await f.connectFull();
  for (const transactionHash of ['', 'ab'.repeat(31), '0x' + 'ab'.repeat(33), '0x' + 'gg'.repeat(32)]) {
    await assert.rejects(f.session.disclosure({ transactionHash }), /거래 해시/);
    assert.equal(f.calls.some(([method]) => method === 'disclosure'), false);
    assert.equal(f.session.state.uncertain, false);
    assert.equal(custodyActions(f.session.state).disclosure, true);
    assert.equal(custodyActions(f.session.state).deposit, true);
  }
  await f.session.disclosure({ transactionHash: 'AB'.repeat(32) });
  assert.equal(f.calls.at(-1)[1].protocol.transactionHash, '0x' + 'ab'.repeat(32));
});

test('recovery connection scopes prior operations and cannot create or submit new work', async () => {
  const f = fullFixture(), id = 'A'.repeat(43);
  await f.session.connectWallet(); await f.session.connectCustody({ recoveryOperationIds: [id] }); await f.session.refresh();
  assert.deepEqual(f.calls[0][1].permissions, []);
  assert.equal(f.calls[0][1].chainActor, undefined);
  f.setOperation({ operationId: id, kind: 'deposit', state: 'reconciliation_required', accessMode: 'recovery-only', runtimeState: 'recovery_required' });
  await f.session.inspectRecovery(id); assert.equal(f.session.state.recoveryRequired, true);
  await assert.rejects(f.session.inspectRecovery('B'.repeat(43)));
  await assert.rejects(f.session.deposit('7')); await assert.rejects(f.session.transfer('7')); await assert.rejects(f.session.withdraw('7')); await assert.rejects(f.session.submit());
  await f.session.reconcile(); assert.equal(f.calls.at(-1)[1].operationId, id);
});

test('invalid recovery IDs never dispatch or fence a corrected connection request', async () => {
  for (const operationIds of [['B'.repeat(43)], ['A'.repeat(43), 'A'.repeat(43)]]) {
    const f = fullFixture(); await f.session.connectWallet();
    await assert.rejects(f.session.connectCustody({ recoveryOperationIds: operationIds }), { code: -32602 });
    assert.equal(f.calls.length, 0);
    assert.equal(f.session.state.uncertain, false); assert.equal(f.session.state.operation, null);
    assert.equal(custodyActions(f.session.state).connect, true);
    await f.session.connectCustody({ recoveryOperationIds: ['A'.repeat(43)] }); await f.session.refresh();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.session.state.connection.recoveryAccess.operationIds, ['A'.repeat(43)]);
  }
});

test('automatic recovery inspection stays within the newly approved operation and has no signing authority', async () => {
  const f = fullFixture(), id = 'A'.repeat(43);
  await f.session.connectWallet(); await f.session.connectCustody({ recoveryOperationIds: [id] }); await f.session.refresh();
  f.setOperation({ operationId: id, kind: 'deposit', state: 'submission_unknown', statusRevision: '5',
    accessMode: 'recovery-only', submissionAttempt: { attemptId: 'attempt', state: 'unresolved' } });
  await f.session.inspectRecovery(id); await f.session.poll();
  assert.equal(f.calls.filter(([name]) => name === 'reconcile').length, 1);
  assert.equal(f.calls.at(-1)[1].operationId, id);
  assert.equal(custodyActions(f.session.state).deposit, false);
  assert.equal(custodyActions(f.session.state).submit, false);
  f.provider.invalidate(); await f.session.poll();
  assert.equal(f.calls.filter(([name]) => name === 'reconcile').length, 1);
});

test('lost reconciliation responses consume the automatic budget and never release submission barriers', async () => {
  let time = 0, requests = 0;
  const f = fixture({ now: () => time, client: { reconcile: async () => { requests++; throw new Error('Lost inspection acknowledgement'); } } });
  await f.connect(); await f.session.deposit('7');
  f.setOperation({ operationId: 'deposit', kind: 'deposit', state: 'submission_unknown', statusRevision: '3',
    submissionAttempt: { attemptId: 'attempt', state: 'unresolved' } });
  for (let i = 0; i < 6; i++) { await assert.rejects(f.session.poll()); time += 30000; }
  await f.session.poll();
  assert.equal(requests, 6);
  assert.equal(f.session.state.reconciliationExhausted, true);
  assert.equal(canResetCustodySession(f.session.state), false);
  assert.equal(custodyActions(f.session.state).submit, false);
  assert.equal(f.session.state.operation.state, 'submission_unknown');
});

test('a recovery connection error after dispatch retains its unknown-request fence', async () => {
  const f = fullFixture(); await f.session.connectWallet(); let calls = 0;
  f.client.connect = async () => { calls++; throw Object.assign(new Error('Remote rejection'), { code: -32602 }); };
  await assert.rejects(f.session.connectCustody({ recoveryOperationIds: ['A'.repeat(43)] }));
  assert.equal(f.session.state.uncertain, true);
  await assert.rejects(f.session.connectCustody({ recoveryOperationIds: ['A'.repeat(43)] }));
  assert.equal(calls, 1);
});

test('spend expiry stays within the pinned host 1800-second future admission bound', async () => {
  const f = fullFixture(); await f.connectFull();
  const before = Math.floor(Date.now() / 1000); await f.session.withdraw('7');
  const seconds = Number(f.calls.at(-1)[1].protocol.expiresAtUnix) - before;
  assert(seconds > 0 && seconds <= 1800, `Spend expiry ${seconds}s exceeds pinned maxFutureSeconds 1800`);
});

test('sample intents validate against the exact custody-pinned SDK public schema', async () => {
  const { pathToFileURL } = await import('node:url');
  const { custodySdkRoot } = await import('../tools/custody-sdk.mjs');
  const { validateWalletParams } = await import(pathToFileURL(`${custodySdkRoot}/src/wallet-api/index.js`));
  for (const [method, invoke] of [
    ['prepareDeposit', f => f.session.deposit('7')],
    ['authorizeTransfer', async f => { await f.session.publicAccount(); await f.session.transfer('7', { publicDisclosure: true }); }],
    ['authorizeWithdraw', f => f.session.withdraw('7')],
    ['requestDisclosure', f => f.session.disclosure({ transactionHash: '0x' + 'ab'.repeat(32), plane: 'self_view', delivery: 'page' })]
  ]) {
    const f = fullFixture();
    for (const [key, char] of [['sessionHandle', 'S'], ['accountHandle', 'A'], ['networkHandle', 'N']]) f.connection[key] = char.repeat(42) + 'A';
    f.connection.chainActors[0].chainActorHandle = 'C'.repeat(42) + 'A';
    f.client.getPublicAccount = async () => ({ protocol: { shieldedAddress: 'clairs1qqqqqqqq' } });
    await f.connectFull(); validateWalletParams('clairveil_connect', f.calls[0][1]);
    await invoke(f); validateWalletParams(`clairveil_${method}`, f.calls.at(-1)[1]);
  }
  const f = fullFixture(); await f.session.connectWallet();
  await f.session.connectCustody({ recoveryOperationIds: ['A'.repeat(43)] });
  validateWalletParams('clairveil_connect', f.calls[0][1]);
});

test('recovery parent does not query a child outside its fresh consent scope', async () => {
  const f = fullFixture(), id = 'A'.repeat(43), child = 'B'.repeat(42) + 'A';
  await f.session.connectWallet(); await f.session.connectCustody({ recoveryOperationIds: [id] }); await f.session.refresh();
  f.client.getOperation = async ({ operationId }) => {
    assert.equal(operationId, id, 'ungranted child must never be queried');
    return { operationId, kind: 'transfer', state: 'reconciliation_required', accessMode: 'recovery-only', steps: [{ operationId: child, state: 'submitted', stepKind: 'final_transfer' }] };
  };
  await f.session.inspectRecovery(id); await f.session.refresh();
  assert.equal(f.session.state.invalidated, false); assert.equal(f.session.state.activeOperation, null);
});

test('a connection cannot silently add permissions absent from the user request', async () => {
  const f = fixture(); await f.session.connectWallet(); await f.session.connectCustody();
  f.connection.permissions.push('withdraw.request'); await assert.rejects(f.session.refresh());
  assert.equal(f.session.state.connection, null);
});
