import assert from "node:assert/strict";
import test from "node:test";

import { createValueMovingActionGate } from "../public/value-moving-action.js";

test("double-clicking a deposit joins one value-moving action", async () => {
  const gate = createValueMovingActionGate();
  let calls = 0;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });

  const first = gate.run("privacy-deposit", async () => {
    calls += 1;
    await blocked;
    return "submitted";
  });
  const second = gate.run("privacy-deposit", () => {
    calls += 1;
    return "duplicate";
  });

  assert.strictEqual(second, first);
  assert.equal(gate.active, true);
  assert.equal(gate.action, "privacy-deposit");
  assert.equal(calls, 1);
  release();
  assert.equal(await first, "submitted");
  assert.equal(gate.active, false);
});

test("a different value-moving action cannot enter while one is active", async () => {
  const gate = createValueMovingActionGate();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let withdrawCalls = 0;
  const deposit = gate.run("privacy-deposit", () => blocked);
  const withdraw = gate.run("privacy-withdraw", () => { withdrawCalls += 1; });

  assert.strictEqual(withdraw, deposit);
  assert.equal(withdrawCalls, 0);
  release("included");
  assert.equal(await deposit, "included");
});

test("session invalidation releases the UI gate without letting the old task clear a new action", async () => {
  const gate = createValueMovingActionGate();
  let oldSignal;
  let releaseOld;
  const old = gate.run("privacy-transfer", signal => {
    oldSignal = signal;
    return new Promise(resolve => { releaseOld = resolve; });
  });
  gate.invalidate();
  assert.equal(oldSignal.aborted, true);
  let releaseNew;
  let currentSignal;
  const current = gate.run("privacy-withdraw", signal => {
    currentSignal = signal;
    return new Promise(resolve => { releaseNew = resolve; });
  });
  assert.equal(currentSignal.aborted, false);
  releaseOld("stale");
  assert.equal(await old, "stale");
  assert.equal(gate.active, true);
  assert.equal(gate.action, "privacy-withdraw");
  releaseNew("current");
  assert.equal(await current, "current");
  assert.equal(gate.active, false);
});

test("session invalidation aborts an operation before its deferred prover boundary", async () => {
  const gate = createValueMovingActionGate();
  let finishPreflight;
  let providerCalls = 0;
  const preflight = new Promise(resolve => { finishPreflight = resolve; });

  const operation = gate.run("privacy-deposit", async signal => {
    await preflight;
    if (signal.aborted) return "cancelled";
    providerCalls += 1;
    return "proved";
  });

  gate.invalidate();
  finishPreflight();

  assert.equal(await operation, "cancelled");
  assert.equal(providerCalls, 0);
});

test("targeted cancellation aborts only the matching action and keeps the gate occupied until settlement", async () => {
  const gate = createValueMovingActionGate();
  let signal;
  const deposit = gate.run("privacy-deposit", currentSignal => {
    signal = currentSignal;
    return new Promise((resolve, reject) => {
      currentSignal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  });

  assert.strictEqual(gate.signal, signal);
  assert.equal(gate.cancel("privacy-transfer"), false);
  assert.equal(signal.aborted, false);
  assert.equal(gate.cancel("privacy-deposit"), true);
  assert.equal(signal.aborted, true);
  assert.equal(gate.cancel("privacy-deposit"), false);
  assert.equal(gate.active, true);

  let competingCalls = 0;
  const competing = gate.run("privacy-withdraw", () => {
    competingCalls += 1;
  });
  assert.strictEqual(competing, deposit);
  assert.equal(competingCalls, 0);
  await assert.rejects(deposit, /cancelled/);
  assert.equal(gate.active, false);
  assert.equal(gate.signal, null);

  assert.equal(await gate.run("privacy-deposit", () => "retry"), "retry");
});
