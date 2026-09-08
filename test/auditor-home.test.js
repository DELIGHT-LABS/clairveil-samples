import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
const start = source.indexOf('    if (req.method === "GET" && url.pathname === "/api/auditor/test-scalar")');
const end = source.indexOf('    // Test/admin-only route.', start);
assert.ok(start > 0 && end > start);

async function request({ home, allowed = true, matching = true } = {}) {
  let input, response;
  const publicKey = "12".repeat(32);
  const context = vm.createContext({
    req: { method: "GET" }, url: { pathname: "/api/auditor/test-scalar" }, res: {},
    process: { env: home ? { CLAIRVEIL_AUDITOR_HOME: home } : {} },
    assertLocalTestBackendAllowed: () => { if (!allowed) throw new Error("local test required"); },
    assertLocalAdminAccessAllowed: () => {},
    fetchJson: async () => ({ audit_master_pubkey_hex: publicKey }), restUrl: path => path,
    testAuditMaterialFromConfig: () => null,
    localSignerHome: () => "/test/signer", localSignerKeyring: () => "test", config: { accountPrefix: "example" },
    runAuditorMaterial: async value => {
      input = value;
      return { key_name: value.key_name, disclosure_pubkey_hex: matching ? publicKey : "34".repeat(32) };
    },
    sendJson: (_res, status, value) => { response = { status, value }; }
  });
  await vm.runInContext(`(async () => {${source.slice(start, end)}})()`, context);
  return { input, response };
}

test("auditor uses configured separate home without changing the signer home or audit target", async () => {
  const { input, response } = await request({ home: "/test/auditor" });
  assert.equal(input.home, "/test/auditor");
  assert.equal(input.key_name, "auditor");
  assert.equal(input.account_prefix, "example");
  assert.equal(response.status, 200);
  assert.equal(response.value.matches_audit_config, true);
});

test("default auditor home stays compatible and mismatched keys remain visibly invalid", async () => {
  assert.equal((await request()).input.home, "/test/signer");
  assert.equal((await request({ matching: false })).response.value.matches_audit_config, false);
});

test("separate auditor home does not bypass local test access control", async () => {
  await assert.rejects(request({ home: "/test/auditor", allowed: false }), /local test required/);
});
