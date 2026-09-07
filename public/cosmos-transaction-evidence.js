function canonicalCosmosTxCode(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function checkTxRejectionMarker(value = {}) {
  const checkTxRejected = value.checkTxRejected === true || value.check_tx_rejected === true;
  return checkTxRejected && (value.rpcInvoked === true || value.rpc_invoked === true);
}

function explicitRejectionMarker(value = {}) {
  return [
    value.explicitBroadcastRejection,
    value.explicit_broadcast_rejection,
    value.broadcastRejected,
    value.broadcast_rejected
  ].some(marker => marker === true || (marker && typeof marker === "object"));
}

function topLevelBroadcastErrorCode(value = {}) {
  const hasBroadcastErrorShape = ["code", "codespace", "log"].every(key => (
    Object.prototype.hasOwnProperty.call(value, key)
  ));
  return hasBroadcastErrorShape ? canonicalCosmosTxCode(value.code) : null;
}

export function cosmosTxEvidenceConfirmsFailure(value = {}) {
  const sources = [value, value?.broadcast, value?.cause].filter(source => (
    source && typeof source === "object"
  ));
  const includedCodes = [
    value?.tx?.code,
    value?.broadcast?.tx?.code
  ];
  if (includedCodes.some(code => {
    const parsed = canonicalCosmosTxCode(code);
    return parsed != null && parsed > 0;
  })) return true;

  // A non-zero CheckTx response crossed the RPC boundary but does not prove
  // that the exact signed transaction is absent from the chain. Keep it
  // Unknown until an authoritative exact-hash lookup establishes absence.
  if (sources.some(checkTxRejectionMarker)) return false;
  if (sources.some(explicitRejectionMarker)) return true;
  return sources.some(source => {
    const code = topLevelBroadcastErrorCode(source);
    return code != null && code > 0;
  });
}

function canonicalProviderCodespace(value) {
  if (typeof value !== "string") return null;
  const codespace = value.trim();
  if (codespace.length > 128 || /[\u0000-\u001f\u007f]/.test(codespace)) return null;
  return codespace;
}

export function cosmosCheckTxRejectionEvidence(value = {}) {
  const sources = [value, value?.broadcast, value?.cause].filter(source => (
    source && typeof source === "object"
  ));
  const source = sources.find(checkTxRejectionMarker);
  if (!source) return null;
  const providerCode = [
    source.providerCode,
    source.provider_code,
    source.txCode,
    source.code
  ].map(canonicalCosmosTxCode).find(code => code != null && code > 0);
  if (providerCode == null) return null;
  const rawCodespace = source.providerCodespace
    ?? source.provider_codespace
    ?? source.codespace
    ?? "";
  const providerCodespace = canonicalProviderCodespace(rawCodespace);
  if (providerCodespace == null) return null;
  return Object.freeze({
    rpcInvoked: true,
    checkTxRejected: true,
    providerCode: String(providerCode),
    ...(providerCodespace ? { providerCodespace } : {})
  });
}

function normalizedTxHash(value) {
  const hash = String(value || "").trim().replace(/^0x/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(hash) ? hash : "";
}

export function cosmosPublicCheckTxRejectionCanClear(entry = {}, check = {}) {
  const entryHash = normalizedTxHash(entry.txHash);
  const checkedHash = normalizedTxHash(check.txHash);
  const providerCode = canonicalCosmosTxCode(entry.providerCode);
  const checkedHeight = canonicalCosmosTxCode(check.checkedHeight);
  return entry.status === "unknown"
    && entry.rpcInvoked === true
    && entry.checkTxRejected === true
    && providerCode != null
    && providerCode > 0
    && Boolean(entryHash)
    && entryHash === checkedHash
    && check.checked === true
    && check.absent === true
    && check.included !== true
    && checkedHeight != null
    && checkedHeight > 0;
}

function reservationHasDurableBroadcastAttempt(record = {}) {
  return record.broadcast_in_flight === true
    || Number(record.broadcast_attempt_count || 0) > 0
    || ["Submitted", "Unknown", "ConfirmedSpent"].includes(String(record.status || ""));
}

export function cosmosReservationTransactionHash(record = {}) {
  const rawSubmitted = String(record.submitted_tx_hash || "").trim();
  const rawTxBytes = String(record.tx_bytes_hash || "").trim();
  const submitted = normalizedTxHash(rawSubmitted);
  const txBytes = normalizedTxHash(rawTxBytes);
  if ((rawSubmitted && !submitted)
    || (rawTxBytes && !txBytes)
    || (submitted && txBytes && submitted !== txBytes)) {
    return "";
  }
  if (submitted) return submitted;
  return txBytes && reservationHasDurableBroadcastAttempt(record) ? txBytes : "";
}

export function commonCosmosReservationTransactionHash(records = []) {
  if (!Array.isArray(records) || records.length === 0) return "";
  const hashes = records.map(cosmosReservationTransactionHash);
  if (hashes.some(hash => !hash)) return "";
  const unique = [...new Set(hashes)];
  return unique.length === 1 ? unique[0] : "";
}

export function cosmosPrivatePendingMarkerCanClear({ markerTxHash, txHash, error } = {}) {
  const marker = normalizedTxHash(markerTxHash);
  const submitted = normalizedTxHash(txHash);
  if (!marker || marker !== submitted) return false;
  // CheckTx rejection crossed the RPC boundary. Keep the account-wide fence
  // until the exact rejected transaction and every linked nullifier have been
  // reconciled through durable reservation evidence.
  return error?.rpcInvoked === false || error?.rpc_invoked === false;
}
