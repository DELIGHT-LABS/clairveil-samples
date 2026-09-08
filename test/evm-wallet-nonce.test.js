import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { withPublicEvmNonce } from "../public/evm-wallet-nonce.js";
import { loadPublicPendingTxState, savePublicPendingTxState } from "../public/public-pending-tx-store.js";

const sender = `0x${"12".repeat(20)}`;
const txHash = `0x${"ab".repeat(32)}`;
const attemptId = "cd".repeat(32);
function clientFixture({ latest = "0x2", pending = "0x3" } = {}) {
  return {
    calls: [],
    async assertEvmNetwork() { this.calls.push("network"); },
    async evmJsonRpc(method, params) {
      this.calls.push([method, params]);
      assert.equal(method, "eth_getTransactionCount");
      assert.equal(params[0], sender);
      return params[1] === "latest" ? latest : pending;
    }
  };
}

test("public EVM requests use the authoritative pending nonce without changing the prepared call", async () => {
  const client = clientFixture();
  const tx = { from: sender, to: sender, data: "0x1234", value: "0x1", gas: "0x10000", chainId: "0x32f", __clairveilEvmTransaction: { expectedData: "0x1234" } };
  assert.deepEqual(await withPublicEvmNonce(client, tx), { ...tx, nonce: "0x3" });
  assert.equal(tx.nonce, undefined);
  assert.deepEqual(client.calls, ["network", ["eth_getTransactionCount", [sender, "latest"]],
    ["eth_getTransactionCount", [sender, "pending"]], "network"]);
  assert.equal((await withPublicEvmNonce(client, { ...tx, nonce: "0x4" })).nonce, "0x4");
});

test("stale explicit nonces and inconsistent or unavailable RPC state fail before the wallet boundary", async () => {
  for (const nonce of ["0x1", "0x2"])
    await assert.rejects(withPublicEvmNonce(clientFixture(), { from: sender, nonce }), { code: "EVM_NONCE_STALE_BEFORE_WALLET" });
  for (const options of [{ pending: "0x1" }, { latest: "2" }, { pending: "0x03" }, { pending: null }])
    await assert.rejects(withPublicEvmNonce(clientFixture(options), { from: sender }));
  await assert.rejects(withPublicEvmNonce(clientFixture(), { from: "invalid" }));
  const client = clientFixture();
  client.assertEvmNetwork = async () => { throw new Error("wrong network"); };
  await assert.rejects(withPublicEvmNonce(client, { from: sender }), /wrong network/);
});

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
function functionSource(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n(?:async )?function /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

function harness(error, { failSave = false, privateRequest = false } = {}) {
  const calls = [];
  const identity = { key: "pending", profileId: "evm", owner: sender };
  const session = { publicPendingIdentity: identity };
  const records = new Map();
  const storage = {
    getItem: key => records.get(key) ?? null,
    setItem: (key, value) => { records.set(key, value); },
    removeItem: key => { records.delete(key); }
  };
  const otherSend = { status: "unknown", txHash };
  savePublicPendingTxState(storage, identity.key, {
    ...identity, send: otherSend, deposit: { status: "attempting", attemptId }
  });
  records.set("private-fence", "preserve-private-reservations");
  const context = vm.createContext({
    state: { wallet: { account: sender }, keplr: { sendStatus: "unknown", sendHash: txHash, depositRecoveryStatus: "attempting" } },
    privacySessionSnapshot: () => session, assertPrivacySession: () => {}, privacySessionIsCurrent: () => true,
    ensureMetaMaskChain: async () => {}, withEstimatedEvmGas: async tx => tx,
    clairveilBrowserClient: () => clientFixture(), withPublicEvmNonce,
    requestMetaMask: async ({ method, params }) => {
      calls.push([method, params[0].nonce]);
      if (error) throw error;
      return txHash;
    },
    localStorage: storage, loadPublicPendingTxState,
    savePublicPendingTxState: (...args) => {
      if (failSave) throw new Error("storage failure");
      return savePublicPendingTxState(...args);
    },
    renderKeplr: () => {}, attachSubmittedEvmTransactionEvidence: (err, hash) => Object.assign(err, { txHash: hash })
  });
  for (const name of ["publicPendingEntriesWith", "clearCapturedPublicTransactionAttempt",
    "isExplicitWalletRejection", "runSynchronousWalletBoundaryCallback", "evmWalletAdapter"])
    vm.runInContext(functionSource(name), context);
  const adapter = context.evmWalletAdapter(session, privateRequest ? {} : {
    onTransactionAttempt: () => { calls.push("attempt"); return attemptId; },
    onTransactionHash: () => calls.push("hash"),
    onTransactionRejected: id => context.clearCapturedPublicTransactionAttempt(session, "deposit", id)
  });
  return { adapter, context, calls, records, storage, identity, session, otherSend,
    saved: () => loadPublicPendingTxState(storage, identity.key, identity) };
}

test("real adapter sets nonce before opening the wallet and durably capturing the hash", async () => {
  const h = harness(null);
  assert.equal(await h.adapter.sendTransaction({ to: sender }), txHash);
  assert.deepEqual(h.calls, ["attempt", ["eth_sendTransaction", "0x3"], "hash"]);
  const stale = harness(null);
  await assert.rejects(stale.adapter.sendTransaction({ to: sender, nonce: "0x1" }), { code: "EVM_NONCE_STALE_BEFORE_WALLET" });
  assert.deepEqual(stale.calls, []); // No new marker and no wallet request.
});

test("wallet cancellation clears only its exact public attempt and updates in-memory status", async () => {
  const h = harness(Object.assign(new Error("Rejected"), { code: 4001 }));
  await assert.rejects(h.adapter.sendTransaction({ to: sender }), { code: 4001 });
  assert.equal(h.saved().deposit, null);
  assert.deepEqual(h.saved().send, h.otherSend);
  assert.equal(h.context.state.keplr.depositRecoveryStatus, "failed");
  assert.equal(h.context.state.keplr.sendStatus, "unknown");
  assert.equal(h.records.get("private-fence"), "preserve-private-reservations");
});

test("post-wallet nonce errors, timeouts and failed persistence retain recovery state with no retry", async () => {
  for (const [error, options] of [
    [Object.assign(new Error("nonce too low: next nonce 2, tx nonce 1"), { code: -32603 }), {}],
    [new Error("timeout after acceptance"), {}],
    [Object.assign(new Error("Rejected"), { code: 4001 }), { failSave: true }]
  ]) {
    const h = harness(error, options);
    await assert.rejects(h.adapter.sendTransaction({ to: sender }));
    assert.equal(h.saved().deposit.attemptId, attemptId);
    assert.equal(h.context.state.keplr.depositRecoveryStatus, "attempting");
    assert.deepEqual(h.calls, ["attempt", ["eth_sendTransaction", "0x3"]]);
  }
});

test("the standalone private adapter never alters public pending records", async () => {
  const h = harness(null, { privateRequest: true });
  assert.equal(await h.adapter.sendTransaction({ to: sender }), txHash);
  assert.deepEqual(h.calls, [["eth_sendTransaction", undefined]]);
  assert.equal(h.saved().deposit.attemptId, attemptId);
});

function submissionHarness(error = null, options = {}) {
  const h = harness(error, { privateRequest: true });
  const client = clientFixture({ latest: "0x6", pending: "0x6" });
  const sdkRequests = [];
  client.sendEvmTransaction = async request => {
    sdkRequests.push(request);
    h.calls.push("sdk-boundary");
    return request.wallet.sendTransaction(request.transaction);
  };
  Object.assign(h.context, {
    metaMaskProvider: () => ({}),
    clairveilBrowserClient: () => client,
    normalizedHex: value => String(value || "").replace(/^0x/i, "").toLowerCase(),
    normalizeEvmTxHash: value => value,
    assertPrivacySessionAfterEvmSubmission: () => {},
    withAccountTransactionLock: async (_session, execute) => {
      h.calls.push("lock");
      try { return await execute(); } finally { h.calls.push("unlock"); }
    },
    ...options
  });
  vm.runInContext(functionSource("submitEvmTransaction"), h.context);
  return { ...h, client, sdkRequests };
}

for (const kind of ["transfer", "withdraw"]) {
  test(`private ${kind} prepares fresh nonce before SDK boundary without changing its transaction binding`, async () => {
    const h = submissionHarness();
    const transaction = { to: sender, data: "0x1234", __clairveilEvmTransaction: { operation: kind } };
    const reservation = { reservation_ids: ["input", "zero-helper"] };
    assert.equal(await h.context.submitEvmTransaction(transaction, { reservation }), txHash);
    assert.deepEqual(h.calls, ["lock", "sdk-boundary", ["eth_sendTransaction", "0x6"], "unlock"]);
    assert.equal(h.sdkRequests[0].transaction, transaction);
    assert.equal(h.sdkRequests[0].reservation, reservation);
    assert.equal(transaction.nonce, undefined);
    assert.equal(h.saved().deposit.attemptId, attemptId);
  });
}

test("private stale nonce or failed nonce lookup never enters SDK broadcast or wallet boundary", async () => {
  for (const failure of ["stale", "rpc", "sender", "session"]) {
    const h = submissionHarness();
    const transaction = { to: sender };
    if (failure === "stale") transaction.nonce = "0x5";
    if (failure === "rpc") h.client.evmJsonRpc = async () => { throw new Error("RPC unavailable"); };
    if (failure === "sender") transaction.from = `0x${"34".repeat(20)}`;
    if (failure === "session") {
      const rpc = h.client.evmJsonRpc.bind(h.client);
      h.client.evmJsonRpc = async (...args) => {
        const result = await rpc(...args);
        h.context.assertPrivacySession = () => { throw new Error("session changed"); };
        return result;
      };
    }
    await assert.rejects(h.context.submitEvmTransaction(transaction));
    assert.deepEqual(h.calls, ["lock", "unlock"]);
    assert.equal(h.sdkRequests.length, 0);
  }
});

test("existing public account lock is reused and post-wallet nonce rejection is not converted to cancellation", async () => {
  const error = Object.assign(new Error("nonce too low: next nonce 7, tx nonce 6"), { code: -32603 });
  const h = submissionHarness(error);
  await assert.rejects(h.context.submitEvmTransaction({ to: sender }, {
    accountTransactionLockHeld: true
  }), caught => caught === error);
  assert.deepEqual(h.calls, ["sdk-boundary", ["eth_sendTransaction", "0x6"]]);
  assert.equal(h.saved().deposit.attemptId, attemptId);
});

test("reviewed hashless recovery preserves other transactions and rejects replaced attempts", async () => {
  const h = harness(null);
  assert.throws(() => h.context.clearCapturedPublicTransactionAttempt(h.session, "deposit", "ef".repeat(32)), /different unresolved/);
  Object.assign(h.context, {
    publicPendingIdentity: () => h.identity,
    window: { confirm: () => true },
    withPublicTransactionLock: async (_session, task) => task(),
    hydratePublicPendingTransactions: () => {}, isStalePrivacySessionError: () => false
  });
  vm.runInContext(functionSource("clearPublicPendingTransactions"), h.context);
  await h.context.clearPublicPendingTransactions();
  assert.equal(h.saved().deposit, null);
  assert.deepEqual(h.saved().send, h.otherSend);
  assert.equal(h.context.state.keplr.depositRecoveryStatus, "idle");
  assert.match(h.context.state.keplr.depositRecoveryMessage, /does not cancel/);
  assert.equal(h.records.get("private-fence"), "preserve-private-reservations");
});
