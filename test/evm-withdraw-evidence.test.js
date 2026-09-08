import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { AbiCoder, id } from "ethers";
import { evmAddressToBech32, evmTransactionBindingHash } from "clairveiljs/evm";
import { createNoteReservationManager, MemoryReservationStore, preparePlanReservation, hashAmount } from "clairveiljs/reservation";
import { evmWithdrawOperationEvidence, hashTransparentCosmosRecipient } from "../public/withdraw-operation-evidence.js";
import { verifiedEvmOperationEvidence } from "../public/evm-operation-event.js";

const hash = `0x${"12".repeat(32)}`;
const sender = `0x${"23".repeat(20)}`;
const recipient = `0x${"34".repeat(20)}`;
const contract = `0x${"45".repeat(20)}`;
const topicAddress = address => `0x${address.slice(2).padStart(64, "0")}`;
function receipt() {
  return { transactionHash: hash, status: "0x1", logs: [{ address: contract,
    topics: [id("PrivacyWithdraw(address,address,address,string)"), topicAddress(sender), topicAddress(sender), topicAddress(recipient)],
    data: AbiCoder.defaultAbiCoder().encode(["string"], ["10utest"]) }] };
}
const options = { txHash: hash, contractAddress: contract, accountPrefix: "host" };

test("withdraw amount and recipient come from the observed receipt, not the reservation's expected values", () => {
  const actual = evmWithdrawOperationEvidence({ ...options, receipt: receipt() });
  assert.equal(actual.amount, "10");
  assert.equal(actual.denom, "utest");
  assert.equal(actual.amountHash, hashAmount("utest", "10"));
  assert.equal(actual.recipientHash, hashTransparentCosmosRecipient(evmAddressToBech32(recipient, "host"), { accountPrefix: "host" }));
});

for (const [name, mutate] of [
  ["wrong hash", r => { r.transactionHash = `0x${"56".repeat(32)}`; }],
  ["failure", r => { r.status = "0x0"; }],
  ["missing event", r => { r.logs = []; }],
  ["duplicate event", r => { r.logs.push(structuredClone(r.logs[0])); }],
  ["removed event", r => { r.logs[0].removed = true; }],
  ["wrong contract", r => { r.logs[0].address = sender; }],
  ["invalid recipient padding", r => { r.logs[0].topics[3] = `0x${"ff".repeat(32)}`; }],
  ["ambiguous data", r => { r.logs[0].data += "00".repeat(32); }]
]) test(`withdraw evidence rejects ${name}`, () => {
  const r = receipt(); mutate(r);
  assert.throws(() => evmWithdrawOperationEvidence({ ...options, receipt: r }));
});

test("the actual web EVM withdraw branch completes SDK reconciliation only for the matching recipient and amount", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function operationEventForReservations(");
  const end = source.indexOf("\nfunction operationEvidenceWithReservationTransactionIdentity", start);
  for (const mismatch of [null, "recipient", "amount"]) {
    const manager = createNoteReservationManager({ store: new MemoryReservationStore(), ownerKeyId: "owner", indexKey: "index" });
    const note = { nullifier: "11".repeat(32), note: { receiverSpendPubKeyX: 1n, receiverSpendPubKeyY: 2n,
      receiverViewPubKeyX: 3n, receiverViewPubKeyY: 4n, amount: 10n, assetID: 7n, randomness: 8n, memo: "" } };
    const transaction = { to: contract, data: "0x1234", value: "0x0" };
    const artifact = evmTransactionBindingHash(transaction);
    const batch = await preparePlanReservation(manager, { plan: { selectedNote: note }, kind: "withdraw" });
    const expected = evmWithdrawOperationEvidence({ ...options, receipt: receipt() });
    await manager.markProofReady(batch.reservation_ids, { leaseToken: batch.lease_token, payloadHash: "payload",
      executionTransport: "evm", txBytesHash: artifact, operationSuccessEvidenceRequired: true,
      expectedRecipientHash: expected.recipientHash, expectedAmount: "10", expectedAmountHash: expected.amountHash, expectedDenom: "utest" });
    await manager.markBroadcastAttempting(batch.reservation_ids, { leaseToken: batch.lease_token });
    await manager.markSubmitted(batch.reservation_ids, { leaseToken: batch.lease_token, txHash: hash });
    const r = receipt();
    if (mismatch === "recipient") r.logs[0].topics[3] = topicAddress(sender);
    if (mismatch === "amount") r.logs[0].data = AbiCoder.defaultAbiCoder().encode(["string"], ["11utest"]);
    const context = vm.createContext({
      commonReservationTransactionHash: () => hash,
      activeChainProfile: () => ({ transport: "evm", evmPrivacyPrecompileAddress: contract }),
      privacySessionSnapshot: () => ({}), assertPrivacySession: () => {}, accountPrefix: () => "host",
      state: { wallet: { account: sender } }, normalizedHex: value => value.replace(/^0x/, "").toLowerCase(),
      currentEvmDepositStore: async (_session, purpose) => {
        assert.equal(purpose, "evm-private");
        return { load: async key => key === artifact ? { privacyTransaction: transaction, sender } : null };
      },
      clairveilBrowserClient: () => ({ waitForEvmTransaction: async () => ({ txHash: hash, receipt: r, ok: true,
        evmTransactionVerified: true, evmPrivacyReceiptVerified: true, evmFinalityVerified: true }) }),
      verifiedEvmOperationEvidence, evmWithdrawOperationEvidence
    });
    vm.runInContext(source.slice(start, end), context);
    const records = await manager.getReservations(batch.reservation_ids);
    const found = await context.operationEventForReservations(records, new Map());
    assert.equal(found.complete, true);
    await manager.reconcileSpentNotes([{ ...note, isSpent: true, operationSuccessEvidence: found.operationSuccessEvidence }]);
    const recovered = await manager.getReservation(batch.reservation_ids[0]);
    assert.equal(recovered.metadata.operation_status, mismatch ? "ConflictSpent" : "Succeeded",
      JSON.stringify(recovered.metadata.operation_success_evidence_errors));
  }
});
