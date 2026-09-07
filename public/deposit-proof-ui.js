const depositPreparationFailureCode = "DEPOSIT_PREPARATION_FAILED";

const sdkProverCodes = new Set([
  "PROVER_CANCELLED",
  "PROVER_REJECTED",
  "PROVER_TIMEOUT",
  "PROVER_UNAVAILABLE"
]);

const proverResponseCodes = new Set([
  "busy",
  "invalid_request",
  "method_not_allowed",
  "not_found",
  "proof_failed",
  "unauthorized",
  "unavailable"
]);

const retryBlockingRecoveryStatuses = new Set([
  "attempting",
  "submitted",
  "unknown",
  "checking",
  "recovering",
  "recovery-pending",
  "pending"
]);

function nonEmpty(value) {
  return String(value || "").trim();
}

function titleCase(value) {
  const text = nonEmpty(value) || "deposit";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export function depositRecoveryBlocksRetry(status) {
  return retryBlockingRecoveryStatuses.has(nonEmpty(status).toLowerCase());
}

export function depositProofTopology({
  hasInjectedProvider = false,
  depositProofUrl = "",
  proverUrl = "",
  transport = ""
} = {}) {
  if (hasInjectedProvider) {
    return Object.freeze({ kind: "injected", available: true });
  }
  if (nonEmpty(depositProofUrl)) {
    return Object.freeze({ kind: "http", available: true, source: "deposit-proof-url" });
  }
  if (String(transport || "").toLowerCase() === "cosmos" && nonEmpty(proverUrl)) {
    return Object.freeze({ kind: "http", available: true, source: "prover-base-url" });
  }
  return Object.freeze({ kind: "unavailable", available: false });
}

export function depositProverDisclosure(topology = {}) {
  if (!topology.available) return Object.freeze({ hidden: true, text: "" });
  const witness = "receiver public keys, amount, asset ID, randomness, commitment";
  if (topology.kind === "http") {
    return Object.freeze({
      hidden: false,
      text: `Proof privacy: 설정된 HTTP prover에는 ${witness}가 전달됩니다. 이 서비스는 별도 신뢰 경계입니다. Timeout이나 cancel은 실행 중인 solver가 중단됐다는 증거가 아닙니다. 이 WebApp은 자동 failover하지 않으며 수동 재시도도 현재 설정된 동일 endpoint만 사용합니다.`
    });
  }
  return Object.freeze({
    hidden: false,
    text: `Proof privacy: 주입된 proof provider는 ${witness}를 처리합니다. 실행 위치, 전송, 보존 정책은 embedding product의 신뢰 경계입니다. Timeout이나 cancel은 실행 중인 solver가 중단됐다는 증거가 아닙니다. 이 WebApp은 provider를 자동 전환하지 않습니다.`
  });
}

export function depositProofCancelAvailable({ action = "", stage = "", aborted = false } = {}) {
  return action === "privacy-deposit"
    && (stage === "preparing" || stage === "proving")
    && aborted !== true;
}

export function depositStageText(stage, { label = "deposit", wallet = "wallet" } = {}) {
  const subject = nonEmpty(label) || "deposit";
  const titled = titleCase(subject);
  switch (stage) {
    case "preparing":
      return `Preparing ${subject} · no broadcast`;
    case "proving":
      return `Generating ${subject} proof · no broadcast`;
    case "cancelling":
      return `Cancelling ${subject} proof · no broadcast`;
    case "cancelled":
      return `${titled} proof cancelled · no broadcast`;
    case "proof-ready":
      return `${titled} proof ready · no broadcast`;
    case "wallet-approval":
      return `${titled} proof ready · waiting for ${nonEmpty(wallet) || "wallet"} · no broadcast yet`;
    case "wallet-result-unknown":
      return `${titled} wallet boundary started · request may have opened · do not retry yet`;
    case "submitted":
      return `${titled} submitted · waiting for inclusion`;
    case "checking":
      return `${titled} transaction identity saved · checking chain evidence · do not retry`;
    case "recovering":
      return `${titled} included · recovering encrypted note`;
    case "recovered":
      return `${titled} included · encrypted note recovered`;
    case "unknown":
      return `${titled} submitted · result unknown · do not retry yet`;
    case "broadcast-result-unknown":
      return `${titled} signed transaction saved · broadcast result unknown · do not retry yet`;
    case "failed-on-chain":
      return `${titled} included · execution failed`;
    case "rejected-by-node":
      return `${titled} rejected by node · exact transaction confirmed absent`;
    case "recovery-state-unknown":
      return `${titled} recovery state unavailable · check wallet history before retrying`;
    case "failed-before-broadcast":
      return `${titled} preparation stopped before a confirmed broadcast`;
    default:
      return "Not started · no broadcast";
  }
}

export function depositStageFromRecovery({
  status = "idle",
  txHash = "",
  fallback = "Not started · no broadcast",
  fallbackStage = "transient",
  preferFallback = false,
  label = "deposit",
  wallet = "wallet"
} = {}) {
  if (preferFallback) {
    return Object.freeze({
      stage: nonEmpty(fallbackStage) || "transient",
      text: nonEmpty(fallback) || depositStageText("")
    });
  }
  const normalizedStatus = nonEmpty(status).toLowerCase();
  const hasTransactionHash = Boolean(nonEmpty(txHash));
  let stage = "";
  switch (normalizedStatus) {
    case "attempting":
      stage = "wallet-result-unknown";
      break;
    case "submitted":
      stage = hasTransactionHash ? "submitted" : "wallet-result-unknown";
      break;
    case "checking":
      stage = hasTransactionHash ? "checking" : "recovery-state-unknown";
      break;
    case "unknown":
      stage = hasTransactionHash ? "broadcast-result-unknown" : "recovery-state-unknown";
      break;
    case "recovering":
    case "recovery-pending":
    case "pending":
      stage = hasTransactionHash ? "recovering" : "recovery-state-unknown";
      break;
    case "recovered":
      stage = hasTransactionHash ? "recovered" : "recovery-state-unknown";
      break;
    case "failed":
      stage = hasTransactionHash ? "failed-on-chain" : "";
      break;
    case "rejected":
      stage = hasTransactionHash ? "rejected-by-node" : "";
      break;
    default:
      break;
  }
  return Object.freeze({
    stage: stage || nonEmpty(fallbackStage) || "transient",
    text: stage
      ? depositStageText(stage, { label, wallet })
      : nonEmpty(fallback) || depositStageText("")
  });
}

function safeDepositPreparationMetadata(error) {
  const sdkCode = nonEmpty(error?.code);
  const proverCode = nonEmpty(error?.proverCode);
  return Object.freeze({
    sdkCode: sdkProverCodes.has(sdkCode) ? sdkCode : "",
    proverCode: proverResponseCodes.has(proverCode) ? proverCode : "",
    status: Number.isInteger(error?.status) ? error.status : 0,
    retryable: error?.retryable === true
  });
}

export function createDepositPreparationFailure(error) {
  const failure = new Error("deposit preparation failed before wallet approval");
  failure.name = "DepositPreparationFailure";
  failure.code = depositPreparationFailureCode;
  failure.depositPreparation = safeDepositPreparationMetadata(error);
  failure.broadcastAbortedBeforeRpc = true;
  return failure;
}

export function isDepositPreparationFailure(error) {
  return error?.code === depositPreparationFailureCode
    && error?.name === "DepositPreparationFailure"
    && error?.depositPreparation
    && typeof error.depositPreparation === "object";
}

function failureKind(metadata) {
  const { sdkCode, proverCode, status } = metadata;
  if (sdkCode === "PROVER_CANCELLED") return "cancelled";
  if (sdkCode === "PROVER_TIMEOUT") return "timeout";
  if ([400, 413, 415].includes(status) && proverCode === "invalid_request") return "request-invalid";
  if (status === 500 && proverCode === "proof_failed") return "proof-failed";
  if (status === 429 && proverCode === "busy") return "busy";
  if (status === 503 && proverCode === "unavailable") return "unavailable";
  if (status === 401 && proverCode === "unauthorized") return "unauthorized";
  if ((status === 404 && proverCode === "not_found")
    || (status === 405 && proverCode === "method_not_allowed")) {
    return "endpoint-invalid";
  }
  if (sdkCode === "PROVER_UNAVAILABLE") return "unavailable";
  if (sdkCode === "PROVER_REJECTED") return "protocol-rejected";
  return "preparation-failed";
}

export function depositPreparationFailurePresentation(error, { topologyKind = "injected" } = {}) {
  if (!isDepositPreparationFailure(error)) return null;
  const kind = failureKind(error.depositPreparation);
  const retryTarget = topologyKind === "http"
    ? "현재 설정된 동일 prover endpoint"
    : "현재 설정된 동일 proof provider";
  const noSubmission = "지갑 서명과 트랜잭션 제출은 시작되지 않았습니다.";
  const manualRetry = `Deposit 버튼으로 수동 재시도할 수 있으며 ${retryTarget}만 사용하고 자동 failover하지 않습니다.`;
  const presentations = {
    "request-invalid": {
      title: "Deposit proof 요청 오류",
      stateLabel: "Deposit proof request invalid · no broadcast",
      message: `설정된 prover가 proving 전에 요청을 거부했습니다. 활성 chain/profile과 요청 계약을 확인하세요. ${noSubmission} 자동 재시도하지 않습니다.`
    },
    "proof-failed": {
      title: "Deposit prover 실패",
      stateLabel: "Deposit prover failed · no broadcast",
      message: `설정된 prover가 요청을 수락했지만 proof 생성에 실패했습니다. ${noSubmission} 자동 재시도하지 말고 prover 상태를 확인하세요.`
    },
    busy: {
      title: "Deposit prover 사용 중",
      stateLabel: "Deposit prover busy · no broadcast",
      message: `설정된 prover의 처리 용량이 가득 찼습니다. ${noSubmission} ${manualRetry}`
    },
    unavailable: {
      title: "Deposit prover 연결 실패",
      stateLabel: "Deposit prover unavailable · no broadcast",
      message: `설정된 prover에 연결할 수 없습니다. ${noSubmission} ${manualRetry}`
    },
    timeout: {
      title: "Deposit proof 시간 초과",
      stateLabel: "Deposit proof timed out · no broadcast",
      message: `Proof 응답 시간이 초과됐습니다. Solver 중단 여부는 확인되지 않습니다. ${noSubmission} ${manualRetry}`
    },
    cancelled: {
      title: "Deposit proof 취소됨",
      stateLabel: "Deposit proof cancelled · no broadcast",
      message: `Proof 대기가 취소됐습니다. Solver 중단 여부는 확인되지 않습니다. ${noSubmission} ${manualRetry}`
    },
    unauthorized: {
      title: "Deposit prover 인증 오류",
      stateLabel: "Deposit prover authorization failed · no broadcast",
      message: `설정된 prover 인증에 실패했습니다. ${noSubmission} 인증 설정을 확인한 뒤 다시 시도하세요.`
    },
    "endpoint-invalid": {
      title: "Deposit prover endpoint 오류",
      stateLabel: "Deposit prover endpoint invalid · no broadcast",
      message: `설정된 deposit prover route가 canonical HTTP contract와 맞지 않습니다. ${noSubmission} Endpoint 설정을 확인하세요.`
    },
    "protocol-rejected": {
      title: "Deposit proof 응답 오류",
      stateLabel: "Deposit proof response rejected · no broadcast",
      message: `Proof 응답이 canonical deposit contract 검증을 통과하지 못했습니다. ${noSubmission} 자동 재시도하지 말고 prover와 profile 호환성을 확인하세요.`
    },
    "preparation-failed": {
      title: "Deposit 준비 실패",
      stateLabel: "Deposit preparation failed before wallet approval · no broadcast",
      message: `Deposit 준비가 지갑 승인 전에 실패했습니다. Proof provider, network preflight, account/sign-doc 조립 중 어느 단계인지는 확정하지 않으며 원본 진단은 표시하지 않습니다. ${noSubmission} 자동 failover하지 않습니다.`
    }
  };
  return Object.freeze({ kind, ...presentations[kind] });
}
