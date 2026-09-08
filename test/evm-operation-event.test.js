import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { findEvmTransferOperationEvent, verifiedEvmOperationEvidence } from "../public/evm-operation-event.js";
import { evmTransactionBindingHash } from "clairveiljs/evm";
import { createNoteReservationManager, MemoryReservationStore, preparePlanReservation, operationStatuses } from "clairveiljs/reservation";

const evmHash = `0x${"12".repeat(32)}`;
const blockHash = `0x${"34".repeat(32)}`;
const contract = `0x${"56".repeat(20)}`;
const rawTx = Buffer.from("fixture Cosmos transaction wrapping one EVM transaction");
const cosmosHash = createHash("sha256").update(rawTx).digest("hex");
function fixture() {
  const attributes = ["nullifier_1", "nullifier_2", "commitment_1", "commitment_2", "audit_disclosure_digest"]
    .map((key, i) => ({ key, value: `${i + 1}`.repeat(64) }));
  const event = { event_type: "shielded_transfer", height: "10", tx_hash_hex: cosmosHash.toUpperCase(), attributes };
  const receipt = { transactionHash: evmHash, blockHash, blockNumber: "0xa", status: "0x1", to: contract };
  const transaction = { hash: evmHash, blockHash, blockNumber: "0xa", to: contract };
  const block = { result: { block_id: { hash: blockHash.slice(2) }, block: {
    header: { height: "10", chain_id: "host-test" }, data: { txs: [rawTx.toString("base64")] }
  } } };
  const included = { result: { hash: cosmosHash, height: "10", index: 0, tx: rawTx.toString("base64"), tx_result: {
    code: 0, events: [
      { type: "ethereum_tx", attributes: [{ key: "ethereumTxHash", value: evmHash }] },
      { type: "shielded_transfer", attributes: structuredClone(attributes) }
    ]
  } } };
  const calls = [];
  const client = {
    assertEvmNetwork: async () => {},
    evmJsonRpc: async method => {
      if (method === "eth_getTransactionReceipt") return receipt;
      if (method === "eth_getTransactionByHash") return transaction;
      if (method === "eth_getBlockByNumber") return { hash: blockHash, number: "0xa" };
      if (method === "eth_blockNumber") return "0xb";
      throw new Error(method);
    }
  };
  const options = {
    client, txHash: evmHash, contractAddress: contract, chainId: "host-test",
    fetchPage: async query => { calls.push(query); return { events: [event], has_more: false }; },
    fetchCosmosTx: async hash => { assert.equal(hash, cosmosHash); return included; },
    fetchCosmosBlock: async height => { assert.equal(height, 10); return block; },
    predicate: candidate => candidate.attributes.find(a => a.key === "nullifier_1")?.value === "1".repeat(64)
  };
  return { event, receipt, transaction, block, included, client, options, calls };
}

test("different EVM and Cosmos hashes resolve through exact canonical transaction evidence", async () => {
  const f = fixture();
  const found = await findEvmTransferOperationEvent(f.options);
  assert.equal(found.complete, true);
  assert.equal(found.event.tx_hash_hex, cosmosHash.toUpperCase()); // Preserve the original event identity.
  assert.deepEqual(f.calls, [{ afterHeight: 9, page: 1, limit: 200, eventTypes: ["shielded_transfer"] }]);
});

for (const [name, mutate] of [
  ["receipt hash", f => { f.receipt.transactionHash = blockHash; }],
  ["receipt status", f => { f.receipt.status = "0x0"; }],
  ["transaction hash", f => { f.transaction.hash = blockHash; }],
  ["transaction contract", f => { f.transaction.to = `0x${"78".repeat(20)}`; }],
  ["transaction block", f => { f.transaction.blockNumber = "0xb"; }],
  ["host chain", f => { f.block.result.block.header.chain_id = "wrong"; }],
  ["canonical block", f => { f.block.result.block_id.hash = evmHash; }],
  ["Cosmos hash", f => { f.included.result.hash = evmHash; }],
  ["Cosmos execution", f => { f.included.result.tx_result.code = 9; }],
  ["Cosmos index", f => { f.included.result.index = 1; }],
  ["transaction bytes", f => { f.included.result.tx = "AA=="; f.block.result.block.data.txs[0] = "AA=="; }],
  ["output commitment", f => { f.event.attributes[2].value = "a".repeat(64); }],
  ["audit digest", f => { f.event.attributes[4].value = "b".repeat(64); }],
  ["missing output", f => { f.event.attributes.splice(2, 1); }],
  ["duplicate attributes", f => { f.event.attributes.push({ ...f.event.attributes[2] }); }],
  ["duplicate matching events", f => { f.included.result.tx_result.events.push(structuredClone(f.included.result.tx_result.events[1])); }],
  ["reorg", f => { const rpc = f.client.evmJsonRpc; f.client.evmJsonRpc = async method => method === "eth_getBlockByNumber" ? { hash: evmHash, number: "0xa" } : rpc(method); }]
]) test(`rejects mismatched ${name} without returning success evidence`, async () => {
  const f = fixture(); mutate(f);
  await assert.rejects(findEvmTransferOperationEvent(f.options));
});

test("same-block unrelated or multi-EVM Cosmos transactions cannot be used as success evidence", async () => {
  for (const mixed of [false, true]) {
    const f = fixture();
    const wrong = { type: "ethereum_tx", attributes: [{ key: "ethereumTxHash", value: blockHash }] };
    if (mixed) f.included.result.tx_result.events.push(wrong);
    else f.included.result.tx_result.events[0] = wrong;
    assert.equal((await findEvmTransferOperationEvent(f.options)).complete, false);
  }
});

test("pending receipts, unindexed events and different nullifiers remain unresolved", async () => {
  const f = fixture();
  const rpc = f.client.evmJsonRpc;
  f.client.evmJsonRpc = async method => method === "eth_getTransactionReceipt" ? null : rpc(method);
  assert.equal((await findEvmTransferOperationEvent(f.options)).complete, false);
  f.client.evmJsonRpc = rpc;
  f.options.predicate = () => false;
  assert.equal((await findEvmTransferOperationEvent(f.options)).complete, false);
  f.options.fetchPage = async () => ({ events: [], has_more: false });
  assert.equal((await findEvmTransferOperationEvent(f.options)).complete, false);
});

test("bounded pagination finds later events but never loops indefinitely", async () => {
  const f = fixture();
  f.options.fetchPage = async ({ page }) => ({ events: page === 2 ? [f.event] : [], has_more: true });
  assert.equal((await findEvmTransferOperationEvent(f.options)).complete, true);
  await assert.rejects(findEvmTransferOperationEvent({ ...f.options, maxPages: 1 }), /page budget/);
});

test("web passes verified EVM identity while retaining output evidence for the SDK comparison", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const functionSource = name => {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.notEqual(start, -1);
    const rest = source.slice(start);
    return rest.slice(0, rest.slice(1).search(/\n(?:async )?function /) + 1);
  };
  const f = fixture();
  const sender = `0x${"67".repeat(20)}`;
  const privacyTransaction = { to: contract, data: "0x1234", value: "0x0" };
  const recoveryId = evmTransactionBindingHash(privacyTransaction);
  const store = { load: async id => id === recoveryId
    ? { privacyTransaction, sender } : null };
  const verified = { txHash: evmHash, receipt: f.receipt, ok: true,
    evmTransactionVerified: true, evmPrivacyReceiptVerified: true, evmFinalityVerified: true };
  const record = { kind: "transfer", submitted_tx_hash: evmHash, expected_recipient_hash: "recipient-hash",
    tx_bytes_hash: recoveryId, expected_amount: "7", expected_amount_hash: "amount-hash", expected_denom: "utest" };
  const context = vm.createContext({
    activeChainProfile: () => ({ transport: "evm", evmPrivacyPrecompileAddress: contract, chainId: "host-test" }),
    commonReservationTransactionHash: () => evmHash, browserRpcUrl: () => "http://host-rpc",
    clairveilBrowserClient: () => ({ ...f.client, fetchPrivacyEvents: f.options.fetchPage,
      waitForEvmTransaction: async (_hash, binding) => {
        assert.equal(binding.privacyTransaction, privacyTransaction);
        assert.equal(binding.sender, sender);
        return verified;
      } }),
    currentEvmDepositStore: async (_session, purpose) => { assert.equal(purpose, "evm-private"); return store; },
    privacySessionSnapshot: () => ({}), assertPrivacySession: () => {}, state: { wallet: { account: sender } },
    verifiedEvmOperationEvidence,
    fetchBoundedJson: url => url.includes("/tx?") ? f.included : f.block,
    findEvmTransferOperationEvent, transferEventMatchesOperation: f.options.predicate,
    eventAttribute: (event, key) => event.attributes.find(attribute => attribute.key === key)?.value || "",
    normalizedHex: value => String(value || "").replace(/^0x/i, "").toLowerCase()
  });
  for (const name of ["operationEvidenceWithReservationTransactionIdentity", "operationEvidenceFromEvent", "operationEventForReservations"])
    vm.runInContext(functionSource(name), context);
  const result = await context.operationEventForReservations([record], new Map());
  assert.equal(result.operationSuccessEvidence.txHash, evmHash.slice(2));
  assert.notEqual(result.operationSuccessEvidence.txHash, cosmosHash);
  assert.equal(result.operationSuccessEvidence.outputCommitment, "3".repeat(64));
  assert.equal(result.operationSuccessEvidence.auditDisclosureDigest, "5".repeat(64));
  assert.equal(result.operationSuccessEvidence.recipientHash, record.expected_recipient_hash);
  assert.equal(result.operationSuccessEvidence.amountHash, record.expected_amount_hash);
  // Use the actual SDK state machine: an already-spent ManualReview operation
  // must recover, while a different expected output/digest must not succeed.
  for (const mismatch of [null, "output", "digest"]) {
    const manager = createNoteReservationManager({
      store: new MemoryReservationStore(), ownerKeyId: "test-owner", indexKey: "test-index"
    });
    const note = { nullifier: "1".repeat(64), isSpent: false, note: {
      receiverSpendPubKeyX: 1n, receiverSpendPubKeyY: 2n, receiverViewPubKeyX: 3n, receiverViewPubKeyY: 4n,
      amount: 7n, assetID: 7n, randomness: 8n, memo: ""
    } };
    const batch = await preparePlanReservation(manager, { plan: { selectedNote: note }, kind: "transfer" });
    await manager.markProofReady(batch.reservation_ids, {
      leaseToken: batch.lease_token, payloadHash: "prepared-payload",
      executionTransport: "evm", txBytesHash: recoveryId,
      expectedOutputCommitment: mismatch === "output" ? "a".repeat(64) : "3".repeat(64),
      expectedDisclosureDigest: mismatch === "digest" ? "b".repeat(64) : "5".repeat(64),
      expectedRecipientHash: record.expected_recipient_hash, expectedAmount: "7",
      expectedAmountHash: record.expected_amount_hash, expectedDenom: "utest", operationSuccessEvidenceRequired: true
    });
    await manager.markBroadcastAttempting(batch.reservation_ids, { leaseToken: batch.lease_token });
    await manager.markSubmitted(batch.reservation_ids, { leaseToken: batch.lease_token, txHash: evmHash });
    await manager.reconcileSpentNotes([{ ...note, isSpent: true }]);
    assert.notEqual((await manager.getReservation(batch.reservation_ids[0])).metadata.operation_status, operationStatuses.Succeeded);
    await manager.reconcileSpentNotes([{ ...note, isSpent: true, operationSuccessEvidence: result.operationSuccessEvidence }]);
    const recovered = await manager.getReservation(batch.reservation_ids[0]);
    if (mismatch) assert.notEqual(recovered.metadata.operation_status, operationStatuses.Succeeded);
    else assert.equal(recovered.metadata.operation_status, operationStatuses.Succeeded,
      JSON.stringify(recovered.metadata.operation_success_evidence_errors));
  }
});

test("recovery never synthesizes EVM verification from an output event or incomplete SDK result", async () => {
  const sender = `0x${"67".repeat(20)}`;
  const transaction = { to: contract, data: "0x1234", value: "0x0" };
  const id = evmTransactionBindingHash(transaction);
  const records = [{ tx_bytes_hash: id }];
  const saved = { privacyTransaction: transaction, sender };
  const store = { load: async () => saved };
  const evidence = { txHash: evmHash, outputCommitment: "3".repeat(64) };
  const verified = { txHash: evmHash, receipt: { transactionHash: evmHash, status: "0x1" }, ok: true,
    evmTransactionVerified: true, evmPrivacyReceiptVerified: true, evmFinalityVerified: true };
  let calls = 0;
  let result = verified;
  const client = { waitForEvmTransaction: async (hash, binding) => {
    calls++;
    assert.equal(hash, evmHash);
    assert.equal(binding.privacyTransaction, transaction);
    return result;
  } };
  const options = { client, store, records, sender, txHash: evmHash, evidence };
  assert.equal(await verifiedEvmOperationEvidence({ ...options, store: { load: async () => null } }), null);
  assert.equal(await verifiedEvmOperationEvidence({ ...options, records: [records[0], { tx_bytes_hash: blockHash }] }), null);
  assert.equal(calls, 0);
  for (const flag of ["evmTransactionVerified", "evmPrivacyReceiptVerified", "evmFinalityVerified", "ok"]) {
    result = { ...verified, [flag]: false };
    await assert.rejects(verifiedEvmOperationEvidence(options));
  }
  result = { ...verified, receipt: { ...verified.receipt, transactionHash: blockHash } };
  await assert.rejects(verifiedEvmOperationEvidence(options));
  result = { txHash: evmHash, unknown: true };
  assert.equal(await verifiedEvmOperationEvidence(options), null);
  result = verified;
  await assert.rejects(verifiedEvmOperationEvidence({ ...options, sender: contract }), /mismatched/);
  await assert.rejects(verifiedEvmOperationEvidence({ ...options, store: { load: async () => ({
    ...saved, privacyTransaction: { ...transaction, data: "0x5678" }
  }) } }), /mismatched/);
  const complete = await verifiedEvmOperationEvidence(options);
  assert.equal(complete.txBytesHash, id);
  assert.equal(complete.txResult.receipt.transactionHash, evmHash);
});
