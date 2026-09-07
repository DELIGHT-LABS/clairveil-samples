import { cosmosReservationTransactionHash } from "./cosmos-transaction-evidence.js";

function normalizedTxHash(value) {
  const hash = String(value || "").trim().replace(/^0x/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(hash) ? hash : "";
}

function commonReservationStatus(records) {
  const statuses = [...new Set(records.map(record => String(record?.status || "")))];
  if (statuses.length !== 1) throw new Error("failed transaction reservations have mixed statuses");
  return statuses[0];
}

export function reservationHasExplicitBroadcastRejection(record) {
  const metadata = record?.metadata || {};
  const rpcInvoked = metadata.rpc_invoked ?? metadata.rpcInvoked;
  const checkTxRejected = metadata.check_tx_rejected === true || metadata.checkTxRejected === true;
  const walletRejected = metadata.wallet_rejected_before_broadcast === true
    || metadata.walletRejectedBeforeBroadcast === true;
  const abortedBeforeRpc = metadata.broadcast_aborted_before_rpc === true
    || metadata.broadcastAbortedBeforeRpc === true
  const noBroadcastAttempt = metadata.no_broadcast_attempt ?? metadata.noBroadcastAttempt;
  const proofDiscarded = metadata.proof_discarded ?? metadata.proofDiscarded;
  return record?.status === "ReplanRequired"
    && record?.broadcast_in_flight !== true
    && checkTxRejected !== true
    && rpcInvoked === false
    && noBroadcastAttempt === true
    && proofDiscarded === true
    && (walletRejected || abortedBeforeRpc);
}

export function reservationHasPendingCheckTxRejection(record) {
  const metadata = record?.metadata || {};
  const providerCode = metadata.provider_rejection_code ?? metadata.providerRejectionCode;
  const rpcInvoked = metadata.rpc_invoked ?? metadata.rpcInvoked;
  const checkTxRejected = metadata.check_tx_rejected ?? metadata.checkTxRejected;
  const noBroadcastAttempt = metadata.no_broadcast_attempt ?? metadata.noBroadcastAttempt;
  const proofDiscarded = metadata.proof_discarded ?? metadata.proofDiscarded;
  return record?.status === "Unknown"
    && record?.broadcast_in_flight !== true
    && rpcInvoked === true
    && checkTxRejected === true
    && noBroadcastAttempt === false
    && proofDiscarded !== true
    && String(providerCode ?? "").trim().length > 0;
}

export function reservationHasReconciledCheckTxFailure(record, txHash) {
  const metadata = record?.metadata || {};
  const expectedHash = normalizedTxHash(txHash);
  const checkedHash = normalizedTxHash(
    metadata.tx_hash_checked ?? metadata.txHashChecked
  );
  const checkedHeight = Number(metadata.checked_height ?? metadata.checkedHeight);
  const rpcInvoked = metadata.rpc_invoked ?? metadata.rpcInvoked;
  const checkTxRejected = metadata.check_tx_rejected ?? metadata.checkTxRejected;
  const proofDiscarded = metadata.proof_discarded ?? metadata.proofDiscarded;
  const nullifierUnspent = metadata.nullifier_unspent_confirmed
    ?? metadata.nullifierUnspentConfirmed;
  const txAbsentOrFailed = metadata.tx_absent_or_failed_confirmed
    ?? metadata.txAbsentOrFailedConfirmed;
  const reconcileReason = metadata.reconcile_reason ?? metadata.reconcileReason;
  return record?.status === "ReplanRequired"
    && record?.broadcast_in_flight !== true
    && expectedHash.length > 0
    && checkedHash === expectedHash
    && cosmosReservationTransactionHash(record) === expectedHash
    && Number.isSafeInteger(checkedHeight)
    && checkedHeight > 0
    && rpcInvoked === true
    && checkTxRejected === true
    && proofDiscarded === true
    && nullifierUnspent === true
    && txAbsentOrFailed === true
    && reconcileReason === "authoritative_exact_broadcast_failure";
}

export async function replanExplicitlyFailedReservations({
  manager,
  records = [],
  txHash,
  checkedHeight,
  metadata = {},
  cosmosTransactionIdentity = false
} = {}) {
  if (!manager || !records.length) throw new Error("failed transaction reservation recovery requires records");
  const normalizedHash = normalizedTxHash(txHash);
  if (!normalizedHash || !records.every(record => (
    (cosmosTransactionIdentity
      ? cosmosReservationTransactionHash(record)
      : normalizedTxHash(record?.submitted_tx_hash)) === normalizedHash
  ))) {
    throw new Error("failed transaction hash does not match every reservation");
  }
  const height = Number(checkedHeight);
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new Error("failed transaction recovery requires an authoritative checked height");
  }

  const status = commonReservationStatus(records);
  const reservationIDs = records.map(record => String(record.reservation_id || "")).filter(Boolean);
  if (reservationIDs.length !== records.length) throw new Error("failed transaction reservation id is missing");
  const evidence = {
    ...metadata,
    reconcile_reason: "checked_transaction_failed",
    nullifier_unspent_confirmed: true,
    tx_absent_or_failed_confirmed: true,
    checked_height: height,
    tx_hash_checked: txHash
  };
  let leaseToken = "";

  if (status === "ProofReady") {
    if (!records.every(record => (
      record.broadcast_in_flight === true && Number(record.broadcast_attempt_count || 0) >= 1
    ))) {
      throw new Error("ProofReady failed transaction recovery requires a durable broadcast attempt");
    }
    const leaseTokens = [...new Set(records.map(record => String(record?.lease_token || "")))];
    if (leaseTokens.length !== 1 || !leaseTokens[0]) {
      throw new Error("ProofReady failed transaction recovery requires one operation-wide lease token");
    }
    leaseToken = leaseTokens[0];
  } else if (status !== "Submitted" && status !== "Unknown") {
    throw new Error(`unsupported failed transaction reservation status ${status}`);
  }

  if (typeof manager.markBroadcastFailed !== "function") {
    throw new Error(
      "ClairveilJS does not provide authoritative broadcast-failure recovery; " +
      "reservations were left unchanged for manual review and this transaction must not be retried"
    );
  }
  await manager.markBroadcastFailed(reservationIDs, {
    txHashChecked: txHash,
    checkedHeight: height,
    nullifierUnspentConfirmed: true,
    txAbsentOrFailedConfirmed: true,
    errorCode: "checked_transaction_failed",
    error: "checked_transaction_failed",
    ...(leaseToken ? { leaseToken } : {}),
    metadata: evidence
  });
}
