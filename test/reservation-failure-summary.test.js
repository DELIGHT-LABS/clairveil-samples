import test from "node:test";
import assert from "node:assert/strict";
import { reservationPreparationFailureSummary } from "../public/reservation-recovery.js";

const record = kind => ({
  status: "ManualReview",
  metadata: {
    reconcile_reason: "preparation_outcome_unknown_after_proving",
    preparation_failure_kind: kind
  }
});

test("preparation failure summary explains legacy quarantine without claiming spend or release", () => {
  const text = reservationPreparationFailureSummary([record(undefined)]);
  assert.match(text, /상세 실패 원인은 기록되지 않았습니다/);
  assert.match(text, /note가 소비됐다는 뜻이 아닙니다/);
  assert.match(text, /자동 해제하지 않습니다/);
});

test("preparation summary uses only bounded diagnostic labels", () => {
  for (const [kind, message] of [["cancelled", "취소"], ["timeout", "초과"], ["wallet_rejected", "거절"]]) {
    assert.match(reservationPreparationFailureSummary([record(kind)]), new RegExp(message));
  }
  assert.doesNotMatch(reservationPreparationFailureSummary([record("secret witness")]), /secret witness/);
  assert.equal(reservationPreparationFailureSummary([{ status: "Submitted", metadata: record("cancelled").metadata }]), "");
});
