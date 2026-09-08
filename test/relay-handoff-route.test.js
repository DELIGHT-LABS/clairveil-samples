import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { createRelayWithdrawHandoff, relayWithdrawHandoffPayload } from "../public/relay-withdraw-reconciliation.js";

const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");
const routeStart = serverSource.indexOf('    if (req.method === "POST" && url.pathname === "/api/relayer/withdraw")');
const routeEnd = serverSource.indexOf('    const showAddress =', routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart);

// Execute the actual route with only the signer/chain boundary replaced. The
// browser-created envelope must survive JSON transport and reach the relay gate.
async function receive(body) {
  const calls = [];
  let response;
  const context = vm.createContext({
    req: { method: "POST" }, url: { pathname: "/api/relayer/withdraw" }, res: {},
    assertLocalTestBackendAllowed: () => {}, assertSignerMutationAllowed: () => {},
    readBody: async () => JSON.parse(JSON.stringify(body)),
    relayWithdrawHandoffPayload, localRelayerName: () => "relayer", validateAccount: value => value,
    runLocalSignerSubmission: async (_account, task) => task(),
    relayWithdrawSubmissionGate: { run: async payload => {
      calls.push(payload);
      return { broadcast: { txhash: "ab".repeat(32) }, payloadHash: payload.payload_hash };
    } },
    reconcileRelaySubmissionAttempt: () => {},
    sendJson: (_res, status, value) => { response = { status, value }; }
  });
  await vm.runInContext(`(async () => {${serverSource.slice(routeStart, routeEnd)}})()`, context);
  return { calls, response };
}

for (const transport of ["cosmos", "evm"]) {
  test(`${transport}: prepared v2 handoff automatically reaches the local relay route`, async () => {
    const payload = { version: "v2", payload_hash: "12".repeat(32), nullifier_hex: "34".repeat(32) };
    const handoff = createRelayWithdrawHandoff({ profileId: "local", transport, payload,
      ...(transport === "evm" ? { transaction: { to: "0x1234", data: "0xab" } } : {}) });
    assert.equal(handoff.payload, undefined);
    const { calls, response } = await receive({ handoff, expectedRecipient: "recipient", relayer: "relayer" });
    assert.equal(calls.length, 1);
    assert.equal(JSON.stringify(calls[0]), JSON.stringify(payload));
    assert.equal(response.status, 200);
    assert.equal(response.value.broadcast.txhash, "ab".repeat(32));
  });
}

test("direct payload requests remain supported", async () => {
  const payload = { version: "v2", payload_hash: "12".repeat(32) };
  const { calls } = await receive({ payload });
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(payload));
});

test("malformed handoff cannot silently fall back to a separate payload", async () => {
  await assert.rejects(receive({ handoff: { payload: { version: "v2" } }, payload: { version: "v2" } }), /v2 schema/);
  await assert.rejects(receive({}), /relay withdraw payload is required/);
});

for (const field of ["schema_version", "handoff_version", "request.version", "request.payload.version"]) {
  test(`rejects mismatched ${field} before entering the signer`, async () => {
    const handoff = createRelayWithdrawHandoff({
      profileId: "local", transport: "cosmos", payload: { version: "v2" }
    });
    const path = field.split(".");
    const key = path.pop();
    path.reduce((value, part) => value[part], handoff)[key] = "v1";
    await assert.rejects(receive({ handoff }), /v2 schema/);
  });
}

test("handoff payload takes precedence over a conflicting top-level payload", async () => {
  const payload = { version: "v2", payload_hash: "12".repeat(32) };
  const handoff = createRelayWithdrawHandoff({ profileId: "local", transport: "cosmos", payload });
  const { calls } = await receive({ handoff, payload: { ...payload, payload_hash: "56".repeat(32) } });
  assert.equal(calls[0].payload_hash, payload.payload_hash);
});
