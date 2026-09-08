import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { waitForPublicEvmSend } from "../public/evm-public-send.js";

const hash = `0x${"ab".repeat(32)}`;
const receipt = {
  transactionHash: hash, status: "0x1", blockNumber: "0x7ca",
  blockHash: `0x${"cd".repeat(32)}`, logs: []
};

function clientFor(result, { networkFailureAt = 0 } = {}) {
  let checks = 0;
  return {
    get checks() { return checks; },
    async assertEvmNetwork() {
      checks++;
      if (checks === networkFailureAt) throw new Error("wrong network");
    },
    async waitForEvmReceipt(requested) {
      assert.equal(requested, hash);
      return result;
    },
    async waitForEvmTransaction() { assert.fail("native send must not use privacy verifier"); }
  };
}

test("native send confirms an event-free receipt, including stored uppercase hashes", async () => {
  const client = clientFor(receipt);
  const result = await waitForPublicEvmSend(client, hash.slice(2).toUpperCase());
  assert.equal(result.ok, true);
  assert.equal(result.unknown, false);
  assert.equal(result.txHash, hash);
  assert.equal(client.checks, 2);
});

test("missing receipt stays unknown", async () => {
  assert.equal((await waitForPublicEvmSend(clientFor(null), hash)).unknown, true);
});

test("explicit failure provides exact receipt evidence to release the pending send", async () => {
  await assert.rejects(waitForPublicEvmSend(clientFor({ ...receipt, status: "0x0" }), hash), error => {
    assert.equal(error.code, "TX_FAILED_ON_CHAIN");
    assert.equal(error.broadcast.receipt.transactionHash, hash);
    assert.equal(error.broadcast.receipt.status, "0x0");
    return true;
  });
});

for (const [label, overrides] of [
  ["wrong hash", { transactionHash: `0x${"ef".repeat(32)}`, status: "0x0" }],
  ["missing status", { status: undefined }],
  ["invalid status", { status: "0x2" }],
  ["missing block", { blockNumber: null }],
  ["missing block hash", { blockHash: null }]
]) {
  test(`${label} cannot clear the pending send`, async () => {
    await assert.rejects(waitForPublicEvmSend(clientFor({ ...receipt, ...overrides }), hash), error => {
      assert.equal(error.broadcast, undefined);
      assert.notEqual(error.code, "TX_FAILED_ON_CHAIN");
      return true;
    });
  });
}

for (const networkFailureAt of [1, 2]) {
  test(`network mismatch at check ${networkFailureAt} cannot confirm`, async () => {
    await assert.rejects(waitForPublicEvmSend(clientFor(receipt, { networkFailureAt }), hash), /wrong network/);
  });
}

test("RPC errors remain errors rather than success or confirmed failure", async () => {
  const client = clientFor(receipt);
  client.waitForEvmReceipt = async () => { throw new Error("offline"); };
  await assert.rejects(waitForPublicEvmSend(client, hash), /offline/);
});

test("web routes native sends and their reconciliation through receipt-only confirmation", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /label: "EVM send",\s*publicSend: true/);
  assert.match(source, /const waitForResult = \(\) => publicSend\s*\? waitForPublicEvmSend/);
  assert.match(source, /result = await waitForEvmTransaction\(txHash, "EVM deposit", saved\)/);
  assert.match(source, /result = await waitForPublicEvmSend\(clairveilBrowserClient\(\), txHash\)/);
  assert.match(source, /title: "Send 제출됨"/);
  assert.match(source, /state\.keplr\.sendStatus = "included";\s*els\.keplrTxState\.textContent = "Send included";\s*showNotice\(\{\s*title: "Send 완료"/);
});
