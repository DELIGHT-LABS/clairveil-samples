import assert from "node:assert/strict";
import test from "node:test";

import {
  commonCosmosReservationTransactionHash,
  cosmosCheckTxRejectionEvidence,
  cosmosPrivatePendingMarkerCanClear,
  cosmosPublicCheckTxRejectionCanClear,
  cosmosReservationTransactionHash,
  cosmosTxEvidenceConfirmsFailure
} from "../public/cosmos-transaction-evidence.js";

test("Cosmos failure evidence accepts included and legacy unmarked rejection codes", () => {
  assert.equal(cosmosTxEvidenceConfirmsFailure({ tx: { code: "7" } }), true);
  assert.equal(cosmosTxEvidenceConfirmsFailure({ code: 19, codespace: "sdk", log: "sequence mismatch" }), true);
  assert.equal(cosmosTxEvidenceConfirmsFailure({ code: 0, codespace: "", log: "" }), false);
});

test("Cosmos failure evidence keeps RPC-crossing CheckTx rejection nonterminal", () => {
  assert.equal(cosmosTxEvidenceConfirmsFailure({
    checkTxRejected: true,
    rpcInvoked: true,
    code: 19,
    codespace: "sdk",
    log: "sequence mismatch"
  }), false);
  assert.equal(cosmosTxEvidenceConfirmsFailure({ checkTxRejected: true, rpcInvoked: false }), false);
  assert.equal(cosmosTxEvidenceConfirmsFailure({ checkTxRejected: true }), false);
  assert.equal(cosmosTxEvidenceConfirmsFailure({ explicit_broadcast_rejection: true }), true);
  assert.equal(cosmosTxEvidenceConfirmsFailure({ rpcInvoked: false }), false);
  assert.equal(cosmosTxEvidenceConfirmsFailure({
    checkTxRejected: true,
    rpcInvoked: true,
    tx: { code: 12 }
  }), true);
});

test("Cosmos CheckTx evidence retains only canonical provider metadata", () => {
  assert.deepEqual(cosmosCheckTxRejectionEvidence({
    txHash: "ab".repeat(32),
    rpcInvoked: true,
    checkTxRejected: true,
    code: 32,
    codespace: " sdk ",
    log: "private upstream diagnostic"
  }), {
    rpcInvoked: true,
    checkTxRejected: true,
    providerCode: "32",
    providerCodespace: "sdk"
  });
  assert.deepEqual(cosmosCheckTxRejectionEvidence({
    cause: {
      rpc_invoked: true,
      check_tx_rejected: true,
      provider_code: "7"
    }
  }), {
    rpcInvoked: true,
    checkTxRejected: true,
    providerCode: "7"
  });
  assert.equal(cosmosCheckTxRejectionEvidence({
    rpcInvoked: true,
    checkTxRejected: true,
    code: 0
  }), null);
  assert.equal(cosmosCheckTxRejectionEvidence({
    rpcInvoked: true,
    checkTxRejected: true,
    code: 7,
    codespace: "bad\nvalue"
  }), null);
});

test("public CheckTx marker clears only after exact authoritative positive-height absence", () => {
  const txHash = "ab".repeat(32);
  const entry = {
    txHash,
    status: "unknown",
    rpcInvoked: true,
    checkTxRejected: true,
    providerCode: "32",
    providerCodespace: "sdk"
  };
  const check = {
    checked: true,
    txHash: txHash.toUpperCase(),
    absent: true,
    included: false,
    checkedHeight: 123
  };
  assert.equal(cosmosPublicCheckTxRejectionCanClear(entry, check), true);
  assert.equal(cosmosPublicCheckTxRejectionCanClear(entry, { ...check, checked: false }), false);
  assert.equal(cosmosPublicCheckTxRejectionCanClear(entry, { ...check, checkedHeight: 0 }), false);
  assert.equal(cosmosPublicCheckTxRejectionCanClear(entry, { ...check, checkedHeight: undefined }), false);
  assert.equal(cosmosPublicCheckTxRejectionCanClear(entry, { ...check, txHash: "cd".repeat(32) }), false);
  assert.equal(cosmosPublicCheckTxRejectionCanClear(entry, { ...check, absent: false }), false);
  assert.equal(cosmosPublicCheckTxRejectionCanClear(entry, { ...check, included: true }), false);
  assert.equal(cosmosPublicCheckTxRejectionCanClear({
    txHash,
    status: "unknown"
  }, check), false);
  assert.equal(cosmosPublicCheckTxRejectionCanClear({ ...entry, providerCode: "0" }, check), false);
});

test("Cosmos failure evidence rejects unrelated numeric transport errors", () => {
  assert.equal(cosmosTxEvidenceConfirmsFailure({ code: 500, message: "HTTP failure" }), false);
  assert.equal(cosmosTxEvidenceConfirmsFailure({ cause: { code: 429 } }), false);
});

test("private pending marker clears only for the exact pre-RPC-aborted transaction", () => {
  const txHash = "ab".repeat(32);
  assert.equal(cosmosPrivatePendingMarkerCanClear({
    markerTxHash: txHash,
    txHash: txHash.toUpperCase(),
    error: { checkTxRejected: true, rpcInvoked: true }
  }), false);
  assert.equal(cosmosPrivatePendingMarkerCanClear({
    markerTxHash: txHash,
    txHash,
    error: { rpcInvoked: false }
  }), true);
  assert.equal(cosmosPrivatePendingMarkerCanClear({
    markerTxHash: "cd".repeat(32),
    txHash,
    error: { checkTxRejected: true, rpcInvoked: true }
  }), false);
  assert.equal(cosmosPrivatePendingMarkerCanClear({
    markerTxHash: txHash,
    txHash,
    error: { code: 500 }
  }), false);
  assert.equal(cosmosPrivatePendingMarkerCanClear({
    markerTxHash: txHash,
    txHash,
    error: { tx: { code: 7 } }
  }), false);
  assert.equal(cosmosPrivatePendingMarkerCanClear({
    markerTxHash: txHash,
    txHash,
    error: { code: 7, codespace: "sdk", log: "deliver failure" }
  }), false);
});

test("private pending marker keeps CheckTx fenced regardless of terminal bookkeeping", () => {
  const txHash = "ab".repeat(32);
  assert.equal(cosmosPrivatePendingMarkerCanClear({
    markerTxHash: txHash,
    txHash,
    error: {
      checkTxRejected: true,
      rpcInvoked: true,
      reservationReconciliationRequired: true,
      reservationBookkeepingError: new Error("write failed")
    }
  }), false);
  assert.equal(cosmosPrivatePendingMarkerCanClear({
    markerTxHash: txHash,
    txHash,
    error: {
      reservationReconciliationRequired: true,
      cause: { checkTxRejected: true, rpcInvoked: true }
    }
  }), false);
  assert.equal(cosmosPrivatePendingMarkerCanClear({
    markerTxHash: txHash,
    txHash,
    error: {
      rpcInvoked: false,
      reservationReconciliationRequired: true,
      reservationBookkeepingError: new Error("write failed")
    }
  }), true);
});

test("Cosmos reservation identity promotes tx bytes only after a durable broadcast attempt", () => {
  const txHash = "ab".repeat(32);
  assert.equal(cosmosReservationTransactionHash({
    status: "ProofReady",
    tx_bytes_hash: txHash,
    broadcast_in_flight: true,
    broadcast_attempt_count: 1
  }), txHash);
  assert.equal(cosmosReservationTransactionHash({
    status: "ProofReady",
    tx_bytes_hash: txHash,
    broadcast_in_flight: false,
    broadcast_attempt_count: 0
  }), "");
  assert.equal(cosmosReservationTransactionHash({
    status: "Submitted",
    tx_bytes_hash: `0x${txHash.toUpperCase()}`
  }), txHash);
});

test("Cosmos reservation identity rejects malformed and conflicting persisted hashes", () => {
  const txHash = "ab".repeat(32);
  assert.equal(cosmosReservationTransactionHash({
    status: "Submitted",
    submitted_tx_hash: txHash,
    tx_bytes_hash: "cd".repeat(32)
  }), "");
  assert.equal(cosmosReservationTransactionHash({
    status: "Submitted",
    submitted_tx_hash: "not-a-hash",
    tx_bytes_hash: txHash
  }), "");
});

test("Cosmos operation identity requires every linked reservation to agree", () => {
  const txHash = "ab".repeat(32);
  const attempted = suffix => ({
    reservation_id: `r-${suffix}`,
    status: "ProofReady",
    tx_bytes_hash: txHash,
    broadcast_in_flight: true,
    broadcast_attempt_count: 1
  });
  assert.equal(commonCosmosReservationTransactionHash([
    attempted("1"),
    attempted("2")
  ]), txHash);
  assert.equal(commonCosmosReservationTransactionHash([
    attempted("1"),
    { ...attempted("2"), tx_bytes_hash: "cd".repeat(32) }
  ]), "");
  assert.equal(commonCosmosReservationTransactionHash([
    attempted("1"),
    { ...attempted("2"), tx_bytes_hash: "" }
  ]), "");
});
