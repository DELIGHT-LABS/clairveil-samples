import assert from "node:assert/strict";
import test from "node:test";

import { normalizeLeadingZeroMinimalDenomAmount } from "../public/minimal-denom-input.js";

test("minimal-denom amount input removes leading zeroes only from integer input", () => {
  assert.equal(normalizeLeadingZeroMinimalDenomAmount("0001"), "1");
  assert.equal(normalizeLeadingZeroMinimalDenomAmount("010"), "10");
  assert.equal(normalizeLeadingZeroMinimalDenomAmount("0"), "0");
  assert.equal(normalizeLeadingZeroMinimalDenomAmount(""), "");
  assert.equal(normalizeLeadingZeroMinimalDenomAmount("0.1"), "0.1");
  assert.equal(normalizeLeadingZeroMinimalDenomAmount("1a"), "1a");
});
