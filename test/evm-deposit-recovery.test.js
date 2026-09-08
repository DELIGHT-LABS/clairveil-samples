import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Interface } from "ethers";
import { createClairveilEvmClient } from "clairveiljs/evm";
import { ClairveilBrowserClient } from "clairveiljs/browser-wallet";
import { EncryptedLocalStorageOperationStore } from "../public/encrypted-operation-store.js";
import { loadPublicPendingTxState, savePublicPendingTxState } from "../public/public-pending-tx-store.js";
import {
  saveEvmDepositRecovery, loadEvmDepositRecovery, waitForPreparedEvmPrivacy,
  waitForLegacyEvmDeposit, recoveredLegacyEvmDepositNote
} from "../public/evm-deposit-recovery.js";

const hash = `0x${"ab".repeat(32)}`;
const sender = `0x${"11".repeat(20)}`;
const contractAddress = `0x${"22".repeat(20)}`;
const commitment = `0x${"33".repeat(32)}`;
const blockHash = `0x${"44".repeat(32)}`;
const iface = new Interface(["event PrivacyDeposit(address indexed sender, address indexed creator, string amount, bytes noteCommitment)"]);
const event = iface.encodeEventLog(iface.getEvent("PrivacyDeposit"), [sender, sender, "3utest", commitment]);
const receipt = { transactionHash: hash, status: "0x1", blockNumber: "0x9", blockHash,
  logs: [{ address: contractAddress, ...event }] };

function setup() {
  const evm = createClairveilEvmClient({ defaultDenom: "utest", nativeDenom: "utest", contractAddress, evmChainId: "0x539" });
  const built = evm.buildDepositTransaction({ message: {
    amount: "3utest", noteCommitment: new Uint8Array(32).fill(0x33),
    encryptedNote: new Uint8Array(4).fill(0x55), proof: new Uint8Array(8).fill(0x66)
  } });
  const transaction = { ...built.transaction, chainId: "0x539" };
  const rpcTx = { hash, from: sender, to: transaction.to, input: transaction.data,
    value: transaction.value, chainId: "0x539" };
  const client = {
    evm, evmChainId: "0x539", evmFinalityPolicy: null,
    async assertEvmNetwork() {},
    async waitForEvmReceipt() { return receipt; },
    async evmJsonRpc(method) {
      if (method === "eth_getTransactionByHash") return rpcTx;
      if (method === "eth_getTransactionReceipt") return receipt;
      if (method === "eth_getBlockByNumber") return { number: "0x9", hash: blockHash };
      if (method === "eth_blockNumber") return "0x9";
      if (method === "eth_chainId") return "0x539";
      assert.fail(method);
    },
    waitForEvmTransaction: ClairveilBrowserClient.prototype.waitForEvmTransaction
  };
  return { client, transaction, rpcTx };
}

function storage() {
  const map = new Map();
  return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
}

test("encrypted reload preserves actual SDK transaction metadata and verifies receipt without submitting", async () => {
  const { client, transaction } = setup();
  const backing = storage();
  const options = { storage: backing, cryptoImpl: webcrypto, requireLocks: false,
    key: "deposit-recovery", namespace: "chain:owner", keyMaterial: new Uint8Array(32).fill(1) };
  const store = await EncryptedLocalStorageOperationStore.open(options);
  const id = await saveEvmDepositRecovery(store, transaction, sender, { noteCommitmentHex: commitment });
  assert.ok(![...backing.map.values()].join("").includes(transaction.data));
  const reopened = await EncryptedLocalStorageOperationStore.open(options);
  const saved = await loadEvmDepositRecovery(reopened, id, sender);
  const verified = await waitForPreparedEvmPrivacy(client, hash, saved);
  assert.equal(verified.ok, true);
  assert.equal(verified.evmTransactionVerified, true);
  assert.equal(verified.evmPrivacyReceiptVerified, true);
  assert.equal(verified.evmFinalityVerified, true);
  await assert.rejects(loadEvmDepositRecovery(reopened, id, contractAddress), /mismatched/);
  const wrongKey = await EncryptedLocalStorageOperationStore.open({ ...options, keyMaterial: new Uint8Array(32).fill(2) });
  await assert.rejects(loadEvmDepositRecovery(wrongKey, id, sender), /cannot be decrypted/);
});

test("storage failure stops before the wallet boundary", async () => {
  await assert.rejects(saveEvmDepositRecovery(null, setup().transaction, sender), /storage is required/);
  await assert.rejects(saveEvmDepositRecovery({ save: async () => { throw new Error("quota"); } }, setup().transaction, sender), /quota/);
});

test("pending attempt, hash promotion and included recovery retain only the encrypted record pointer", () => {
  const backing = storage();
  const identity = { profileId: "evm", owner: sender };
  for (const status of ["attempting", "unknown", "recovery-pending"]) {
    savePublicPendingTxState(backing, "pending", { ...identity, deposit: {
      status, txHash: status === "attempting" ? "" : hash,
      attemptId: "aa".repeat(32), evmRecoveryId: "bb".repeat(32)
    } });
    assert.equal(loadPublicPendingTxState(backing, "pending", identity).deposit.evmRecoveryId, "bb".repeat(32));
  }
});

test("RPC response loss keeps exact hash pending, and a later lookup succeeds", async () => {
  const { client, transaction } = setup();
  const binding = { privacyTransaction: transaction, sender };
  client.waitForEvmReceipt = async () => null;
  assert.equal((await waitForPreparedEvmPrivacy(client, hash, binding)).unknown, true);
  client.waitForEvmReceipt = async () => receipt;
  assert.equal((await waitForPreparedEvmPrivacy(client, hash, binding)).ok, true);
});

test("missing preparation and transport failures retain the exact pending hash", async () => {
  const { client, transaction } = setup();
  await assert.rejects(waitForPreparedEvmPrivacy(client, hash), error => error.txHash === hash);
  client.waitForEvmReceipt = async () => { throw new Error("offline"); };
  await assert.rejects(waitForPreparedEvmPrivacy(client, hash, { privacyTransaction: transaction, sender }), error => {
    assert.equal(error.txHash, hash);
    assert.equal(error.code, "TX_RESULT_UNKNOWN");
    return true;
  });
});

test("only an exact SDK-verified reverted transaction supplies failure evidence", async () => {
  const { client, transaction, rpcTx } = setup();
  client.waitForEvmReceipt = async () => ({ ...receipt, status: "0x0", logs: [] });
  const binding = { privacyTransaction: transaction, sender };
  await assert.rejects(waitForPreparedEvmPrivacy(client, hash, binding), error => error.code === "TX_FAILED_ON_CHAIN");
  rpcTx.from = contractAddress;
  await assert.rejects(waitForPreparedEvmPrivacy(client, hash, binding), error => {
    assert.equal(error.code, "TX_RESULT_UNKNOWN");
    assert.equal(error.broadcast.receipt, undefined);
    return true;
  });
});

for (const mismatch of ["sender", "calldata", "event", "chain", "reorg"]) {
  test(`${mismatch} mismatch stays unknown, not success or releasable failure`, async () => {
    const { client, transaction, rpcTx } = setup();
    if (mismatch === "sender") rpcTx.from = contractAddress;
    if (mismatch === "calldata") rpcTx.input = "0x1234";
    if (mismatch === "event") client.waitForEvmReceipt = async () => ({ ...receipt, logs: [] });
    const rpc = client.evmJsonRpc;
    if (mismatch === "chain" || mismatch === "reorg") client.evmJsonRpc = async method => {
      if (method === "eth_chainId" && mismatch === "chain") return "0x1";
      if (method === "eth_getBlockByNumber" && mismatch === "reorg") return { number: "0x9", hash };
      return rpc(method);
    };
    await assert.rejects(waitForPreparedEvmPrivacy(client, hash, { privacyTransaction: transaction, sender }), error => {
      assert.equal(error.code, "TX_RESULT_UNKNOWN");
      assert.equal(error.broadcast.receipt, undefined);
      return true;
    });
  });
}

test("hash-only deposit recovery binds canonical event to an owned scan note, not RPC calldata", async () => {
  const { client } = setup();
  const result = await waitForLegacyEvmDeposit(client, hash, { sender, contractAddress });
  assert.equal(result.recoveryOnly, true);
  const note = { commitment, height: 9, amount: "3" };
  assert.equal(recoveredLegacyEvmDepositNote([note], result, "utest"), note);
  assert.equal(recoveredLegacyEvmDepositNote([{ ...note, height: 8 }], result, "utest"), null);
  assert.equal(recoveredLegacyEvmDepositNote([note], result, "other"), null);
  assert.equal(recoveredLegacyEvmDepositNote([{ ...note, commitment: hash }], result, "utest"), null);
  await assert.rejects(waitForLegacyEvmDeposit(client, hash, { sender: contractAddress, contractAddress }), /identity mismatch/);
});

test("web persists recovery before wallet submission and preserves original bindings in both wait paths", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const prepared = source.slice(source.indexOf("async function broadcastPreparedPrivacy("), source.indexOf("function evmReceiptHasFailed("));
  assert.ok(prepared.indexOf("await saveEvmDepositRecovery(") < prepared.indexOf("sendEvmTransaction(data.transaction"));
  assert.match(prepared, /publicEvmTransactionBoundaryCallbacks\(sessionContext, options.publicPendingKind, evmRecoveryId\)/);
  assert.match(source, /privacyTransaction: transaction, sender/);
  assert.match(source, /waitForEvmTransaction\(txHash, "EVM deposit", saved\)/);
  assert.match(source, /previous\?\.evmRecoveryId/);
});
