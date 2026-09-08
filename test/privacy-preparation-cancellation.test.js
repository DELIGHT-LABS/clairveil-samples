import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import {
  createNoteReservationManager,
  MemoryReservationStore,
  preparePlanReservation,
  reservationStatuses
} from "clairveiljs/reservation";
import { assessReservationRecovery, groupReservationOperations } from "../public/reservation-recovery.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
function functionSource(name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart < 0 ? source.indexOf(`function ${name}(`) : asyncStart;
  assert.notEqual(start, -1, name);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n(?:async )?function /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

async function harness({ cancelAt, persistenceFailure = false, paired = false } = {}) {
  const controller = new AbortController();
  const manager = createNoteReservationManager({
    store: new MemoryReservationStore(), ownerKeyId: "test-owner", indexKey: "test-key"
  });
  const note = {
      nullifier: "ab".repeat(32), isSpent: false,
      note: { amount: 8n, assetID: 7n, randomness: 8n, memo: "",
        receiverSpendPubKeyX: 1n, receiverSpendPubKeyY: 2n,
        receiverViewPubKeyX: 3n, receiverViewPubKeyY: 4n }
    };
  const batch = await preparePlanReservation(manager, {
    plan: paired ? { selection: { inputs: [note, {
      ...note, nullifier: "ef".repeat(32), note: { ...note.note, amount: 0n, randomness: 10n }
    }] } } : { selectedNote: note }, kind: "withdraw"
  });
  const calls = [];
  let prepared;
  const prepare = async () => {
    calls.push("prepare");
    if (cancelAt === "waiting-rejected") {
      controller.abort();
      await manager.markManualReview(batch.reservation_ids, { leaseToken: batch.lease_token });
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    }
    if (cancelAt === "waiting-late-result") controller.abort();
    await manager.markProofReady(batch.reservation_ids, {
      leaseToken: batch.lease_token, payloadHash: "test-payload"
    });
    prepared = {
      reservation: batch, proof: { bytes: "proof" }, payload: { proof: "proof" },
      message: { proof: "proof" }, signDoc: { bodyBytes: "proof" }, transaction: { data: "proof" }
    };
    return prepared;
  };
  const context = vm.createContext({
    AbortSignal,
    privacySessionSnapshot: () => ({}), assertPrivacySession: () => {},
    currentReservationManager: async () => manager,
    preparedReservationIDs: data => data?.reservation?.reservation_ids || [],
    refreshReservationState: async () => {
      calls.push("refresh");
      if (cancelAt === "refresh") controller.abort();
    },
    requirePrivacyPreparePreflight: async () => {},
    clairveilBrowserClient: () => ({ prepareTransfer: prepare, prepareWithdraw: prepare, prepareRelayWithdraw: prepare }),
    privacyRequest: value => value, typedPrivacyScanAfter: () => ({}),
    cosmosFeeRequestOptions: () => ({}), cosmosGasLimits: {},
    parsePlannerAmountValue: value => BigInt(value), hashRecipient: () => "recipient",
    shieldedPrefix: () => "clairs", hashAmount: () => "amount", baseDenom: () => "unit",
    assertPreparedTransferFreshAtChainTime: () => 123,
    activeProofSignal: () => controller.signal,
    els: { cancelTransferFlow: { disabled: false } }
  });
  for (const name of ["discardPreparedReservation", "assertPrivacyPreparationNotCancelled",
    "finishPrivacyPreparation", "beginPreparedPrivacySubmission", "preparePrivacyTransferSignDoc",
    "preparePrivacyWithdrawSignDoc", "preparePrivacyRelayWithdraw"]) {
    vm.runInContext(functionSource(name), context);
  }
  if (persistenceFailure) manager.markManualReview = async () => { throw new Error("storage unavailable"); };
  return { context, controller, manager, batch, calls, get prepared() { return prepared; } };
}

for (const name of ["preparePrivacyTransferSignDoc", "preparePrivacyWithdrawSignDoc", "preparePrivacyRelayWithdraw"]) {
  for (const cancelAt of ["waiting-late-result", "refresh"]) {
    test(`${name}: ${cancelAt} discards proof and never returns a submit-ready result`, async () => {
      const h = await harness({ cancelAt });
      const options = { signal: h.controller.signal };
      const args = name.includes("Transfer") ? ["8", "recipient", {}, options] : ["8", "recipient", options];
      let error;
      await assert.rejects(h.context[name](...args), value => { error = value; return value.code === "PROVER_CANCELLED"; });
      const record = await h.manager.getReservation(h.batch.reservation_ids[0]);
      assert.equal(record.status, "ManualReview");
      assert.equal(record.metadata.proof_discarded, true);
      assert.equal(record.metadata.no_broadcast_attempt, true);
      for (const key of ["proof", "payload", "message", "signDoc", "transaction"]) {
        assert.equal(error.preparedPrivacyData[key], null, key);
      }
      // Even a caller retaining the failed result cannot resume its submission.
      await assert.rejects(h.context.beginPreparedPrivacySubmission(error.preparedPrivacyData), { code: "PROVER_CANCELLED" });
    });
  }
}

test("cancelled waiting request without a returned proof keeps uncertain reservations quarantined", async () => {
  const h = await harness({ cancelAt: "waiting-rejected" });
  await assert.rejects(h.context.preparePrivacyWithdrawSignDoc("8", "recipient", { signal: h.controller.signal }), { name: "AbortError" });
  const record = await h.manager.getReservation(h.batch.reservation_ids[0]);
  assert.equal(record.status, "ManualReview");
  assert.notEqual(record.metadata.proof_discarded, true);
});

test("failed durable discard still blocks submission and removes local executable artifacts", async () => {
  const h = await harness({ cancelAt: "refresh", persistenceFailure: true });
  await assert.rejects(h.context.preparePrivacyWithdrawSignDoc("8", "recipient", { signal: h.controller.signal }), error => {
    assert.equal(error.reservationDiscardError.message, "storage unavailable");
    assert.equal(error.preparedPrivacyData.signDoc, null);
    return error.code === "PROVER_CANCELLED";
  });
  assert.equal((await h.manager.getReservation(h.batch.reservation_ids[0])).status, "ProofReady");
});

test("cancellation after ready but before submission discards the prepared result", async () => {
  const h = await harness();
  const data = await h.context.preparePrivacyWithdrawSignDoc("8", "recipient", { signal: h.controller.signal });
  h.controller.abort();
  await assert.rejects(h.context.beginPreparedPrivacySubmission(data), { code: "PROVER_CANCELLED" });
  assert.equal((await h.manager.getReservation(h.batch.reservation_ids[0])).status, "ManualReview");
});

test("normal preparation is preserved; proof cancellation ends at the submission/handoff boundary", async () => {
  const h = await harness();
  const data = await h.context.preparePrivacyWithdrawSignDoc("8", "recipient", { signal: h.controller.signal });
  await h.context.beginPreparedPrivacySubmission(data);
  assert.ok(data.signDoc);
  assert.equal(h.context.els.cancelTransferFlow.disabled, true);
  assert.equal((await h.manager.getReservation(h.batch.reservation_ids[0])).status, "ProofReady");
});

test("broadcast and relay export check cancellation after their asynchronous preflight", () => {
  assert.match(functionSource("broadcastPreparedPrivacy"), /withPreparedReservationHeartbeat\(data, async \(\) => \{\s*assertPrivacySession\(sessionContext\);\s*await beginPreparedPrivacySubmission\(data\);/);
  assert.match(functionSource("setRelayWithdrawHandoff"), /await beginPreparedPrivacySubmission\(prepared\);\s*const handoff = createRelayWithdrawHandoff/);
});

test("Escape and backdrop cancellation cannot bypass a disabled submission-phase button", () => {
  const controller = new AbortController();
  const context = vm.createContext({
    transferFlowState: { running: true, controller },
    els: { cancelTransferFlow: { disabled: true }, transferModalState: {} }
  });
  vm.runInContext(functionSource("cancelTransferFlow"), context);
  context.cancelTransferFlow();
  assert.equal(controller.signal.aborted, false);
  context.els.cancelTransferFlow.disabled = false;
  context.cancelTransferFlow();
  assert.equal(controller.signal.aborted, true);
});

for (const scenario of ["approve", "decline", "spent-after-approval", "broadcast-after-approval", "scan-fails"]) {
  test(`owner recovery: ${scenario} affects only the selected operation`, async () => {
    const h = await harness({ cancelAt: "refresh", paired: true });
    await assert.rejects(h.context.preparePrivacyWithdrawSignDoc("8", "recipient", { signal: h.controller.signal }));
    const unrelated = await preparePlanReservation(h.manager, {
      plan: { selectedNote: {
        nullifier: "cd".repeat(32), isSpent: false,
        note: { amount: 9n, assetID: 7n, randomness: 9n, memo: "",
          receiverSpendPubKeyX: 1n, receiverSpendPubKeyY: 2n,
          receiverViewPubKeyX: 3n, receiverViewPubKeyY: 4n }
      } }, kind: "withdraw"
    });
    const unrelatedBefore = await h.manager.getReservations(unrelated.reservation_ids);
    const target = await h.manager.getReservation(h.batch.reservation_ids[0]);
    let scans = 0;
    const listActive = h.manager.listActiveReservations.bind(h.manager);
    // Model evidence arriving while the owner was reading the confirmation.
    h.manager.listActiveReservations = async () => {
      const records = await listActive();
      return scenario === "broadcast-after-approval" && scans === 2
        ? records.map(record => record.operation_id === target.operation_id
          ? { ...record, broadcast_in_flight: true } : record)
        : records;
    };
    Object.assign(h.context, {
      state: { reservations: {}, keplr: { notes: [] } },
      reservationStatuses, assessReservationRecovery, groupReservationOperations,
      reservationLeaseOwner: h.manager.leaseOwner,
      privacySessionSnapshot: () => ({ account: "test-owner" }),
      renderReservationState: () => {}, refreshEvents: async () => {},
      scanKeplrNotes: async () => { scans++; if (scenario === "scan-fails") throw new Error("scan unavailable"); },
      localTestBackendEnabled: () => false,
      explicitlyUnspentReservationIDs: async (_manager, records) => (
        scenario === "spent-after-approval" && scans === 2 ? [] : records.map(record => record.reservation_id)
      ),
      checkedReservationHeight: () => 99, reservationKindLabel: value => value,
      shorten: value => value, confirm: () => scenario !== "decline", toast: () => {},
      isStalePrivacySessionError: () => false,
      els: { keplrTxState: {} }
    });
    for (const name of ["activeReservationOperation", "resolvePreparationRecovery", "recoverReservationPreparation"]) {
      vm.runInContext(functionSource(name), h.context);
    }
    const recovery = h.context.recoverReservationPreparation(target.operation_id);
    if (["approve", "decline"].includes(scenario)) await recovery;
    else await assert.rejects(recovery);
    const after = await h.manager.getReservation(target.reservation_id);
    assert.equal(after.status, scenario === "approve" ? "ReplanRequired" : "ManualReview");
    const linked = await h.manager.getReservations(h.batch.reservation_ids);
    assert.equal(linked.length, 2);
    assert.ok(linked.every(record => record.status === after.status));
    if (scenario === "approve") {
      assert.equal(scans, 2);
      assert.equal(after.metadata.wallet_owner_approved_replan, true);
      assert.equal(after.metadata.nullifier_unspent_confirmed, true);
      assert.equal(after.metadata.proof_discarded, true);
    }
    assert.deepEqual(await h.manager.getReservations(unrelated.reservation_ids), unrelatedBefore);
  });
}

test("recovery refuses missing owner approval even for a live owned ProofReady reservation", async () => {
  const h = await harness();
  await h.context.preparePrivacyWithdrawSignDoc("8", "recipient", { signal: h.controller.signal });
  Object.assign(h.context, { reservationStatuses });
  vm.runInContext(functionSource("resolvePreparationRecovery"), h.context);
  const assessment = assessReservationRecovery(await h.manager.getReservations(h.batch.reservation_ids), { leaseOwner: h.manager.leaseOwner });
  await assert.rejects(h.context.resolvePreparationRecovery(h.manager, assessment, {}, "", { operatorId: "" }), /owner approval/);
  assert.equal((await h.manager.getReservation(h.batch.reservation_ids[0])).status, "ProofReady");
});

for (const status of ["Proving", "ProofReady"]) {
  test(`${status}: owner-approved discard recovers the full input set, not one input`, async () => {
    const h = await harness({ paired: true });
    if (status === "ProofReady") {
      await h.context.preparePrivacyWithdrawSignDoc("8", "recipient", { signal: h.controller.signal });
    } else {
      // A stopped Proving worker must no longer have a live lease.
      const later = new Date(Date.now() + 3_600_000);
      h.manager.now = () => later;
      h.manager.store.now = () => later;
    }
    Object.assign(h.context, { reservationStatuses });
    vm.runInContext(functionSource("resolvePreparationRecovery"), h.context);
    const assessment = assessReservationRecovery(await h.manager.getReservations(h.batch.reservation_ids), {
      leaseOwner: h.manager.leaseOwner, nowMs: h.manager.now().getTime()
    });
    const evidence = {
      wallet_owner_approved_replan: true, proof_discarded: true,
      no_broadcast_attempt: true, nullifier_unspent_confirmed: true,
      post_approval_chain_recheck: true, checked_height: 99
    };
    await assert.rejects(h.context.resolvePreparationRecovery(h.manager,
      { ...assessment, reservationIDs: assessment.reservationIDs.slice(0, 1) }, evidence,
      "owner-approval", { operatorId: "test-owner" }));
    assert.ok((await h.manager.getReservations(h.batch.reservation_ids)).every(record => record.status === status));
    await h.context.resolvePreparationRecovery(h.manager, assessment, evidence,
      "owner-approval", { operatorId: "test-owner" });
    assert.ok((await h.manager.getReservations(h.batch.reservation_ids)).every(record => record.status === "ReplanRequired"));
  });
}

test("declining final self-merge confirmation discards the result but waits for note-unlock approval", async () => {
  const h = await harness();
  const data = await h.context.preparePrivacyWithdrawSignDoc("8", "recipient", { signal: h.controller.signal });
  Object.assign(h.context, {
    withPreparedReservationHeartbeat: async (_data, task) => task(),
    requestPreparedSelfMergeConfirmation: async () => false
  });
  vm.runInContext(functionSource("confirmPreparedSelfMerge"), h.context);
  await assert.rejects(h.context.confirmPreparedSelfMerge(data, {}), { code: "PROVER_CANCELLED" });
  assert.equal((await h.manager.getReservation(h.batch.reservation_ids[0])).status, "ManualReview");
  assert.equal(data.signDoc, null);
  assert.equal(data.preparationSignal.aborted, true);
});
