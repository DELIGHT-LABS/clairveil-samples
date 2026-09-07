import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createDepositPreparationFailure,
  depositProofCancelAvailable,
  depositPreparationFailurePresentation,
  depositProofTopology,
  depositProverDisclosure,
  depositRecoveryBlocksRetry,
  depositStageFromRecovery,
  depositStageText,
  isDepositPreparationFailure
} from "../public/deposit-proof-ui.js";
import {
  loadPublicPendingTxState,
  publicPendingTxKey,
  savePublicPendingTxState
} from "../public/public-pending-tx-store.js";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const htmlSource = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test("Deposit recovery controls block retries throughout unresolved note recovery", () => {
  for (const status of [
    "attempting",
    "submitted",
    "unknown",
    "checking",
    "recovering",
    "recovery-pending",
    "pending"
  ]) {
    assert.equal(depositRecoveryBlocksRetry(status), true, status);
  }
  for (const status of ["", "idle", "recovered", "failed", "rejected"]) {
    assert.equal(depositRecoveryBlocksRetry(status), false, status);
  }
  assert.equal(depositRecoveryBlocksRetry(" RECOVERING "), true);
});

test("Deposit discloses the selected proof trust boundary without assuming an injected provider is remote", () => {
  const exactHttp = depositProofTopology({
    depositProofUrl: "https://proof.example/v1/prover/deposit",
    proverUrl: "https://prover.example",
    transport: "cosmos"
  });
  const canonicalHttp = depositProofTopology({
    proverUrl: "https://prover.example/tenant",
    transport: "cosmos"
  });
  const injected = depositProofTopology({
    hasInjectedProvider: true,
    depositProofUrl: "https://unused.example",
    transport: "cosmos"
  });

  assert.deepEqual(exactHttp, { kind: "http", available: true, source: "deposit-proof-url" });
  assert.deepEqual(canonicalHttp, { kind: "http", available: true, source: "prover-base-url" });
  assert.deepEqual(injected, { kind: "injected", available: true });
  assert.deepEqual(depositProofTopology({ transport: "evm" }), {
    kind: "unavailable",
    available: false
  });

  const httpNotice = depositProverDisclosure(exactHttp);
  for (const field of ["receiver public keys", "amount", "asset ID", "randomness", "commitment"]) {
    assert.match(httpNotice.text, new RegExp(field));
  }
  assert.match(httpNotice.text, /별도 신뢰 경계/);
  assert.match(httpNotice.text, /동일 endpoint/);
  assert.match(httpNotice.text, /자동 failover하지 않/);
  assert.match(httpNotice.text, /solver가 중단됐다는 증거가 아닙/);

  const injectedNotice = depositProverDisclosure(injected);
  assert.match(injectedNotice.text, /주입된 proof provider/);
  assert.match(injectedNotice.text, /embedding product/);
  assert.doesNotMatch(injectedNotice.text, /설정된 HTTP prover/);
  assert.match(injectedNotice.text, /자동 전환하지 않/);
});

test("Deposit proof progress keeps proving and wallet broadcast as distinct phases", () => {
  assert.equal(depositStageText("preparing"), "Preparing deposit · no broadcast");
  assert.equal(depositStageText("proving"), "Generating deposit proof · no broadcast");
  assert.equal(depositStageText("proof-ready"), "Deposit proof ready · no broadcast");
  assert.equal(
    depositStageText("wallet-approval", { wallet: "Keplr" }),
    "Deposit proof ready · waiting for Keplr · no broadcast yet"
  );
  assert.equal(depositStageText("submitted"), "Deposit submitted · waiting for inclusion");
  assert.equal(depositStageText("recovering"), "Deposit included · recovering encrypted note");
  assert.equal(
    depositStageText("rejected-by-node"),
    "Deposit rejected by node · exact transaction confirmed absent"
  );

  const depositSectionStart = htmlSource.indexOf('id="depositVeiledTitle"');
  const depositSectionEnd = htmlSource.indexOf("</section>", depositSectionStart);
  const depositSection = htmlSource.slice(depositSectionStart, depositSectionEnd);
  assert.match(depositSection, /id="depositProverPrivacyNotice"/);
  assert.match(depositSection, /id="keplrDepositStage"[^>]*aria-live="polite"/);
  assert.match(depositSection, /Not started · no broadcast/);

  const broadcastStart = appSource.indexOf("async function broadcastPrivacyDeposit");
  const broadcastEnd = appSource.indexOf("function normalizedHex", broadcastStart);
  const broadcastSource = appSource.slice(broadcastStart, broadcastEnd);
  const proving = broadcastSource.indexOf('setDepositStage("proving"');
  const prepare = broadcastSource.indexOf("await preparePrivacyDepositSignDoc");
  const proofReady = broadcastSource.indexOf('setDepositStage("proof-ready"');
  const walletApproval = broadcastSource.indexOf('setDepositStage("wallet-approval"');
  const broadcast = broadcastSource.indexOf("broadcastPreparedPrivacy");
  assert.ok(proving >= 0 && proving < prepare);
  assert.ok(prepare < proofReady && proofReady < walletApproval);
  assert.ok(walletApproval < broadcast);
});

test("Deposit proof cancellation is available only before proof-ready and cannot release the broadcast gate", () => {
  for (const stage of ["preparing", "proving"]) {
    assert.equal(depositProofCancelAvailable({ action: "privacy-deposit", stage }), true, stage);
  }
  for (const stage of ["", "cancelling", "cancelled", "proof-ready", "wallet-approval", "submitted"]) {
    assert.equal(depositProofCancelAvailable({ action: "privacy-deposit", stage }), false, stage);
  }
  assert.equal(depositProofCancelAvailable({ action: "privacy-deposit", stage: "proving", aborted: true }), false);
  assert.equal(depositProofCancelAvailable({ action: "privacy-transfer", stage: "proving" }), false);
  assert.equal(depositStageText("cancelling"), "Cancelling deposit proof · no broadcast");
  assert.equal(depositStageText("cancelled"), "Deposit proof cancelled · no broadcast");

  const depositSectionStart = htmlSource.indexOf('id="depositVeiledTitle"');
  const depositSectionEnd = htmlSource.indexOf("</section>", depositSectionStart);
  const depositSection = htmlSource.slice(depositSectionStart, depositSectionEnd);
  assert.match(depositSection, /id="cancelDepositProof"[^>]*hidden[^>]*disabled/);

  const cancelHandlerStart = appSource.indexOf("function cancelDepositProof");
  const cancelHandlerEnd = appSource.indexOf("async function depositFromKeplrUnlocked", cancelHandlerStart);
  const cancelHandler = appSource.slice(cancelHandlerStart, cancelHandlerEnd);
  assert.match(cancelHandler, /valueMovingActionGate\.cancel\("privacy-deposit"\)/);
  assert.match(cancelHandler, /setDepositStage\("cancelling"\)/);

  const broadcastStart = appSource.indexOf("async function broadcastPrivacyDeposit");
  const broadcastEnd = appSource.indexOf("function normalizedHex", broadcastStart);
  const broadcastSource = appSource.slice(broadcastStart, broadcastEnd);
  const prepare = broadcastSource.indexOf("await preparePrivacyDepositSignDoc");
  const cancellationFence = broadcastSource.indexOf("throwIfDepositProofCancelled(options.signal)", prepare);
  const proofReady = broadcastSource.indexOf('setDepositStage("proof-ready"');
  const walletApproval = broadcastSource.indexOf('setDepositStage("wallet-approval"');
  const broadcast = broadcastSource.indexOf("broadcastPreparedPrivacy");
  assert.ok(prepare >= 0 && prepare < cancellationFence && cancellationFence < proofReady);
  assert.ok(proofReady < walletApproval && walletApproval < broadcast);
});

test("Deposit stage restores durable boundaries without claiming a pre-RPC marker was submitted", () => {
  const identity = { profileId: "evm:test", owner: "0xabc" };
  const key = publicPendingTxKey(identity);
  const cases = [
    [
      { attemptId: "ab".repeat(32), status: "attempting" },
      /wallet boundary started .* request may have opened .* do not retry yet/
    ],
    [
      { txHash: `0x${"12".repeat(32)}`, status: "submitted" },
      /submitted .* waiting for inclusion/
    ],
    [
      { txHash: `0x${"34".repeat(32)}`, status: "unknown" },
      /signed transaction saved .* broadcast result unknown .* do not retry yet/
    ],
    [
      { txHash: `0x${"56".repeat(32)}`, status: "recovery-pending", height: "42" },
      /included .* recovering encrypted note/
    ]
  ];

  for (const [entry, expected] of cases) {
    const storage = new MemoryStorage();
    savePublicPendingTxState(storage, key, { ...identity, deposit: entry });
    const restored = loadPublicPendingTxState(storage, key, identity).deposit;
    const presentation = depositStageFromRecovery({
      status: restored.status,
      txHash: restored.txHash,
      fallback: "Not started · no broadcast",
      wallet: "MetaMask"
    });
    assert.match(presentation.text, expected);
    assert.doesNotMatch(presentation.text, /Not started|no broadcast/);
    if (entry.status === "unknown") assert.doesNotMatch(presentation.text, /submitted/i);
  }

  assert.deepEqual(depositStageFromRecovery({
    status: "rejected",
    txHash: `0x${"90".repeat(32)}`
  }), {
    stage: "rejected-by-node",
    text: "Deposit rejected by node · exact transaction confirmed absent"
  });

  for (const previousStatus of ["recovered", "failed", "rejected"]) {
    assert.deepEqual(depositStageFromRecovery({
      status: previousStatus,
      txHash: `0x${"91".repeat(32)}`,
      fallback: depositStageText("cancelling"),
      fallbackStage: "cancelling",
      preferFallback: true
    }), {
      stage: "cancelling",
      text: "Cancelling deposit proof · no broadcast"
    });
  }

  const renderStart = appSource.indexOf("function renderKeplr");
  const renderEnd = appSource.indexOf("function renderReservations", renderStart);
  assert.match(
    appSource.slice(renderStart, renderEnd),
    /depositStageFromRecovery\(\{[\s\S]*depositRecoveryStatus[\s\S]*depositHash/
  );
  assert.match(
    appSource.slice(renderStart, renderEnd),
    /activeDepositPreparation[\s\S]*!depositRecoveryBlocksRetry[\s\S]*preferFallback: activeDepositPreparation/
  );

  const signStart = appSource.indexOf("const checkpoint = await client.signDirect");
  const signEnd = appSource.indexOf("async function broadcastPrivacyDeposit", signStart);
  const signSource = appSource.slice(signStart, signEnd);
  assert.ok(
    signSource.indexOf("persistCapturedPublicPendingTransaction")
      < signSource.indexOf("await client.broadcastTxRawBytes"),
    "the test fixture models a crash after durable identity persistence and before the RPC call"
  );
});

test("Deposit proof failures are classified without retaining provider diagnostics", () => {
  const canary = "CANARY_PRIVATE_SOLVER_DIAGNOSTIC";
  const cases = [
    [{ code: "PROVER_REJECTED", status: 400, proverCode: "invalid_request" }, "request-invalid"],
    [{ code: "PROVER_REJECTED", status: 413, proverCode: "invalid_request" }, "request-invalid"],
    [{ code: "PROVER_REJECTED", status: 415, proverCode: "invalid_request" }, "request-invalid"],
    [{ code: "PROVER_REJECTED", status: 500, proverCode: "proof_failed" }, "proof-failed"],
    [{ code: "PROVER_UNAVAILABLE", status: 429, proverCode: "busy", retryable: true }, "busy"],
    [{ code: "PROVER_UNAVAILABLE", status: 503, proverCode: "unavailable" }, "unavailable"],
    [{ code: "PROVER_TIMEOUT" }, "timeout"],
    [{ code: "PROVER_CANCELLED" }, "cancelled"],
    [{ code: "PROVER_REJECTED", status: 401, proverCode: "unauthorized" }, "unauthorized"],
    [{ code: "PROVER_REJECTED", status: 404, proverCode: "not_found" }, "endpoint-invalid"],
    [{ code: "PROVER_REJECTED", status: 405, proverCode: "method_not_allowed" }, "endpoint-invalid"],
    [{ code: "PROVER_REJECTED", status: 500, proverCode: "invalid_request" }, "protocol-rejected"],
    [{}, "preparation-failed"]
  ];

  for (const [metadata, expectedKind] of cases) {
    const source = Object.assign(new Error(canary), metadata, {
      cause: new Error(`${canary}_CAUSE`),
      details: { diagnostic: `${canary}_DETAILS` }
    });
    const failure = createDepositPreparationFailure(source);
    const presentation = depositPreparationFailurePresentation(failure, { topologyKind: "http" });
    assert.equal(isDepositPreparationFailure(failure), true);
    assert.equal(failure.broadcastAbortedBeforeRpc, true);
    assert.equal(failure.message, "deposit preparation failed before wallet approval");
    assert.equal(presentation.kind, expectedKind);
    assert.match(presentation.stateLabel, /no broadcast/);
    assert.match(presentation.message, /트랜잭션 제출은 시작되지 않았습니다/);
    const rendered = `${failure.message}\n${JSON.stringify(failure)}\n${Object.values(presentation).join("\n")}`;
    assert.doesNotMatch(rendered, /CANARY_PRIVATE_SOLVER_DIAGNOSTIC/);
  }

  const requestFailure = depositPreparationFailurePresentation(createDepositPreparationFailure({
    code: "PROVER_REJECTED",
    status: 415,
    proverCode: "invalid_request"
  }));
  const proverFailure = depositPreparationFailurePresentation(createDepositPreparationFailure({
    code: "PROVER_REJECTED",
    status: 500,
    proverCode: "proof_failed"
  }));
  assert.notEqual(requestFailure.kind, proverFailure.kind);
  assert.notEqual(requestFailure.title, proverFailure.title);

  const neutralFailure = depositPreparationFailurePresentation(
    createDepositPreparationFailure(new Error(canary))
  );
  assert.equal(neutralFailure.kind, "preparation-failed");
  assert.match(neutralFailure.message, /network preflight, account\/sign-doc/);
  assert.doesNotMatch(neutralFailure.title, /prover|proof/i);
});

test("Deposit handles proof failure before any transaction-evidence recovery path", () => {
  const prepareStart = appSource.indexOf("async function preparePrivacyDepositSignDoc");
  const prepareEnd = appSource.indexOf("async function preparePrivacyTransferSignDoc", prepareStart);
  const prepareSource = appSource.slice(prepareStart, prepareEnd);
  assert.match(prepareSource, /try \{[\s\S]*await clairveilBrowserClient\(\)\.prepareDeposit/);
  assert.match(prepareSource, /catch \(error\) \{\s*throw createDepositPreparationFailure\(error\);/);

  const handlerStart = appSource.indexOf("async function depositFromKeplrUnlocked");
  const handlerEnd = appSource.indexOf("function noteStoreMutationLockName", handlerStart);
  const handlerSource = appSource.slice(handlerStart, handlerEnd);
  const presentation = handlerSource.indexOf("depositPreparationFailurePresentation");
  const txEvidence = handlerSource.indexOf("transactionHashFromEvidence");
  assert.ok(presentation >= 0 && presentation < txEvidence);
  const proofBranchEnd = handlerSource.indexOf("if (activeChainProfile", presentation);
  const proofBranch = handlerSource.slice(presentation, proofBranchEnd);
  assert.match(proofBranch, /depositRecoveryStatus = "idle"/);
  assert.match(proofBranch, /Not started · no transaction submitted/);
  assert.match(proofBranch, /message: proofFailure\.message/);
  assert.doesNotMatch(proofBranch, /error\.message/);
});
