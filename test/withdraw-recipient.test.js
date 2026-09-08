import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evmAddressToBech32, bech32AddressToEvm } from "clairveiljs/evm";
import { computePreparedWithdrawPayloadHash, validateRelayWithdrawPayload } from "clairveiljs/core";
import { withdrawPayloadRecipient } from "../public/withdraw-operation-evidence.js";

const recipient = `0x${"12".repeat(20)}`;
function payloadFor(prefix, address = recipient) {
  const payload = { version: "v2", expires_at_unix: 200,
    chain_id: "host-test", recipient: evmAddressToBech32(address, prefix),
    amount: "10utest", proof_hex: "01", root_hex: "11".repeat(32), nullifier_hex: "22".repeat(32) };
  payload.payload_hash = computePreparedWithdrawPayloadHash(payload);
  return payload;
}

for (const prefix of ["host", "cosmos", "other"]) {
  test(`EVM recipient matches the actual SDK payload contract using configured prefix ${prefix}`, () => {
    const payload = payloadFor(prefix);
    const options = { chainNowUnix: 100, expectedChainId: "host-test", accountPrefix: prefix };
    assert.throws(() => validateRelayWithdrawPayload(payload, { ...options, expectedRecipient: recipient }), /recipient mismatch/);
    const expectedRecipient = withdrawPayloadRecipient(recipient, { transport: "evm", accountPrefix: prefix });
    assert.equal(bech32AddressToEvm(expectedRecipient, prefix).toLowerCase(), recipient);
    assert.equal(validateRelayWithdrawPayload(payload, { ...options, expectedRecipient }), true);
    assert.equal(withdrawPayloadRecipient(payload.recipient, { transport: "cosmos", accountPrefix: prefix }), payload.recipient);
    assert.equal(withdrawPayloadRecipient(payload.recipient, { transport: "evm", accountPrefix: prefix }), payload.recipient);
    assert.throws(() => validateRelayWithdrawPayload(payloadFor(prefix, `0x${"34".repeat(20)}`), {
      ...options, expectedRecipient
    }), /recipient mismatch/);
    assert.throws(() => validateRelayWithdrawPayload(payloadFor("wrong"), {
      ...options, expectedRecipient
    }), /prefix mismatch/);
  });
}

test("recipient normalization requires a configured prefix and never trusts the payload recipient", async () => {
  assert.throws(() => withdrawPayloadRecipient(recipient, { transport: "evm" }), /account prefix/);
  assert.throws(() => withdrawPayloadRecipient("", { transport: "evm", accountPrefix: "host" }), /recipient/);
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /expectedRecipient: withdrawPayloadRecipient\(data\.reservationRecipient,\s*\{\s*transport: activeChainProfile\(\)\?\.transport,\s*accountPrefix: accountPrefix\(\)/);
});
