import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSecureProverUpstreamUrl,
  normalizeConfiguredTransport,
  resolveProfileDenom,
} from "../server-profile-config.js";

test("profile denom prefers transport-specific metadata over the global fallback", () => {
  assert.equal(resolveProfileDenom({
    transport: "cosmos",
    environment: {
      CLAIRVEIL_DENOM: "globalcoin",
      CLAIRVEIL_COSMOS_DENOM: "cosmoscoin",
    },
  }), "cosmoscoin");

  assert.equal(resolveProfileDenom({
    transport: "evm",
    environment: {
      CLAIRVEIL_DENOM: "globalcoin",
      CLAIRVEIL_EVM_NATIVE_DENOM: "nativecoin",
      CLAIRVEIL_EVM_DENOM: "evmcoin",
    },
  }), "evmcoin");
});

test("EVM native denom and then the global denom provide generic fallbacks", () => {
  assert.equal(resolveProfileDenom({
    transport: "evm",
    environment: {
      CLAIRVEIL_DENOM: "globalcoin",
      CLAIRVEIL_EVM_NATIVE_DENOM: "nativecoin",
    },
  }), "nativecoin");
  assert.equal(resolveProfileDenom({
    transport: "evm",
    environment: { CLAIRVEIL_DENOM: "globalcoin" },
  }), "globalcoin");
  assert.equal(resolveProfileDenom({
    transport: "cosmos",
    environment: { CLAIRVEIL_COSMOS_DENOM: "  " },
  }), "uclair");
});

test("profile transport is normalized and unknown transports fail closed", () => {
  assert.equal(normalizeConfiguredTransport(" EVM "), "evm");
  assert.throws(
    () => normalizeConfiguredTransport("custom"),
    /must be cosmos or evm/,
  );
});

test("prover upstream permits cleartext only on exact loopback hostnames", () => {
  for (const endpoint of [
    "http://localhost:8080/tenant",
    "http://127.0.0.1:8080",
    "http://[::1]:8080/v1/prover/deposit",
    "https://prover.example.com/tenant",
  ]) {
    assert.doesNotThrow(() => assertSecureProverUpstreamUrl(endpoint));
  }

  for (const endpoint of [
    "http://prover.example.com",
    "http://localhost.example.com",
    "http://127.0.0.2",
    "http://[::ffff:127.0.0.1]",
    "ftp://localhost/prover",
  ]) {
    assert.throws(
      () => assertSecureProverUpstreamUrl(endpoint, "TEST_PROVER_URL"),
      /TEST_PROVER_URL must use HTTPS unless its host is localhost, 127\.0\.0\.1, or \[::1\]/,
    );
  }
  assert.equal(assertSecureProverUpstreamUrl(""), "");
  assert.throws(
    () => assertSecureProverUpstreamUrl("not a URL", "TEST_PROVER_URL"),
    /TEST_PROVER_URL must be a valid HTTP\(S\) URL/,
  );
});

test("prover upstream rejects URL credentials, query, and fragment without echoing them", () => {
  const canary = "CANARY_PROVER_SECRET";
  const endpoints = [
    `https://user:${canary}@prover.example.com/tenant`,
    "https://@prover.example.com/tenant",
    `https://prover.example.com/tenant?token=${canary}`,
    "https://prover.example.com/tenant?",
    `https://prover.example.com/tenant#${canary}`,
    "https://prover.example.com/tenant#",
    `http://user:${canary}@127.0.0.1:8080/tenant`,
    `http://localhost:8080/tenant?token=${canary}`,
    `http://[::1]:8080/tenant#${canary}`,
  ];
  for (const endpoint of endpoints) {
    assert.throws(
      () => assertSecureProverUpstreamUrl(endpoint, "TEST_PROVER_URL"),
      error => error.message === "TEST_PROVER_URL must not include URL userinfo, query, or fragment"
        && !error.message.includes(canary),
      endpoint,
    );
  }

  assert.equal(
    assertSecureProverUpstreamUrl("https://prover.example.com/tenant@v1"),
    "https://prover.example.com/tenant@v1",
  );
});

test("prover upstream rejects noncanonical authority syntax that URL parsing normalizes", () => {
  const endpoints = [
    "https:/@prover.example/tenant",
    "https:///@prover.example/tenant",
    "https:////@prover.example/tenant",
    "http:/@localhost:8080/tenant",
  ];
  for (const endpoint of endpoints) {
    assert.throws(
      () => assertSecureProverUpstreamUrl(endpoint, "TEST_PROVER_URL"),
      { message: "TEST_PROVER_URL must use canonical HTTP(S) URL syntax" },
      endpoint,
    );
  }
});
