import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { importView } from './helpers/react-view.js';
import { startSampleCustody } from '../public/sample-custody-app.js';
import { createCustodySession, depositMethods, fullFlowMethods } from '../public/custody-session.js';
import { validateWalletValue } from '@clairveil/custody-sdk/wallet-api';
import { privacyEventRpc } from './helpers/privacy-event-rpc.js';
import { requestSampleFaucet } from '../public/sample-faucet.js';
const { DappView } = await importView('dapp-view');
const profiles = {
  cosmos: { id: 'cosmos', transport: 'cosmos', chainId: 'synthetic-1', caip: 'cosmos:synthetic-1', profileDigest: 'digest-cosmos', denom: 'uclair' },
  evm: { id: 'evm', transport: 'evm', chainId: 'synthetic-2', evmChainId: '0x32f', caip: 'eip155:815', profileDigest: 'digest-evm', denom: 'aokrw', contract: '0x' + '12'.repeat(20) }
};
function runtimeFixture({ profile, onChange }) {
  const actor = { namespace: profile.transport === 'cosmos' ? 'cosmos' : 'eip155', chainId: profile.evmChainId || profile.chainId, address: 'synthetic-wallet', pubKeyHex: '02'.repeat(33) };
  const calls = [], listeners = new Set();
  const provider = { onInvalidation(fn) { listeners.add(fn); return () => listeners.delete(fn); }, invalidate() { listeners.forEach(fn => fn()); } };
  let op;
  const connection = { sessionHandle: 'S'.repeat(42) + 'A', accountHandle: 'A'.repeat(43), networkHandle: 'N'.repeat(42) + 'A', permissions: [],
    chainActors: [{ accountId: `${profile.caip}:${actor.address}`, chainActorHandle: 'C'.repeat(42) + 'A' }] };
  const client = {
    getCapabilities: async () => ({ methods: [...depositMethods, ...fullFlowMethods], networks: [{ networkId: profile.id, chainId: profile.caip, profileDigest: profile.profileDigest }] }),
    connect: async params => { calls.push(['connect', params]); connection.permissions = params.permissions; connection.recoveryAccess = params.recoveryAccess;
      op = { operationId: 'connect', kind: 'connect', state: 'completed', connection }; return { operationId: 'connect', state: 'awaiting_approval' }; },
    getOperation: async () => { calls.push(['poll']); return op; },
    prepareDeposit: async params => { calls.push(['deposit', params]); return { operationId: 'deposit', state: 'awaiting_approval' }; },
    authorizeTransfer: async params => { calls.push(['transfer', params]); return { operationId: 'transfer', state: 'awaiting_approval' }; },
    authorizeWithdraw: async params => { calls.push(['withdraw', params]); return { operationId: 'withdraw', state: 'awaiting_approval' }; },
    requestDisclosure: async params => { calls.push(['disclosure', params]); return { operationId: 'disclosure', state: 'awaiting_approval' }; },
    getPublicAccount: async () => ({ protocol: { shieldedAddress: 'clairs1qqqqqqqq' } }),
    getBalances: async () => ({ syncStatus: 'current', rows: [{ assetDenom: profile.denom, verificationState: 'unknown' }] }),
    submit: async params => { calls.push(['submit', params]); return { invoked: true }; },
    cancelOperation: async () => ({ operation: { ...op, state: 'cancelled' } }),
    reconcile: async () => { calls.push(['reconcile']); },
    disconnect: async () => provider.invalidate()
  };
  const session = createCustodySession({ profile, provider, client, wallet: { connect: async () => actor, getActor: async () => actor }, onChange });
  const runtime = { session, calls, provider, client, disposed: 0, presentations: 0, registrations: 0,
    registerNetwork: async () => { runtime.registrations++; await runtime.present(); },
    present: async () => { runtime.presentations++; }, connectWallet: () => session.connectWallet(),
    setOperation: value => { op = value; }, dispose() { runtime.disposed++; session.dispose(); }, notify: onChange };
  return runtime;
}
function sharedBrowserState() {
  const records = new Map(), held = new Set();
  return {
    storage: { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) },
    locks: { async request(name, options, task) {
      assert.equal(options.ifAvailable, true, 'user submissions must not be queued for a later wallet dispatch');
      if (held.has(name)) return task(null);
      held.add(name);
      try { return await task({ name }); } finally { held.delete(name); }
    } }
  };
}
async function mount(t, overrides = {}) {
  const { storage, locks = sharedBrowserState().locks, ...appOverrides } = overrides;
  const markup = renderToStaticMarkup(React.createElement(DappView, { custody: true }));
  const dom = new JSDOM(markup, { url: 'http://127.0.0.1:4320/' });
  if (storage) Object.defineProperty(dom.window, 'localStorage', { value: storage });
  Object.defineProperty(dom.window.navigator, 'locks', { value: locks });
  const runtimes = [], chainCalls = [];
  const app = startSampleCustody({ browser: dom.window, document: dom.window.document, pollMs: 100000,
    loadProfiles: async () => profiles,
    loadServerConfig: async () => ({ serverFeatures: { faucet: false } }),
    createRuntime: args => { const r = runtimeFixture(args); runtimes.push(r); return r; },
    chainActions: { readTransparentBalance: async () => '123', sendTransparent: async params => { params.beforeBroadcast(); chainCalls.push(params); return 'a'.repeat(64); } }, ...appOverrides });
  await app.ready;
  t.after(() => { app.dispose(); dom.window.close(); });
  const $ = id => dom.window.document.getElementById(id);
  const click = async id => { $(id).click(); await new Promise(resolve => setImmediate(resolve)); };
  const connect = async (full = true) => { await click('connectKeplr'); $('custodyFullFlow').checked = full; await click('signSession'); await app.runtime.session.refresh(); };
  return { app, dom, runtimes, $, click, connect, chainCalls };
}

test('main sample keeps Wallet Session / Clair / Veiled and removes standalone/private-key interfaces', async t => {
  const f = await mount(t);
  const markup = f.dom.window.document.body.innerHTML;
  for (const label of ['Wallet Session', 'Clair', 'Veiled', 'Privacy Events']) assert.ok(markup.includes(label));
  assert.doesNotMatch(markup, /Custody-Test-Web|\/custody"|Relay Withdraw|Pasted disclosure event JSON|Backup cache|Local Signer/);
  assert.equal(f.$('depositFromKeplr').disabled, true);
  assert.deepEqual(f.app.runtime.calls, [], 'mount never requests consent or signing');
  const entry = await readFile(new URL('../public/dapp-entry.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(entry, /import\('\.\/app.js'\)|CustodyApp/);
  assert.match(entry, /DappView custody/);
});

test('wallet session registers the selected network before wallet connection without requesting authority', async t => {
  for (const network of ['cosmos', 'evm']) {
    const f = await mount(t);
    f.$('dappChainSelect').value = network;
    f.$('dappChainSelect').dispatchEvent(new f.dom.window.Event('change'));
    const runtime = f.app.runtime;
    runtime.client.getCapabilities = async () => { assert.fail('opening setup must not negotiate capabilities'); };
    assert.equal(f.$('signSession').disabled, false);
    assert.match(f.$('custodyConnectionHelp').textContent, new RegExp(network === 'cosmos' ? 'Keplr' : 'MetaMask'));
    await f.click('signSession');
    assert.equal(runtime.registrations, 1, 'send the selected network even before the chain wallet connects');
    assert.equal(runtime.presentations, 1);
    assert.deepEqual(runtime.calls, []);
    assert.equal(runtime.session.state.actor, null);
    assert.equal(f.$('depositFromKeplr').disabled, true);
    assert.equal(f.$('signSession').textContent, 'Network registered');
    assert.equal(f.$('signSession').disabled, true);
    await f.click(network === 'cosmos' ? 'connectKeplr' : 'connectWallet');
    assert.equal(f.$('signSession').textContent, 'Request custody connection');
    assert.equal(f.$('signSession').disabled, false);
    assert.equal(runtime.presentations, 1, 'chain wallet connection never opens custody');
  }
});

test('wallet-free custody opening fences repeat clicks and reports missing extension', async t => {
  const f = await mount(t), runtime = f.app.runtime;
  let unavailable;
  runtime.present = () => { runtime.presentations++; return new Promise((_, reject) => { unavailable = reject; }); };
  await f.click('signSession');
  assert.equal(f.$('signSession').disabled, true);
  assert.equal(f.$('connectKeplr').disabled, true);
  assert.equal(f.$('dappChainSelect').disabled, true);
  await f.click('signSession');
  assert.equal(runtime.presentations, 1);
  unavailable(new Error('Extension unavailable'));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.$('custodyError').textContent, /Extension unavailable/);
  assert.equal(f.$('signSession').disabled, false);
  assert.deepEqual(runtime.calls, []);
});

test('custody connection waits for network registration and rejection sends no capability or connect RPC', async t => {
  const f = await mount(t), runtime = f.app.runtime;
  await f.click('connectKeplr');
  let rejectRegistration;
  runtime.registerNetwork = () => new Promise((_, reject) => { runtime.registrations++; rejectRegistration = reject; });
  runtime.client.getCapabilities = async () => { assert.fail('registration must complete before discovery'); };
  await f.click('signSession');
  assert.equal(runtime.registrations, 1); assert.equal(f.$('signSession').disabled, true);
  await f.click('signSession'); assert.equal(runtime.registrations, 1);
  assert.deepEqual(runtime.calls, []);
  rejectRegistration(new Error('Network registration rejected'));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.$('custodyError').textContent, /Network registration rejected/);
  assert.deepEqual(runtime.calls, []);
  assert.equal(f.$('signSession').disabled, false);
});

test('existing deposit control requests custody approval and separate signing dispatches once', async t => {
  const f = await mount(t); await f.connect();
  assert.equal(f.$('walletSignatureHash').textContent, 'Approved by custody');
  f.$('keplrDepositAmount').value = '19'; await f.click('depositFromKeplr');
  assert.equal(f.app.runtime.calls.at(-1)[1].protocol.amountBaseUnits, '19');
  assert.equal(f.$('custodySubmit').disabled, true);
  f.app.runtime.setOperation({ operationId: 'deposit', kind: 'deposit', state: 'awaiting_chain_signature', publicArtifact: {} });
  await f.app.runtime.session.refresh(); await f.click('custodySubmit'); await f.click('custodySubmit');
  assert.equal(f.app.runtime.calls.filter(call => call[0] === 'submit').length, 1);
  assert.doesNotMatch(f.$('keplrDepositRecovery').textContent, /Effects confirmed/);
  f.app.runtime.setOperation({ operationId: 'deposit', kind: 'deposit', state: 'confirmed' });
  await f.app.runtime.session.refresh();
  assert.match(f.$('keplrDepositRecovery').textContent, /Effects confirmed/);
});

test('main transfer and withdrawal honor the existing recipient, amount and self-view inputs', async t => {
  const f = await mount(t); await f.connect(); await f.click('setupKeplrPrivacy');
  f.$('veiledTransferRecipient').value = 'clairs1pppppppp';
  f.$('veiledDisclosureAdvanced').checked = true;
  f.$('veiledTransferAmount').value = '23'; f.$('veiledDisclosureMode').value = 'public'; f.$('includeSelfViewDisclosure').checked = false;
  await f.click('transferFromVeiled');
  const transfer = f.app.runtime.calls.at(-1)[1].protocol;
  assert.equal(transfer.recipientShieldedAddress, 'clairs1pppppppp'); assert.equal(transfer.amountBaseUnits, '23');
  assert.deepEqual(transfer.disclosure, { policy: 'amount', mode: 'public' }); assert.equal(transfer.selfViewEnabled, false);
  f.app.runtime.setOperation({ operationId: 'transfer', kind: 'transfer', state: 'confirmed' }); await f.app.runtime.session.refresh();
  f.$('veiledWithdrawRecipient').value = 'synthetic-withdraw-recipient'; f.$('veiledWithdrawAmount').value = '17';
  await f.click('withdrawFromVeiled'); assert.equal(f.app.runtime.calls.at(-1)[1].protocol.recipientAddress, 'synthetic-withdraw-recipient');
  assert.equal(f.app.runtime.calls.at(-1)[1].protocol.amountBaseUnits, '17');
});

test('the transfer form preserves encrypted recipient and selected public disclosure fields', async t => {
  for (const mode of ['public', 'recipient-encrypted']) {
    const f = await mount(t); await f.connect(); await f.click('setupKeplrPrivacy');
    assert(f.$('veiledDisclosureMode').querySelector('option[value="recipient-encrypted"]'));
    f.$('veiledDisclosureAdvanced').checked = true;
    f.$('veiledTransferAmount').value = '1000'; f.$('veiledDisclosureMode').value = mode;
    f.$('veiledDisclosureFrom').checked = true; f.$('veiledDisclosureTo').checked = true;
    f.$('veiledDisclosurePubKey').value = '0x' + 'AB'.repeat(32);
    await f.click('transferFromVeiled');
    assert.deepEqual(f.app.runtime.calls.at(-1)[1].protocol.disclosure, { policy: 'amount-from-to', mode,
      ...(mode === 'recipient-encrypted' ? { recipientDisclosurePublicKey: 'ab'.repeat(32) } : {}) });
  }
  const f = await mount(t); await f.connect(); await f.click('setupKeplrPrivacy');
  f.$('veiledDisclosureAdvanced').checked = true;
  f.$('veiledDisclosureMode').value = 'recipient-encrypted'; f.$('veiledDisclosurePubKey').value = 'invalid';
  await f.click('transferFromVeiled');
  assert.equal(f.app.runtime.calls.some(([kind]) => kind === 'transfer'), false);
  assert.equal(f.app.runtime.session.state.uncertain, false);
  f.$('veiledDisclosurePubKey').value = 'ab'.repeat(32); await f.click('transferFromVeiled');
  assert.equal(f.app.runtime.calls.filter(([kind]) => kind === 'transfer').length, 1);
});

test('turning Advanced off restores a private transfer even when hidden disclosure inputs retain values', async t => {
  for (const mode of ['public', 'recipient-encrypted']) {
    const f = await mount(t); await f.connect(); await f.click('setupKeplrPrivacy');
    await f.click('veiledDisclosureAdvanced');
    f.$('veiledDisclosureMode').value = mode;
    f.$('veiledDisclosureFrom').checked = true; f.$('veiledDisclosureTo').checked = true;
    f.$('veiledDisclosurePubKey').value = 'invalid-hidden-key';
    f.$('includeSelfViewDisclosure').checked = false;
    await f.click('veiledDisclosureAdvanced');
    assert.equal(f.$('veiledDisclosureOptions').hidden, true);
    await f.click('transferFromVeiled');
    const request = f.app.runtime.calls.find(([kind]) => kind === 'transfer')[1];
    assert.deepEqual(request.protocol.disclosure, { policy: 'all-private', mode: 'none' });
    assert.equal(request.protocol.selfViewEnabled, false, 'independent self-view choice is preserved');
  }
});

test('declined custody connection can be requested again or disconnected without a reload', async t => {
  const f = await mount(t); await f.click('connectKeplr'); await f.click('signSession');
  const firstKey = f.app.runtime.calls.find(([kind]) => kind === 'connect')[1].idempotencyKey;
  f.app.runtime.setOperation({ operationId: 'connect', kind: 'connect', state: 'failed', failure: { code: 4001 } });
  await f.app.runtime.session.refresh();
  for (const id of ['signSession', 'disconnectWallet', 'sendFromKeplr', 'custodyFullFlow', 'custodyRecoveryIds']) assert.equal(f.$(id).disabled, false, id);
  assert.equal(f.app.runtime.calls.filter(([kind]) => kind === 'connect').length, 1, 'no automatic retry');
  f.$('custodyFullFlow').checked = true; await f.click('signSession'); await f.app.runtime.session.refresh();
  const requests = f.app.runtime.calls.filter(([kind]) => kind === 'connect');
  assert.equal(requests.length, 2); assert.notEqual(requests[1][1].idempotencyKey, firstKey);
  assert(requests[1][1].permissions.includes('transfer.request'));
  assert.equal(f.$('depositFromKeplr').disabled, false);
  await f.click('disconnectWallet'); assert.equal(f.$('dappChainSelect').disabled, false);
});

test('a failed disclosure does not block other actions or a corrected disclosure request', async t => {
  const f = await mount(t); await f.connect(); await f.click('setupKeplrPrivacy');
  change(f, 'disclosureSourceTxHash', 'a'.repeat(64), 'input'); await f.click('decodeEventDisclosure');
  f.app.runtime.setOperation({ operationId: 'disclosure', kind: 'disclosure', state: 'failed', failure: { code: 4207 } });
  await f.app.runtime.session.refresh();
  for (const id of ['depositFromKeplr', 'transferFromVeiled', 'withdrawFromVeiled', 'sendFromKeplr', 'disconnectWallet', 'decodeDisclosureSource']) assert.equal(f.$(id).disabled, false, id);
  assert.equal(f.app.runtime.calls.filter(([kind]) => kind === 'disclosure').length, 1, 'no automatic retry');
  await f.click('custodyDisclosureAmount'); await f.click('custodyDisclosureFrom'); await f.click('decodeDisclosureSource');
  const requests = f.app.runtime.calls.filter(([kind]) => kind === 'disclosure');
  assert.equal(requests.length, 2); assert.deepEqual(requests[1][1].requestedFields, ['from']);
});

test('the withdrawal controls prepare an exact note and resume the original recipient and amount', async t => {
  const f = await mount(t); await f.connect();
  f.$('veiledWithdrawAmount').value = '1000'; f.$('veiledWithdrawRecipient').value = 'original-recipient';
  await f.click('withdrawFromVeiled');
  f.app.runtime.setOperation({ operationId: 'withdraw', kind: 'withdraw', state: 'failed', failure: { code: 4202 } }); await f.app.runtime.session.refresh();
  assert.equal(f.$('prepareWithdrawNote').hidden, false); assert.equal(f.$('prepareWithdrawNote').disabled, false);
  assert.match(f.$('withdrawPreparationState').textContent, /1000.*original-recipient/);
  assert.equal(f.app.runtime.calls.some(([kind]) => kind === 'transfer'), false);
  const beforePreparation = f.app.runtime.presentations;
  await f.click('prepareWithdrawNote');
  assert.equal(f.app.runtime.presentations, beforePreparation + 1);
  const request = f.app.runtime.calls.at(-1)[1];
  assert.equal(request.protocol.recipientShieldedAddress, 'clairs1qqqqqqqq');
  f.$('veiledWithdrawAmount').value = '2'; f.$('veiledWithdrawRecipient').value = 'edited-recipient';
  assert.equal(f.$('resumeWithdraw').hidden, true);
  f.app.runtime.setOperation({ operationId: 'transfer', kind: 'transfer', state: 'confirmed' }); await f.app.runtime.session.refresh();
  assert.equal(f.$('resumeWithdraw').hidden, false);
  assert.equal(f.app.runtime.calls.filter(([kind]) => kind === 'withdraw').length, 1);
  const beforeResume = f.app.runtime.presentations;
  await f.click('resumeWithdraw');
  assert.equal(f.app.runtime.presentations, beforeResume + 1);
  assert.equal(f.app.runtime.calls.at(-1)[1].protocol.amountBaseUnits, '1000');
  assert.equal(f.app.runtime.calls.at(-1)[1].protocol.recipientAddress, 'original-recipient');
  assert.equal(f.app.runtime.calls.some(([kind]) => kind === 'submit'), false);
});

test('disconnect resets wallet-only and settled custody sessions and permits chain changes', async t => {
  for (const custodyConnected of [false, true]) {
    const f = await mount(t);
    if (custodyConnected) await f.connect(); else await f.click('connectKeplr');
    const previous = f.app.runtime;
    assert.equal(f.$('disconnectWallet').disabled, false); await f.click('disconnectWallet');
    assert.equal(previous.disposed, 1); assert.equal(f.$('connectKeplr').disabled, false);
    assert.equal(f.$('dappChainSelect').disabled, false); assert.equal(f.app.runtime.session.state.actor, null);
    change(f, 'dappChainSelect', 'evm'); assert.equal(f.$('connectWallet').disabled, false);
    previous.notify({ actor: { address: 'stale' } }); assert.doesNotMatch(f.$('walletAccount').textContent, /stale/);
  }
});

test('disconnect preserves ordinary pending records and cannot discard an unresolved custody operation', async t => {
  const shared = sharedBrowserState(), f = await mount(t, shared); await f.connect();
  f.$('keplrSendAmount').value = '1'; f.$('keplrSendRecipient').value = 'recipient'; await f.click('sendFromKeplr'); await waitForSend(f);
  await f.click('disconnectWallet'); await f.click('connectKeplr');
  assert.equal(f.$('sendFromKeplr').disabled, true);
  const g = await mount(t); await g.connect(); await g.click('depositFromKeplr');
  const previous = g.app.runtime;
  assert.equal(g.$('disconnectWallet').disabled, true); await g.click('disconnectWallet');
  assert.equal(g.app.runtime, previous); assert.equal(g.app.runtime.session.state.operation.operationId, 'deposit');
});

const faucetConfig = profile => ({ ...profile, coinDecimals: 18, displayDenom: 'TEST', serverFeatures: { faucet: true } });
function faucetHttp(t, respond) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'http://127.0.0.1:4320/' } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'location', original); else delete globalThis.location; });
  return request => requestSampleFaucet({ ...request, fetchImpl: async (url, options) => {
    const { status, body } = respond(JSON.parse(options.body));
    const response = new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url }); return response;
  } });
}

test('HTTP faucet rejection releases the main UI and survives reconnect/reload without automatic funding', async t => {
  const shared = sharedBrowserState(), hash = 'b'.repeat(64); let posts = 0;
  const requestFaucet = faucetHttp(t, request => {
    posts++;
    if (posts === 1) return { status: 400, body: { checkTxRejected: true, rpcInvoked: true, txCode: 5, txCodespace: 'sdk', txHeight: '0', txHash: hash } };
    return { status: 200, body: { recipient: request.recipient, amount: { funded: request.amount }, broadcast: { txhash: hash },
      tx: { txhash: hash, height: '8', code: 0 }, included: true, unknown: false, failed: false } };
  });
  const overrides = { ...shared, loadServerConfig: async () => faucetConfig(profiles.cosmos), requestFaucet };
  const f = await mount(t, overrides); await f.connect(); await f.click('fundKeplr'); await waitForSend(f);
  assert.equal(posts, 1); assert.equal(f.$('fundKeplr').disabled, false); assert.equal(f.$('depositFromKeplr').disabled, false);
  assert.match(f.$('custodyError').textContent, /CheckTx rejected/); assert.equal(f.$('keplrFaucetHash').textContent, hash);
  await f.click('disconnectWallet'); await f.click('connectKeplr'); assert.equal(f.$('fundKeplr').disabled, false);
  const reloaded = await mount(t, overrides); await reloaded.click('connectKeplr');
  assert.equal(reloaded.$('fundKeplr').disabled, false); assert.equal(posts, 1);
  await reloaded.click('fundKeplr'); await waitForSend(reloaded);
  assert.equal(posts, 2); assert.equal(reloaded.$('fundKeplr').disabled, false);
  assert.match(reloaded.$('keplrFaucetSent').textContent, /uclair/);
});

test('a duplicate faucet response preserves its hash across reload and reconciles without funding again', async t => {
  const shared = sharedBrowserState(), hash = 'b'.repeat(64); let posts = 0;
  const overrides = { ...shared, loadServerConfig: async () => faucetConfig(profiles.cosmos),
    requestFaucet: faucetHttp(t, () => { posts++; return { status: 400,
      body: { checkTxRejected: true, rpcInvoked: true, txCode: 19, txCodespace: 'sdk', txHeight: '0', txHash: hash } }; }),
    fetchJson: async url => { assert(url.endsWith(hash)); return { tx_response: { txhash: hash, height: '8', code: 0 } }; } };
  const f = await mount(t, overrides); await f.click('connectKeplr'); await f.click('fundKeplr'); await waitForSend(f);
  assert.equal(f.$('fundKeplr').disabled, true); assert.equal(f.$('reconcileFaucet').disabled, false);
  const reloaded = await mount(t, overrides); await reloaded.click('connectKeplr');
  assert.equal(reloaded.$('fundKeplr').disabled, true); assert.equal(reloaded.$('reconcileFaucet').disabled, false);
  assert.equal(reloaded.$('keplrFaucetHash').textContent, hash);
  await reloaded.click('reconcileFaucet'); assert.equal(reloaded.$('fundKeplr').disabled, false); assert.equal(posts, 1);
});

test('an HTTP faucet failure without rejection evidence remains blocked across reload', async t => {
  const shared = sharedBrowserState(); let posts = 0;
  const overrides = { ...shared, loadServerConfig: async () => faucetConfig(profiles.cosmos),
    requestFaucet: faucetHttp(t, () => { posts++; return { status: 503, body: { error: 'backend unavailable' } }; }) };
  const f = await mount(t, overrides); await f.click('connectKeplr'); await f.click('fundKeplr'); await waitForSend(f);
  const reloaded = await mount(t, overrides); await reloaded.click('connectKeplr');
  assert.equal(reloaded.$('fundKeplr').disabled, true); assert.equal(reloaded.$('reconcileFaucet').disabled, true); assert.equal(posts, 1);
});

test('faucet only dispatches to an enabled matching backend and refreshes a confirmed balance', async t => {
  for (const configuration of [null, { serverFeatures: { faucet: false } }, faucetConfig(profiles.evm)]) {
    const f = await mount(t, { loadServerConfig: async () => configuration, requestFaucet: () => assert.fail('unavailable faucet') });
    await f.click('connectKeplr'); assert.equal(f.$('fundKeplr').disabled, true); await f.click('fundKeplr');
  }
  for (const transport of ['cosmos', 'evm']) {
    const calls = [], configuration = faucetConfig(profiles[transport]);
    const f = await mount(t, { loadServerConfig: async () => configuration, requestFaucet: async request => {
      request.beforeDispatch(); calls.push(request); return { hash: (transport === 'evm' ? '0x' : '') + 'a'.repeat(64), amount: '1000' + profiles[transport].denom, confirmed: true };
    } });
    if (transport === 'evm') { change(f, 'dappChainSelect', 'evm'); await f.click('connectWallet'); } else await f.click('connectKeplr');
    f.$('keplrFaucetAmount').value = '0.000000000000001'; await f.click('fundKeplr');
    assert.equal(calls.length, 1); assert.equal(calls[0].actor.address, f.app.runtime.session.state.actor.address);
    assert.equal(calls[0].amount, '0.000000000000001'); assert.match(f.$('keplrFaucetSent').textContent, /1000/);
    assert.equal(f.$('fundKeplr').disabled, false); assert.match(f.$('keplrBalance').textContent, /123/);
    assert.equal(f.app.runtime.calls.some(([kind]) => ['connect', 'submit'].includes(kind)), false);
  }
});

test('lost faucet replies stay blocked across reconnects, reloads and concurrent tabs', async t => {
  const shared = sharedBrowserState(), configuration = faucetConfig(profiles.cosmos);
  let calls = 0, release;
  const overrides = { ...shared, loadServerConfig: async () => configuration, requestFaucet: async request => {
    request.beforeDispatch(); calls++; await new Promise(resolve => { release = resolve; }); throw new Error('lost faucet reply');
  } };
  const f = await mount(t, overrides), other = await mount(t, overrides);
  await f.click('connectKeplr'); await other.click('connectKeplr');
  await f.click('fundKeplr'); await other.click('fundKeplr'); assert.equal(calls, 1);
  release(); await tick(); assert.equal(f.$('fundKeplr').disabled, true);
  await f.click('disconnectWallet'); await f.click('connectKeplr'); assert.equal(f.$('fundKeplr').disabled, true);
  const reloaded = await mount(t, overrides); await reloaded.click('connectKeplr');
  assert.equal(reloaded.$('fundKeplr').disabled, true); assert.equal(calls, 1);
});

test('a known faucet transaction is reconciled without another funding request', async t => {
  let posts = 0;
  const hash = 'b'.repeat(64), f = await mount(t, {
    loadServerConfig: async () => faucetConfig(profiles.cosmos),
    requestFaucet: async request => { posts++; request.beforeDispatch(); return { hash, amount: '1000uclair', confirmed: false }; },
    fetchJson: async url => { assert(url.endsWith(hash)); return { tx_response: { txhash: hash, height: '8', code: 0 } }; }
  });
  await f.click('connectKeplr'); await f.click('fundKeplr');
  assert.equal(f.$('fundKeplr').disabled, true); await f.click('reconcileFaucet');
  assert.equal(f.$('fundKeplr').disabled, false); assert.equal(posts, 1); assert.equal(f.$('keplrFaucetSent').textContent, '1000uclair');
});

test('main balance and disclosure panels render only granted verified results and clear on invalidation', async t => {
  const f = await mount(t); await f.connect(); await f.click('setupKeplrPrivacy');
  await f.click('scanKeplrNotes'); assert.match(f.$('myKeplrSpendable').textContent, /Unknown/);
  f.app.runtime.client.getBalances = async () => ({ syncStatus: 'current', rows: [{ assetDenom: 'uclair', verificationState: 'verified', spendableBaseUnits: '42' }] });
  await f.click('scanKeplrNotes'); assert.match(f.$('myKeplrSpendable').textContent, /42 uclair/);
  f.$('disclosureSourceTxHash').value = 'a'.repeat(64); f.$('disclosureSourceTxHash').dispatchEvent(new f.dom.window.Event('input'));
  await f.click('decodeSelfViewDisclosure');
  const params = f.app.runtime.calls.at(-1)[1]; assert.deepEqual(params.requestedFields, ['amount']); assert.equal(params.protocol.plane, 'self_view');
  f.app.runtime.setOperation({ operationId: 'disclosure', kind: 'disclosure', state: 'completed', disclosureResult: {
    delivery: 'page', transactionHash: 'a'.repeat(64), plane: 'self_view', verificationStatus: 'verified', disclosedFields: ['amount'], fields: { amount: { amountBaseUnits: '42', assetDenom: 'uclair' } } } });
  await f.app.runtime.session.refresh(); assert.equal(f.$('eventDisclosureAmount').textContent, '42 uclair');
  f.app.runtime.provider.invalidate(); assert.equal(f.$('eventDisclosureAmount').textContent, '—');
  assert.match(f.$('myKeplrSpendable').textContent, /Unknown/); assert.equal(f.$('depositFromKeplr').disabled, true);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitForSend(f) {
  const deadline = Date.now() + 2000;
  while (f.$('keplrTxState').textContent === 'Chain wallet request pending') {
    assert(Date.now() < deadline, 'public send did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function change(f, id, value, event = 'change') {
  f.$(id).value = value; f.$(id).dispatchEvent(new f.dom.window.Event(event));
}
const disclosed = (transactionHash = 'a'.repeat(64), plane = 'user', extra = {}) => ({
  operationId: 'disclosure', kind: 'disclosure', state: 'completed', disclosureResult: {
    delivery: 'page', transactionHash, plane, verificationStatus: 'verified',
    disclosedFields: ['amount'], fields: { amount: { amountBaseUnits: '42', assetDenom: 'uclair' } }, ...extra
  }
});

test('each selected disclosure field combination reaches custody and renders only its verified result', async t => {
  const fields = ['amount', 'from', 'to'];
  const ids = ['custodyDisclosureAmount', 'custodyDisclosureFrom', 'custodyDisclosureTo'];
  const values = { amount: { amountBaseUnits: '42', assetDenom: 'uclair', assetIdHex: 'f'.repeat(64) }, from: 'clairs1qqqqqqqq', to: 'clairs1pppppppp' };
  for (const plane of ['user', 'self_view']) for (let mask = 1; mask < 8; mask++) {
    const f = await mount(t); await f.connect();
    ids.forEach((id, index) => { f.$(id).checked = Boolean(mask & (1 << index)); });
    const requestedFields = fields.filter((_, index) => mask & (1 << index));
    change(f, 'disclosureSourceTxHash', 'a'.repeat(64), 'input');
    await f.click(plane === 'user' ? 'decodeEventDisclosure' : 'decodeSelfViewDisclosure');
    const params = f.app.runtime.calls.at(-1)[1];
    assert.deepEqual(params.requestedFields, requestedFields);
    assert.equal(params.protocol.plane, plane);
    const result = validateWalletValue('ClairveilDisclosureResult', {
      delivery: 'page', transactionHash: 'a'.repeat(64), plane, verificationStatus: 'verified',
      policy: plane === 'self_view' ? 'amount-from-to' : requestedFields.join('-'), mode: plane === 'self_view' ? 'recipient-encrypted' : 'public',
      target: { messageIndex: '0', outputIndex: '0', commitmentHex: 'b'.repeat(64), digestHex: 'c'.repeat(64) },
      disclosedFields: requestedFields, fields: Object.fromEntries(requestedFields.map(field => [field, values[field]]))
    }, { response: true });
    f.app.runtime.setOperation({ operationId: 'disclosure', kind: 'disclosure', state: 'completed', disclosureResult: result });
    await f.app.runtime.session.refresh();
    for (const [index, id, value] of [[0, 'eventDisclosureAmount', '42 uclair'], [1, 'eventDisclosureFrom', values.from], [2, 'eventDisclosureTo', values.to]]) {
      assert.equal(f.$(id).textContent, mask & (1 << index) ? value : '—', `${plane}/${mask}/${id}`);
    }
    assert.equal(f.$('eventDisclosureFields').textContent, requestedFields.join(', '));
    assert.equal(f.$('eventDisclosurePlane').textContent, plane);
    assert.equal(f.$('eventDisclosureCommitment').textContent, 'b'.repeat(64));
    assert.equal(f.$('eventDisclosureVerified').textContent, 'Verified by custody');
    await f.click('custodyDisclosureAmount');
    await f.app.runtime.session.refresh();
    for (const id of ['eventDisclosureAmount', 'eventDisclosureFrom', 'eventDisclosureTo', 'eventDisclosureFields', 'eventDisclosureCommitment', 'eventDisclosureVerified']) assert.equal(f.$(id).textContent, '—', `changed selection/${id}`);
  }
});

test('an empty disclosure selection never dispatches or blocks a corrected selection', async t => {
  const f = await mount(t); await f.connect();
  change(f, 'disclosureSourceTxHash', 'a'.repeat(64), 'input'); await f.click('custodyDisclosureAmount');
  for (const id of ['decodeEventDisclosure', 'decodeSelfViewDisclosure', 'decodeDisclosureSource']) assert.equal(f.$(id).disabled, true);
  await f.click('decodeDisclosureSource'); assert.equal(f.app.runtime.calls.some(([kind]) => kind === 'disclosure'), false);
  assert.equal(f.app.runtime.session.state.uncertain, false);
  await f.click('custodyDisclosureTo'); await f.click('decodeDisclosureSource');
  assert.deepEqual(f.app.runtime.calls.at(-1)[1].requestedFields, ['to']);
});

test('the main transfer form accepts a corrected recipient after a local schema rejection', async t => {
  const f = await mount(t); await f.connect(); await f.click('setupKeplrPrivacy');
  f.$('veiledTransferRecipient').value = 'not-a-shielded-address'; await f.click('transferFromVeiled');
  assert.equal(f.app.runtime.calls.some(([method]) => method === 'transfer'), false);
  assert.equal(f.$('depositFromKeplr').disabled, false); assert.equal(f.$('transferFromVeiled').disabled, false);
  f.$('veiledTransferRecipient').value = 'clairs1pppppppp'; await f.click('transferFromVeiled');
  assert.equal(f.app.runtime.calls.filter(([method]) => method === 'transfer').length, 1);
});

test('EVM event selection uses the resolved Ethereum hash only after an explicit disclosure request', async t => {
  const rpc = privacyEventRpc(profiles.evm), f = await mount(t, { fetchJson: rpc.fetchJson }); await connectEvm(f);
  await f.click('refreshEvents'); f.$('eventsList').children[0].click(); await tick();
  assert.equal(f.$('disclosureSourceTxHash').value, '0x' + 'e'.repeat(64));
  assert.equal(f.app.runtime.calls.some(([method]) => method === 'disclosure'), false);
  await f.click('decodeEventDisclosure');
  assert.equal(f.app.runtime.calls.at(-1)[1].protocol.transactionHash, '0x' + 'e'.repeat(64));
  assert(rpc.requests.some(({ url }) => url.endsWith('/events?limit=30&page=1')));
});

test('manual disclosure hashes use the selected chain format and bind the canonical result', async t => {
  for (const transport of ['cosmos', 'evm']) {
    for (const prefix of ['', '0x']) {
      const f = await mount(t);
      if (transport === 'evm') await connectEvm(f); else await f.connect();
      change(f, 'disclosureSourceTxHash', prefix + 'AB'.repeat(32), 'input');
      assert.equal(f.app.runtime.calls.some(([method]) => method === 'disclosure'), false);
      assert.equal(f.$('decodeDisclosureSource').disabled, false);
      await f.click('decodeDisclosureSource');
      const expected = (transport === 'evm' ? '0x' : '') + 'ab'.repeat(32);
      const requests = f.app.runtime.calls.filter(([method]) => method === 'disclosure');
      assert.equal(requests.length, 1);
      assert.equal(requests[0][1].protocol.transactionHash, expected, `${transport}, prefix ${prefix}`);
      f.app.runtime.setOperation(disclosed(expected, 'user', {
        fields: { amount: { amountBaseUnits: '42', assetDenom: profiles[transport].denom } }
      }));
      await f.app.runtime.session.refresh();
      assert.equal(f.$('eventDisclosureAmount').textContent, `42 ${profiles[transport].denom}`);
      assert.equal(f.$('depositFromKeplr').disabled, false);
      assert.equal(f.$('sendFromKeplr').disabled, false);
      change(f, 'disclosureSourceTxHash', prefix + 'CD'.repeat(32), 'input');
      assert.equal(f.$('eventDisclosureAmount').textContent, '—');
    }
  }
});

test('event pagination reaches newer transfers on both chains and refreshes the displayed page', async t => {
  for (const transport of ['cosmos', 'evm']) {
    const rpc = privacyEventRpc(profiles[transport]);
    rpc.events.unshift(...Array.from({ length: 30 }, (_, index) => ({ height: '1', event_type: 'shielded_transfer', tx_hash_hex: index.toString(16).padStart(64, '0') })));
    const f = await mount(t, { fetchJson: rpc.fetchJson });
    if (transport === 'evm') await connectEvm(f); else await f.connect();
    assert.equal(f.$('nextEventsPage').disabled, true);
    await f.click('refreshEvents'); assert.equal(f.$('eventsList').children.length, 30);
    assert.equal(f.$('previousEventsPage').disabled, true); assert.equal(f.$('nextEventsPage').disabled, false);
    f.$('nextEventsPage').click(); f.$('nextEventsPage').click(); await tick();
    assert.equal(f.$('eventsList').children.length, 2); assert.match(f.$('eventsPageState').textContent, /Page 2/);
    assert.equal(f.$('nextEventsPage').disabled, true); assert.equal(f.$('previousEventsPage').disabled, false);
    await f.click('refreshEvents'); assert.match(f.$('eventsPageState').textContent, /Page 2/);
    f.$('eventsList').children[0].click(); await tick(); await f.click('decodeEventDisclosure');
    assert.equal(f.app.runtime.calls.at(-1)[1].protocol.transactionHash, transport === 'evm' ? '0x' + 'e'.repeat(64) : 'a'.repeat(64));
    await f.click('previousEventsPage'); assert.equal(f.$('eventsList').children.length, 30);
    assert.deepEqual(rpc.requests.filter(({ url }) => url.includes('/events?')).map(({ url }) => new URL(url, 'http://localhost').searchParams.get('page')), ['1', '2', '2', '1']);
    assert(rpc.requests.every(({ options }) => options.timeoutMs === 10000 && options.maxBytes <= 2097152));
  }
});

test('a failed or mismatched event page preserves the current page for an explicit retry', async t => {
  const rpc = privacyEventRpc(profiles.cosmos); let failure = 'network';
  rpc.events.push(...Array.from({ length: 29 }, () => ({ ...rpc.events[0] })));
  const f = await mount(t, { fetchJson: async (url, options) => {
    if (url.includes('page=2') && failure === 'network') throw new Error('Synthetic event read failure');
    const response = await rpc.fetchJson(url, options);
    if (url.includes('page=2') && failure === 'page') return { ...response, page: '1' };
    return response;
  } });
  await f.click('refreshEvents'); const firstPage = f.$('eventsList').textContent;
  for (failure of ['network', 'page']) {
    await f.click('nextEventsPage'); assert.match(f.$('eventsPageState').textContent, /Page 1/);
    assert.equal(f.$('eventsList').textContent, firstPage); assert.equal(f.$('nextEventsPage').disabled, false);
  }
  failure = ''; await f.click('nextEventsPage'); assert.match(f.$('eventsPageState').textContent, /Page 2/);
  assert.equal(f.$('eventsList').children.length, 1);
});

test('network changes abort and fence late event pages', async t => {
  const rpc = privacyEventRpc(profiles.cosmos); let resolve, signal;
  const f = await mount(t, { fetchJson: (url, options) => url.includes('/events?') ? new Promise(done => { resolve = done; signal = options.signal; }) : rpc.fetchJson(url, options) });
  await f.click('refreshEvents'); assert.equal(f.$('refreshEvents').disabled, true);
  change(f, 'dappChainSelect', 'evm'); assert.equal(signal.aborted, true);
  resolve({ events: rpc.events, page: '1', limit: '30', has_more: true }); await tick();
  assert.equal(f.$('eventsList').children.length, 0); assert.equal(f.$('nextEventsPage').disabled, true);
  assert.equal(f.$('eventsPageState').textContent, 'Events not loaded');
});

test('failed and superseded event mappings cannot submit or replace the selected transaction', async t => {
  const rpc = privacyEventRpc(profiles.evm), pending = new Map();
  const f = await mount(t, { fetchJson: (url, options) => url.startsWith('/evm-rpc/tx?')
    ? new Promise((resolve, reject) => pending.set(url.includes('a'.repeat(64)) ? 'a' : 'b', { resolve, reject, signal: options.signal })) : rpc.fetchJson(url, options) });
  await connectEvm(f); await f.click('refreshEvents');
  f.$('eventsList').children[0].click(); await tick();
  assert.equal(f.$('decodeEventDisclosure').disabled, true); assert.equal(f.$('disclosureSourceTxHash').value, '');
  f.$('eventsList').children[1].click(); await tick();
  assert.equal(pending.get('a').signal.aborted, true);
  pending.get('b').resolve(rpc.transactions.get('b'.repeat(64))); await tick();
  pending.get('a').resolve(rpc.transactions.get('a'.repeat(64))); await tick();
  assert.equal(f.$('disclosureSourceTxHash').value, '0x' + 'f'.repeat(64));
  f.$('eventsList').children[0].click(); await tick();
  change(f, 'disclosureSourceTxHash', '0x' + 'c'.repeat(64), 'input');
  pending.get('a').resolve(rpc.transactions.get('a'.repeat(64))); await tick();
  assert.equal(f.$('disclosureSourceTxHash').value, '0x' + 'c'.repeat(64)); assert.equal(f.$('eventDetailTx').textContent, '—');
  f.$('eventsList').children[1].click(); await tick(); pending.get('b').reject(new Error('Synthetic lookup failure')); await tick();
  assert.equal(f.$('disclosureSourceTxHash').value, ''); assert.equal(f.$('decodeEventDisclosure').disabled, true);
  assert.equal(f.app.runtime.calls.some(([method]) => method === 'disclosure'), false);
});

test('profile changes fence a pending public event mapping', async t => {
  const rpc = privacyEventRpc(profiles.evm); let resolve;
  const f = await mount(t, { fetchJson: (url, options) => url.startsWith('/evm-rpc/tx?') ? new Promise(done => { resolve = done; }) : rpc.fetchJson(url, options) });
  change(f, 'dappChainSelect', 'evm'); await f.click('refreshEvents'); f.$('eventsList').children[0].click(); await tick();
  change(f, 'dappChainSelect', 'cosmos'); resolve(rpc.transactions.get('a'.repeat(64))); await tick();
  assert.equal(f.$('disclosureSourceTxHash').value, ''); assert.equal(f.$('eventDetailTx').textContent, '—');
  assert.equal(f.$('eventsList').children.length, 0);
});

test('changing event, manual hash, plane or delivery clears a completed disclosure and fences later polls', async t => {
  for (const field of ['event', 'disclosureSourceTxHash', 'disclosureSourcePlane', 'custodyDisclosureDelivery']) {
    const rpc = privacyEventRpc(profiles.cosmos), f = await mount(t, { fetchJson: rpc.fetchJson }); await f.connect();
    change(f, 'disclosureSourceTxHash', 'a'.repeat(64), 'input'); await f.click('decodeEventDisclosure');
    f.app.runtime.setOperation(disclosed()); await f.app.runtime.session.refresh();
    assert.equal(f.$('eventDisclosureAmount').textContent, '42 uclair', field);
    if (field === 'event') { await f.click('refreshEvents'); f.$('eventsList').children[1].click(); await tick(); }
    else change(f, field, field === 'disclosureSourceTxHash' ? 'b'.repeat(64) : field === 'disclosureSourcePlane' ? 'self-view' : 'trusted-wallet', field === 'disclosureSourceTxHash' ? 'input' : 'change');
    assert.equal(f.$('eventDisclosureAmount').textContent, '—', field);
    await f.app.runtime.session.refresh(); assert.equal(f.$('eventDisclosureAmount').textContent, '—', field);
    assert.doesNotMatch(f.$('eventDisclosureState').textContent, /Approved disclosure fields verified/, field);
  }
});

test('a late disclosure acceptance or completed poll cannot bind to a changed selection', async t => {
  for (const selection of ['hash', 'fields']) for (const phase of ['acceptance', 'poll']) {
    const f = await mount(t); await f.connect(); let resolve;
    change(f, 'disclosureSourceTxHash', 'a'.repeat(64), 'input');
    if (phase === 'acceptance') f.app.runtime.client.requestDisclosure = () => new Promise(done => { resolve = done; });
    await f.click('decodeEventDisclosure');
    let pending;
    if (phase === 'poll') { f.app.runtime.client.getOperation = () => new Promise(done => { resolve = done; }); pending = f.app.runtime.session.refresh(); }
    if (selection === 'hash') change(f, 'disclosureSourceTxHash', 'b'.repeat(64), 'input');
    else await f.click('custodyDisclosureFrom');
    resolve(phase === 'acceptance' ? { operationId: 'disclosure', state: 'awaiting_approval' } : disclosed());
    if (pending) await pending; else { await tick(); f.app.runtime.setOperation(disclosed()); await f.app.runtime.session.refresh(); }
    assert.equal(f.$('eventDisclosureAmount').textContent, '—', phase);
    if (selection === 'hash') change(f, 'disclosureSourceTxHash', 'a'.repeat(64), 'input');
    else await f.click('custodyDisclosureFrom');
    assert.equal(f.$('eventDisclosureAmount').textContent, '—', 'reselecting old input must not restore a revoked display binding');
  }
});

test('disclosure result identity and delivery must match the current operation request', async t => {
  for (const extra of [{ transactionHash: 'b'.repeat(64) }, { plane: 'self_view' }, { delivery: 'trusted-wallet', displayStatus: 'displayed' }, { disclosedFields: ['from'], fields: { from: 'clairs1pppppppp' } }]) {
    const f = await mount(t); await f.connect(); change(f, 'disclosureSourceTxHash', 'a'.repeat(64), 'input'); await f.click('decodeEventDisclosure');
    f.app.runtime.setOperation(disclosed(undefined, undefined, extra)); await f.app.runtime.session.refresh();
    assert.equal(f.$('eventDisclosureAmount').textContent, '—');
    assert.match(f.$('eventDisclosureState').textContent, /Request disclosure/);
  }
  const f = await mount(t); await f.connect(); change(f, 'disclosureSourceTxHash', 'a'.repeat(64), 'input');
  await f.click('custodyDisclosureFrom'); await f.click('custodyDisclosureTo');
  change(f, 'custodyDisclosureDelivery', 'trusted-wallet'); await f.click('decodeSelfViewDisclosure');
  assert.deepEqual(f.app.runtime.calls.at(-1)[1].requestedFields, ['amount', 'from', 'to']);
  assert.equal(f.$('disclosureSourcePlane').value, 'self-view');
  f.app.runtime.setOperation({ operationId: 'disclosure', kind: 'disclosure', state: 'completed', disclosureResult: { delivery: 'trusted-wallet', displayStatus: 'displayed' } });
  await f.app.runtime.session.refresh(); assert.match(f.$('eventDisclosureState').textContent, /View the released result in custody/);
  assert.equal(f.$('eventDisclosureAmount').textContent, '—');
  assert.equal(f.$('eventDisclosureFrom').textContent, '—'); assert.equal(f.$('eventDisclosureTo').textContent, '—');
  change(f, 'custodyDisclosureDelivery', 'page'); assert.match(f.$('eventDisclosureState').textContent, /Request disclosure/);
});

test('main sample fences an unknown mutation and disposes on network change/pagehide', async t => {
  const f = await mount(t), first = f.app.runtime;
  f.$('dappChainSelect').value = 'evm'; f.$('dappChainSelect').dispatchEvent(new f.dom.window.Event('change'));
  assert.equal(first.disposed, 1); first.notify({ actor: { address: 'stale' } }); assert.doesNotMatch(f.$('walletAccount').textContent, /stale/);
  f.$('dappChainSelect').value = 'cosmos'; f.$('dappChainSelect').dispatchEvent(new f.dom.window.Event('change'));
  await f.connect(); const current = f.app.runtime;
  current.client.prepareDeposit = async () => { throw new Error('Synthetic lost reply'); };
  await f.click('depositFromKeplr'); assert.equal(f.$('depositFromKeplr').disabled, true); assert.equal(f.$('custodyError').hidden, false);
  f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'));
  assert.equal(current.disposed, 1); assert.equal(f.$('custodySubmit').disabled, true);
});

test('unavailable connection explains the next action and enables explicit reconnect before deposit', async t => {
  const f = await mount(t); await f.click('connectKeplr'); await f.click('signSession');
  const runtime = f.app.runtime, lookup = runtime.client.getOperation;
  runtime.client.getOperation = async () => { throw Object.assign(new Error('Unauthorized'), { code: 4103 }); };
  await f.click('custodyRefresh');
  assert.equal(f.$('signSession').disabled, false);
  assert.equal(f.$('disconnectWallet').disabled, false);
  assert.equal(f.$('depositFromKeplr').disabled, true);
  assert.match(f.$('custodyError').textContent, /연결.*다시/);
  assert.match(f.$('custodyOperationState').textContent, /Connection request unavailable/);
  assert.doesNotMatch(f.$('custodyActiveStep').textContent, /approval pending/);
  assert.equal(runtime.calls.filter(([kind]) => kind === 'connect').length, 1);
  runtime.client.getOperation = lookup;
  await f.click('signSession');
  assert.equal(f.$('depositFromKeplr').disabled, true, 'renewal still needs explicit custody consent');
  await runtime.session.refresh();
  assert.equal(f.$('depositFromKeplr').disabled, false);
  assert.equal(runtime.calls.filter(([kind]) => kind === 'connect').length, 2);
});

test('backup admission rejection keeps deposit retry usable after trusted verification', async t => {
  const f = await mount(t); await f.connect();
  const runtime = f.app.runtime, prepare = runtime.client.prepareDeposit;
  let rejected = 0;
  runtime.client.prepareDeposit = async () => { rejected++; throw Object.assign(new Error('BACKUP_REQUIRED'), { code: 4114 }); };
  await f.click('depositFromKeplr');
  assert.equal(f.$('depositFromKeplr').disabled, false);
  assert.equal(f.$('disconnectWallet').disabled, false);
  assert.equal(f.$('walletSignatureHash').textContent, 'Approved by custody');
  assert.equal(f.$('custodySubmit').disabled, true);
  assert.match(f.$('custodyError').textContent, /저장한 백업 확인/);
  assert.equal(runtime.session.state.operation.kind, 'connect');
  assert.equal(rejected, 1);
  runtime.client.prepareDeposit = prepare;
  await f.click('depositFromKeplr');
  assert.equal(f.$('depositFromKeplr').disabled, true);
  assert.equal(runtime.session.state.operation.state, 'awaiting_approval');
  assert.equal(runtime.calls.filter(([kind]) => kind === 'deposit').length, 1);
  assert.equal(runtime.calls.filter(([kind]) => kind === 'connect').length, 1);
  assert.equal(runtime.calls.filter(([kind]) => kind === 'submit').length, 0);
});

test('expired deposit consent stays on the DApp with explicit reconnect instead of opening an empty workbench', async t => {
  const f = await mount(t); await f.connect();
  const runtime = f.app.runtime, before = runtime.presentations;
  runtime.client.getOperation = async () => { throw Object.assign(new Error('Expired grant'), { code: 4103 }); };
  await f.click('depositFromKeplr');
  assert.equal(runtime.presentations, before);
  assert.equal(runtime.calls.filter(([kind]) => kind === 'deposit').length, 0);
  assert.equal(runtime.session.state.uncertain, false);
  assert.equal(f.$('signSession').disabled, false);
  assert.equal(f.$('signSession').textContent, 'Reconnect custody');
  assert.match(f.$('custodyError').textContent, /Reconnect custody/);
  await f.click('signSession');
  const renewed = f.app.runtime;
  assert.notEqual(renewed, runtime); assert.equal(runtime.disposed, 1);
  assert.equal(renewed.calls.filter(([kind]) => kind === 'connect').length, 1);
  assert.equal(f.$('depositFromKeplr').disabled, true, 'fresh consent is still required');
  await renewed.session.refresh();
  await f.click('depositFromKeplr');
  assert.equal(renewed.calls.filter(([kind]) => kind === 'deposit').length, 1);
  assert.equal(renewed.calls.filter(([kind]) => kind === 'submit').length, 0);
});

test('main permissions default to the full flow, allow opting out and keep recovery access restricted', async t => {
  const full = await mount(t);
  assert.equal(full.$('custodyFullFlow').checked, true);
  await full.click('connectKeplr');
  assert.equal(full.app.runtime.calls.some(call => call[0] === 'connect'), false);
  await full.click('signSession'); await full.app.runtime.session.refresh();
  assert.deepEqual(full.app.runtime.calls.find(call => call[0] === 'connect')[1].permissions,
    ['deposit.request', 'balance.read', 'account.read', 'transfer.request', 'withdraw.request', 'disclosure.request']);
  const f = await mount(t); await f.connect(false);
  assert.deepEqual(f.app.runtime.calls.find(call => call[0] === 'connect')[1].permissions, ['deposit.request']);
  assert.equal(f.$('transferFromVeiled').disabled, true); assert.equal(f.$('scanKeplrNotes').disabled, true);
  const recovery = await mount(t); await recovery.click('connectKeplr');
  recovery.$('custodyRecoveryIds').value = 'A'.repeat(43); await recovery.click('signSession'); await recovery.app.runtime.session.refresh();
  assert.deepEqual(recovery.app.runtime.calls.find(call => call[0] === 'connect')[1].permissions, []);
  assert.equal(recovery.$('depositFromKeplr').disabled, true); assert.equal(recovery.$('custodySubmit').disabled, true);
});

test('a corrected recovery ID can connect immediately after local input rejection', async t => {
  for (const ids of ['B'.repeat(43), ['A'.repeat(43), 'A'.repeat(43)].join(',')]) {
    const f = await mount(t); await f.click('connectKeplr');
    f.$('custodyRecoveryIds').value = ids; await f.click('signSession');
    assert.equal(f.app.runtime.calls.length, 0); assert.equal(f.$('signSession').disabled, false);
    assert.match(f.$('custodyError').textContent, /입력 형식/);
    f.$('custodyRecoveryIds').value = 'A'.repeat(43); await f.click('signSession'); await f.app.runtime.session.refresh();
    assert.equal(f.app.runtime.calls.filter(([method]) => method === 'connect').length, 1);
    assert.match(f.$('walletSignatureHash').textContent, /recovery only/);
  }
});

test('public chain send remains separate, persists uncertainty and blocks overlapping privacy submissions', async t => {
  const f = await mount(t); await f.connect();
  f.$('keplrSendAmount').value = '3'; f.$('keplrSendRecipient').value = 'synthetic-chain-recipient';
  await f.click('sendFromKeplr'); await f.click('sendFromKeplr');
  assert.equal(f.chainCalls.length, 1); assert.equal(f.chainCalls[0].amount, '3');
  assert.equal(f.$('depositFromKeplr').disabled, true);
  assert.match(f.dom.window.localStorage.getItem('clairveil:public-send:cosmos:synthetic-1:synthetic-wallet'), /submitted/);
});

async function connectEvm(f) {
  f.$('dappChainSelect').value = 'evm';
  f.$('dappChainSelect').dispatchEvent(new f.dom.window.Event('change'));
  await f.click('connectWallet');
  f.$('custodyFullFlow').checked = true; await f.click('signSession'); await f.app.runtime.session.refresh();
  f.$('keplrSendAmount').value = '3'; f.$('keplrSendRecipient').value = '0x' + '12'.repeat(20);
}

test('invalid addresses, preflight failures and explicit wallet rejection leave no persistent send lock', async t => {
  const m = await chainModule(t);
  for (const failure of ['address', 'preflight', 'rejected']) {
    const shared = sharedBrowserState(), f = await mount(t, { ...shared, chainActions: m });
    await connectEvm(f);
    let sends = 0;
    f.dom.window.ethereum = { request: async ({ method }) => {
      if (failure === 'preflight') throw new Error('Read RPC unavailable');
      if (method === 'eth_chainId') return '0x32f';
      if (method === 'eth_accounts') return ['synthetic-wallet'];
      sends++; throw Object.assign(new Error('User rejected'), { code: 4001 });
    } };
    if (failure === 'address') f.$('keplrSendRecipient').value = 'invalid-recipient';
    await f.click('sendFromKeplr');
    assert.equal(sends, failure === 'rejected' ? 1 : 0);
    assert.equal(shared.storage.getItem('clairveil:public-send:eip155:815:synthetic-wallet'), null);
    assert.equal(f.$('sendFromKeplr').disabled, false, failure);
    assert.equal(f.$('depositFromKeplr').disabled, false, failure);
    const reloaded = await mount(t, shared); await connectEvm(reloaded);
    assert.equal(reloaded.$('sendFromKeplr').disabled, false, `${failure} survives reload without a false pending send`);
  }
});

test('a lost wallet broadcast reply stays blocked across reloads', async t => {
  const m = await chainModule(t), shared = sharedBrowserState();
  const f = await mount(t, { ...shared, chainActions: m }); await connectEvm(f);
  const key = 'clairveil:public-send:eip155:815:synthetic-wallet';
  f.dom.window.ethereum = { request: async ({ method }) => {
    if (method === 'eth_chainId') return '0x32f';
    if (method === 'eth_accounts') return ['synthetic-wallet'];
    assert.deepEqual(JSON.parse(shared.storage.getItem(key)), { status: 'unknown' }, 'persist before wallet dispatch');
    throw new Error('Lost provider reply');
  } };
  await f.click('sendFromKeplr');
  assert.equal(f.$('sendFromKeplr').disabled, true);
  const reloaded = await mount(t, shared); await connectEvm(reloaded);
  assert.equal(reloaded.$('sendFromKeplr').disabled, true);
  assert.equal(reloaded.$('depositFromKeplr').disabled, true);
});

function cosmosSendFixture(module) {
  const address = module.toBech32('clair', new Uint8Array(20).fill(1));
  const profile = { ...profiles.cosmos, prefix: 'clair' };
  const actor = { namespace: 'cosmos', chainId: profile.chainId, address, pubKeyHex: '02'.repeat(33) };
  const browser = { keplr: { enable: async () => {}, getKey: async () => ({ bech32Address: address, pubKey: new Uint8Array(33).fill(2) }),
    signDirect: async (_chain, _address, document) => ({ signed: document, signature: { signature: Buffer.alloc(64, 1).toString('base64') } }) } };
  const fetchJson = async url => url.includes('/accounts/') ? { account: { address, account_number: '1', sequence: '1' } } : { result: { node_info: { network: profile.chainId } } };
  return { profile, actor, browser, fetchJson };
}

test('hash-bound Cosmos funds and fee rejections clear the public lock and permit an explicit retry', async t => {
  const module = await chainModule(t), wallet = cosmosSendFixture(module);
  for (const code of [5, 13]) {
    const shared = sharedBrowserState(); let broadcasts = 0;
    const chainActions = { sendTransparent: params => module.sendTransparent({ ...params, ...wallet,
      broadcast: raw => module.broadcastCustodyCosmos(raw, undefined, { fetchImpl: async (url, options) => {
        broadcasts++; assert.equal(url, '/custody-broadcast');
        const request = JSON.parse(options.body); assert.equal(request.mode, 'BROADCAST_MODE_SYNC');
        const txhash = createHash('sha256').update(Buffer.from(request.tx_bytes, 'base64')).digest('hex').toUpperCase();
        return new Response(JSON.stringify({ tx_response: { code: broadcasts === 1 ? code : 0, codespace: 'sdk', height: '0', txhash } }));
      } }) }) };
    const f = await mount(t, { ...shared, chainActions }); await f.connect();
    f.$('keplrSendAmount').value = '1'; f.$('keplrSendRecipient').value = wallet.actor.address; await f.click('sendFromKeplr'); await waitForSend(f);
    assert.equal(broadcasts, 1); assert.match(f.$('custodyError').textContent, /CheckTx rejected/);
    const key = 'clairveil:public-send:cosmos:synthetic-1:synthetic-wallet';
    assert.equal(shared.storage.getItem(key), null); assert.equal(f.$('sendFromKeplr').disabled, false); assert.equal(f.$('depositFromKeplr').disabled, false);
    const reloaded = await mount(t, { ...shared, chainActions }); await reloaded.connect();
    assert.equal(reloaded.$('sendFromKeplr').disabled, false); assert.equal(reloaded.$('depositFromKeplr').disabled, false);
    assert.equal(broadcasts, 1, 'no automatic retry');
    reloaded.$('keplrSendAmount').value = '2'; reloaded.$('keplrSendRecipient').value = wallet.actor.address; await reloaded.click('sendFromKeplr'); await waitForSend(reloaded);
    assert.equal(broadcasts, 2); assert.equal(JSON.parse(shared.storage.getItem(key)).status, 'submitted');
  }
});

test('Cosmos lost, duplicate and uncorrelated replies retain the signed hash and reconcile across reloads', async t => {
  const module = await chainModule(t), wallet = cosmosSendFixture(module);
  for (const outcome of ['lost', 'duplicate', 'wrong-hash', 'wrong-success-hash']) {
    const shared = sharedBrowserState(); let broadcasts = 0, signedHash;
    const key = 'clairveil:public-send:cosmos:synthetic-1:synthetic-wallet';
    const f = await mount(t, { ...shared, chainActions: { sendTransparent: params => module.sendTransparent({ ...params, ...wallet,
      broadcast: raw => module.broadcastCustodyCosmos(raw, undefined, { fetchImpl: async () => {
        broadcasts++;
        signedHash = createHash('sha256').update(raw).digest('hex');
        assert.deepEqual(JSON.parse(shared.storage.getItem(key)), { status: 'unknown', hash: signedHash }, 'persist exact signed identity before any broadcast');
        if (outcome === 'lost') throw new Error('Synthetic lost broadcast reply');
        return new Response(JSON.stringify({ tx_response: { code: outcome === 'duplicate' ? 19 : outcome === 'wrong-success-hash' ? 0 : 5, codespace: 'sdk', height: '0',
          txhash: outcome.startsWith('wrong-') ? 'f'.repeat(64) : signedHash } }));
      } }) }) } });
    await f.connect(); f.$('keplrSendAmount').value = '1'; f.$('keplrSendRecipient').value = wallet.actor.address; await f.click('sendFromKeplr'); await waitForSend(f);
    assert.equal(broadcasts, 1); assert.equal(f.$('sendFromKeplr').disabled, true);
    let lookupHash = 'e'.repeat(64), lookups = 0;
    const reloaded = await mount(t, { ...shared, fetchJson: async url => {
      assert(url.endsWith(signedHash)); lookups++; return { tx_response: { txhash: lookupHash, height: '8', code: 0 } };
    } }); await reloaded.connect();
    assert.equal(reloaded.$('sendFromKeplr').disabled, true); assert.equal(reloaded.$('depositFromKeplr').disabled, true);
    assert.equal(reloaded.$('reconcileKeplrSend').disabled, false); assert.equal(reloaded.$('keplrSendHash').textContent, signedHash);
    await reloaded.click('reconcileKeplrSend'); assert.equal(reloaded.$('depositFromKeplr').disabled, true, 'a different transaction does not resolve this send');
    lookupHash = signedHash.toUpperCase(); await reloaded.click('reconcileKeplrSend');
    assert.equal(lookups, 2); assert.equal(shared.storage.getItem(key), null);
    assert.equal(reloaded.$('sendFromKeplr').disabled, false); assert.equal(reloaded.$('depositFromKeplr').disabled, false);
    assert.equal(broadcasts, 1, 'reconciliation never rebroadcasts');
  }
});

test('Cosmos broadcast stops if the signed hash cannot be persisted', async t => {
  const module = await chainModule(t), wallet = cosmosSendFixture(module);
  let broadcasts = 0;
  await assert.rejects(module.sendTransparent({ ...wallet, amount: '1', recipient: wallet.actor.address,
    beforeBroadcast: () => { throw new Error('Storage unavailable'); }, broadcast: () => { broadcasts++; }
  }), /Storage unavailable/);
  assert.equal(broadcasts, 0);
});

test('malformed or non-CheckTx Cosmos failures never count as definitive rejection', async t => {
  const module = await chainModule(t), raw = new Uint8Array([1, 2, 3]);
  const txhash = createHash('sha256').update(raw).digest('hex');
  for (const change of [{ code: 32 }, { code: 99 }, { code: '5' }, { height: '12' }, { height: undefined }, { codespace: 'other' }, { txhash: 'bad' }]) {
    await assert.rejects(module.broadcastCustodyCosmos(raw, undefined, { fetchImpl: async () => new Response(JSON.stringify({ tx_response: { code: 5, codespace: 'sdk', height: '0', txhash, ...change } })) }), error => error.cosmosCheckTxRejected !== true);
  }
  for (const response of [new Response('unavailable', { status: 503 }), new Response('{')]) {
    await assert.rejects(module.broadcastCustodyCosmos(raw, undefined, { fetchImpl: async () => response }), error => error.cosmosCheckTxRejected !== true);
  }
});

test('stale tabs cannot overwrite a pending send or dispatch custody work', async t => {
  const shared = sharedBrowserState();
  const a = await mount(t, shared), b = await mount(t, shared), c = await mount(t, shared);
  for (const f of [a, b, c]) { await f.connect(); f.$('keplrSendAmount').value = '3'; f.$('keplrSendRecipient').value = 'synthetic-recipient'; }
  await a.click('sendFromKeplr');
  const key = 'clairveil:public-send:cosmos:synthetic-1:synthetic-wallet', saved = shared.storage.getItem(key);
  assert.equal(b.$('sendFromKeplr').disabled, false, 'no storage event has arrived yet');
  await b.click('sendFromKeplr'); await c.click('depositFromKeplr');
  assert.equal(b.chainCalls.length, 0);
  assert.equal(c.app.runtime.calls.filter(([method]) => method === 'deposit').length, 0);
  assert.equal(shared.storage.getItem(key), saved);
  assert.equal(b.$('sendFromKeplr').disabled, true);
  shared.storage.removeItem(key);
  b.dom.window.dispatchEvent(new b.dom.window.StorageEvent('storage', { key, newValue: null }));
  assert.equal(b.$('sendFromKeplr').disabled, false, 'storage events update the visible controls');
});

test('concurrent tabs reject busy-account requests without deferred signing', async t => {
  const shared = sharedBrowserState(); let resume, sends = 0;
  const a = await mount(t, { ...shared, chainActions: { sendTransparent: async ({ beforeBroadcast }) => {
    await new Promise(resolve => { resume = resolve; }); beforeBroadcast(); sends++; return 'a'.repeat(64);
  } } }), b = await mount(t, shared);
  for (const f of [a, b]) { await f.connect(); f.$('keplrSendAmount').value = '3'; f.$('keplrSendRecipient').value = 'synthetic-recipient'; }
  await a.click('sendFromKeplr'); await b.click('sendFromKeplr'); await b.click('depositFromKeplr');
  assert.match(b.$('custodyError').textContent, /Another tab/);
  assert.equal(b.chainCalls.length, 0);
  assert.equal(b.app.runtime.calls.filter(([method]) => method === 'deposit').length, 0);
  resume(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 1); assert.equal(b.chainCalls.length, 0);
});

test('missing Web Locks or unavailable persistence stop before public wallet dispatch', async t => {
  for (const unavailable of ['locks', 'storage']) {
    const shared = sharedBrowserState();
    if (unavailable === 'locks') shared.locks = null;
    else shared.storage.setItem = () => { throw new Error('Storage unavailable'); };
    const f = await mount(t, shared); await f.connect();
    f.$('keplrSendAmount').value = '3'; f.$('keplrSendRecipient').value = 'synthetic-recipient';
    await f.click('sendFromKeplr'); assert.equal(f.chainCalls.length, 0);
  }
});

async function chainModule(t) {
  const { build } = await import('esbuild');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { custodySdkAliases } = await import('../tools/custody-sdk.mjs');
  const temporary = await mkdtemp(path.join(root, '.react-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const outfile = path.join(temporary, 'chain.mjs');
  await build({ stdin: { contents: `export { sendTransparent } from './public/sample-chain-actions.js'; export { broadcastCustodyCosmos } from './public/custody-wallet.js'; export { TxRaw, TxBody, AuthInfo } from 'cosmjs-types/cosmos/tx/v1beta1/tx.js'; export { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx.js'; export { toBech32 } from '@cosmjs/encoding';`, resolveDir: root },
    outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', alias: await custodySdkAliases() });
  return import(pathToFileURL(outfile));
}

test('ordinary Cosmos bank send preserves recipient/value/sign bytes and broadcasts only once', async t => {
  const m = await chainModule(t);
  const address = m.toBech32('clair', new Uint8Array(20).fill(1));
  const recipient = m.toBech32('clair', new Uint8Array(20).fill(2));
  const actor = { namespace: 'cosmos', chainId: 'synthetic-1', address, pubKeyHex: '02'.repeat(33) };
  const profile = { ...profiles.cosmos, prefix: 'clair' };
  let signedDocument, count = 0, signedHash;
  const browser = { keplr: { enable: async () => {}, getKey: async () => ({ bech32Address: address, pubKey: new Uint8Array(33).fill(2) }),
    signDirect: async (_chain, _address, document) => { signedDocument = document; return { signed: document, signature: { signature: Buffer.alloc(64, 1).toString('base64') } }; } } };
  const fetchJson = async url => url.includes('/accounts/') ? { account: { address, account_number: '9007199254740993', sequence: '7' } }
    : { result: { node_info: { network: profile.chainId } } };
  const hash = await m.sendTransparent({ profile, actor, browser, recipient, amount: '123', fetchJson,
    broadcast: async raw => {
      count++; const tx = m.TxRaw.decode(raw), body = m.TxBody.decode(tx.bodyBytes), auth = m.AuthInfo.decode(tx.authInfoBytes);
      const send = m.MsgSend.decode(body.messages[0].value);
      assert.equal(send.toAddress, recipient); assert.equal(send.amount[0].amount, '123'); assert.equal(auth.signerInfos[0].sequence, 7n);
      assert.equal(tx.signatures[0].length, 64); signedHash = createHash('sha256').update(raw).digest('hex'); return signedHash.toUpperCase();
    } });
  assert.equal(hash, signedHash); assert.equal(count, 1);
  assert.equal(signedDocument.accountNumber.toString(), '9007199254740993');
  browser.keplr.signDirect = async (_chain, _address, document) => ({ signed: { ...document, bodyBytes: new Uint8Array([0]) }, signature: { signature: Buffer.alloc(64).toString('base64') } });
  await assert.rejects(m.sendTransparent({ profile, actor, browser, recipient, amount: '123', fetchJson, broadcast: async () => { count++; } }), /differs/);
  assert.equal(count, 1, 'wallet-modified public transaction never broadcasts');
});

test('pagehide during ordinary wallet account lookup aborts Cosmos signing', async t => {
  const m = await chainModule(t), controller = new AbortController();
  const address = m.toBech32('clair', new Uint8Array(20).fill(1));
  const actor = { namespace: 'cosmos', chainId: 'synthetic-1', address, pubKeyHex: '02'.repeat(33) };
  let signs = 0;
  const browser = { keplr: { enable: async () => {}, getKey: async () => { controller.abort(); return { bech32Address: address, pubKey: new Uint8Array(33).fill(2) }; },
    signDirect: async () => { signs++; } } };
  await assert.rejects(m.sendTransparent({ profile: { ...profiles.cosmos, prefix: 'clair' }, actor, browser, recipient: address, amount: '3', signal: controller.signal,
    fetchJson: async url => url.includes('/accounts/') ? { account: { address, account_number: '1', sequence: '1' } } : { result: { node_info: { network: 'synthetic-1' } } } }));
  assert.equal(signs, 0);
});

test('manual custody controls present the workbench before their RPC while ordinary reads and polling stay quiet', async t => {
  const cases = [
    ['setupKeplrPrivacy', 'getPublicAccount'], ['scanKeplrNotes', 'getBalances'],
    ['depositFromKeplr', 'prepareDeposit'], ['transferFromVeiled', 'authorizeTransfer'], ['withdrawFromVeiled', 'authorizeWithdraw'],
    ['custodyRefresh', 'getOperation', 'awaiting_approval'], ['custodyCancel', 'cancelOperation', 'awaiting_approval'],
    ['cancelDepositProof', 'cancelOperation', 'awaiting_approval'], ['custodySubmit', 'submit', 'awaiting_chain_signature'],
    ['reconcileKeplrDeposit', 'reconcile', 'submitted'], ['disconnectWallet', 'disconnect'],
    ['decodeEventDisclosure', 'requestDisclosure'], ['decodeSelfViewDisclosure', 'requestDisclosure'], ['decodeDisclosureSource', 'requestDisclosure']
  ];
  for (const [id, method, operationState] of cases) {
    const f = await mount(t); await f.click('connectKeplr');
    assert.equal(f.app.runtime.presentations, 0, 'ordinary wallet connection does not open custody');
    f.$('custodyFullFlow').checked = true;
    await f.click('signSession'); await f.app.runtime.session.refresh();
    assert.equal(f.app.runtime.presentations, 1, 'custody connection opens the workbench');
    await f.app.runtime.session.publicAccount();
    if (operationState) {
      await f.app.runtime.session.deposit('1');
      f.app.runtime.setOperation({ operationId: 'deposit', kind: 'deposit', state: operationState, publicArtifact: {} });
      await f.app.runtime.session.refresh();
    }
    for (const field of ['keplrDepositAmount', 'veiledTransferAmount', 'veiledWithdrawAmount']) f.$(field).value = '1';
    change(f, 'disclosureSourceTxHash', 'a'.repeat(64), 'input');
    const runtime = f.app.runtime, before = runtime.presentations, original = runtime.client[method]; let calls = 0;
    runtime.client[method] = async params => {
      assert.equal(runtime.presentations, before + 1, `${id}: present before ${method}`); calls++; return original(params);
    };
    assert.equal(f.$(id).disabled, false, id); await f.click(id);
    assert.equal(runtime.presentations, before + 1, id); assert.equal(calls, 1, id);
  }
  const f = await mount(t, { pollMs: 10 }); await f.connect(); f.$('keplrDepositAmount').value = '1'; await f.click('depositFromKeplr');
  f.app.runtime.setOperation({ operationId: 'deposit', kind: 'deposit', state: 'awaiting_approval' });
  const before = f.app.runtime.presentations;
  await new Promise(resolve => setTimeout(resolve, 45));
  assert(f.app.runtime.calls.filter(([method]) => method === 'poll').length >= 2);
  assert.equal(f.app.runtime.presentations, before, 'automatic polling does not present custody');
});

test('waiting for the workbench blocks double clicks and fences a late open after pagehide', async t => {
  let balance;
  const f = await mount(t, { chainActions: { readTransparentBalance: () => new Promise(resolve => { balance = resolve; }) } }); await f.click('connectKeplr');
  await f.click('refreshKeplrBalance');
  const runtime = f.app.runtime; let opened;
  runtime.present = () => new Promise(resolve => { opened = resolve; });
  await f.click('signSession'); assert.equal(f.$('signSession').disabled, true); assert.equal(f.$('disconnectWallet').disabled, true);
  balance('1'); await tick(); assert.equal(f.$('signSession').disabled, true, 'an unrelated read cannot release the pending presentation');
  await f.click('signSession'); assert.equal(runtime.calls.length, 0);
  f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide')); opened(); await tick();
  assert.equal(runtime.calls.length, 0, 'late presentation never creates a custody request');
});

test('unavailable custody window leaves the action retryable without dispatching or inventing an operation', async t => {
  const f = await mount(t); await f.click('connectKeplr');
  f.app.runtime.present = async () => { throw new Error('Extension unavailable'); };
  await f.click('signSession'); assert.equal(f.app.runtime.calls.length, 0); assert.equal(f.$('signSession').disabled, false);
  assert.equal(f.app.runtime.session.state.uncertain, false); assert.equal(f.app.runtime.session.state.operation, null);
  assert.match(f.$('custodyError').textContent, /Extension unavailable/);
});
