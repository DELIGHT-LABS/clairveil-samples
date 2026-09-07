import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer, request as createHttpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { networkInterfaces } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import { validateClairveilWebClientConfig } from "clairveiljs/browser-dapp";

function validatedConfig(responseJson) {
  return validateClairveilWebClientConfig(responseJson);
}

async function freePort() {
  const server = createTcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

function lanIpv4Address() {
  return Object.values(networkInterfaces())
    .flat()
    .find(entry => entry && !entry.internal && (entry.family === "IPv4" || entry.family === 4))
    ?.address || "";
}

async function startDummyProver(responseBody = null) {
  const calls = [];
  const defaultResponseJson = {
    version: "v2",
    proof: {
      version: "v2",
      proof_hex: "00",
      payload_hash: "11".repeat(32),
    },
  };
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    calls.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization || "",
      body: Buffer.concat(chunks).toString("utf8")
    });
    const responseJson = typeof responseBody === "function"
      ? await responseBody(calls.at(-1))
      : responseBody ?? defaultResponseJson;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(responseJson));
  });
  const port = await freePort();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    calls,
    close: async () => {
      server.close();
      await once(server, "close");
    },
    url: `http://127.0.0.1:${port}`
  };
}

function canonicalEmptyGroth16ProofHex() {
  return [
    `40${"00".repeat(31)}`,
    `40${"00".repeat(63)}`,
    `40${"00".repeat(31)}`,
    "00000000",
    `40${"00".repeat(31)}`
  ].join("");
}

function canonicalDepositRequest() {
  return {
    version: "v1",
    payload: {
      version: "v1",
      receiver_spend_pubkey_hex: "3153c1da87e13085b53a042a4255416a3db2355fa64cadc79c757275eb04942a",
      receiver_view_pubkey_hex: "23e3b289fbe895815104c3a97bc2e205da0bdef460f5ad7297444d30a4bc1821",
      amount: "4242",
      asset_id_hex: "238d5f23e4d918d40b0982ce3aef16a75c4d1760193d1c3b30b9f5df681903ca",
      randomness_hex: "0000000000000000000000000000000000000000000000000000000000000017",
      note_commitment_hex: "13e2b840379164d2409f74121551dd22a5952e1a29857898939de91c7997118d",
    },
  };
}

async function startHttpFixture(handler) {
  const server = createHttpServer(handler);
  const port = await freePort();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections?.();
      await closed;
    },
  };
}

async function waitForJson(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const json = await response.json();
      return { response, json };
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error(`timed out waiting for ${url}`);
}

async function waitForCondition(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

function rawHttpRequest({ port, path, method = "GET", headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const request = createHttpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

test("malformed Host receives a bounded 400 without terminating the DApp server", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PUBLIC_DEPOSIT_PROOF_URL: ""
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/api/config`);
    const malformed = await rawHttpRequest({
      port,
      path: "/api/config",
      headers: { host: "[" }
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(malformed.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(malformed.body), { error: "invalid request target" });
    assert.equal(child.exitCode, null);

    const healthy = await waitForJson(`${baseUrl}/api/config`);
    assert.equal(healthy.response.status, 200);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    assert.equal(stderr.join("").trim(), "");
  }
});

test("noncanonical prover request targets return canonical 404 without upstream work", async () => {
  const prover = await startDummyProver();
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_PROVER_URL: prover.url,
      CLAIRVEIL_PUBLIC_PROVER_URL: prover.url,
      CLAIRVEIL_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PUBLIC_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PROVER_PROXY_ENABLED: "1",
      CLAIRVEIL_PROVER_PROXY_RATE_LIMIT_MAX: "100"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    await waitForJson(`http://127.0.0.1:${port}/api/config`);
    const aliases = [
      "/v1/prover/./transfer",
      "/v1/prover/%2e/transfer",
      "/v1/prover/x/../transfer",
      "/v1/prover/%2e%2e/transfer",
      "/x/%2e%2e/v1/prover/transfer",
      "/v1/prover\\transfer",
      "/v1/proofs/x/../batch-transfer",
      "/v1/prover%2Fdeposit",
      "/v1%2Fprover/deposit",
      "/%76%31/prover/deposit",
      "/v1/proofs%2Fbatch-transfer"
    ];
    for (const path of aliases) {
      const response = await rawHttpRequest({
        port,
        path,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      assert.equal(response.status, 404, path);
      assert.equal(response.headers["content-type"], "application/json", path);
      assert.equal(response.headers["cache-control"], "no-store", path);
      assert.equal(response.headers.location, undefined, path);
      assert.deepEqual(JSON.parse(response.body), {
        version: "v1",
        code: "not_found",
        message: "prover endpoint was not found",
        retryable: false
      }, path);
    }
    assert.equal(prover.calls.length, 0);

    const canonical = await rawHttpRequest({
      port,
      path: "/v1/prover/transfer",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(canonical.status, 200);
    assert.equal(prover.calls.length, 1);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await prover.close();
    assert.equal(stderr.join("").trim(), "");
  }
});

test("blank prover upstreams return canonical unavailable errors without terminating the server", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_DAPP_LOCAL_TEST_MODE: "1",
      CLAIRVEIL_PROVER_PROXY_ENABLED: "1",
      CLAIRVEIL_PROVER_URL: "   ",
      CLAIRVEIL_COSMOS_DEPOSIT_PROVER_URL: "",
      CLAIRVEIL_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PROVER_BEARER_TOKEN: "",
      CLAIRVEIL_PRIVACY_PROVER_BEARER_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/api/config`);
    for (const pathname of [
      "/v1/prover/deposit",
      "/v1/prover/deposit-legacy",
      "/v1/prover/transfer",
      "/v1/prover/withdraw",
      "/v1/proofs/batch-transfer",
    ]) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 503, pathname);
      assert.equal(response.headers.get("content-type"), "application/json");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), {
        version: "v1",
        code: "unavailable",
        message: "prover is unavailable",
        retryable: false,
      });
    }
    const unknown = await fetch(`${baseUrl}/v1/prover/unknown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, "not_found");
    assert.equal((await waitForJson(`${baseUrl}/api/config`)).response.status, 200);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    assert.equal(stderr.join("").trim(), "");
  }
});

test("blank legacy bearer alias falls back to the standard prover token", async () => {
  const prover = await startDummyProver();
  const cases = [
    { alias: "", standard: "STANDARD_TOKEN", expected: "Bearer STANDARD_TOKEN" },
    { alias: "   ", standard: "STANDARD_TOKEN", expected: "Bearer STANDARD_TOKEN" },
    { alias: "ALIAS_TOKEN", standard: "STANDARD_TOKEN", expected: "Bearer ALIAS_TOKEN" },
    { alias: "", standard: "", expected: "" },
  ];
  try {
    for (const entry of cases) {
      const port = await freePort();
      const child = spawn(process.execPath, ["server.js"], {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          PORT: String(port),
          CLAIRVEIL_DAPP_PORT: String(port),
          CLAIRVEIL_DAPP_LOCAL_TEST_MODE: "1",
          CLAIRVEIL_PROVER_PROXY_ENABLED: "1",
          CLAIRVEIL_PROVER_URL: prover.url,
          CLAIRVEIL_PUBLIC_PROVER_URL: "",
          CLAIRVEIL_COSMOS_DEPOSIT_PROVER_URL: "",
          CLAIRVEIL_DEPOSIT_PROOF_URL: "",
          CLAIRVEIL_PROVER_BEARER_TOKEN: entry.alias,
          CLAIRVEIL_PRIVACY_PROVER_BEARER_TOKEN: entry.standard,
          CLAIRVEIL_PROVER_PROXY_RATE_LIMIT_MAX: "100",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderr = [];
      child.stderr.on("data", chunk => stderr.push(String(chunk)));
      try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const exposed = await waitForJson(`${baseUrl}/api/config`);
        assert.equal(JSON.stringify(exposed.json).includes("STANDARD_TOKEN"), false);
        assert.equal(JSON.stringify(exposed.json).includes("ALIAS_TOKEN"), false);
        const response = await fetch(`${baseUrl}/v1/prover/transfer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: "v2", payload: {} }),
        });
        assert.equal(response.status, 200);
        assert.equal(prover.calls.at(-1).authorization, entry.expected);
      } finally {
        child.kill("SIGTERM");
        await once(child, "exit");
        assert.equal(stderr.join("").includes("STANDARD_TOKEN"), false);
        assert.equal(stderr.join("").includes("ALIAS_TOKEN"), false);
      }
    }
  } finally {
    await prover.close();
  }
});

test("DApp rejects every cleartext non-loopback prover upstream before listening", async () => {
  const cases = [
    "CLAIRVEIL_PROVER_URL",
    "CLAIRVEIL_COSMOS_DEPOSIT_PROVER_URL",
    "CLAIRVEIL_DEPOSIT_PROOF_URL",
  ];
  for (const name of cases) {
    const port = await freePort();
    const child = spawn(process.execPath, ["server.js"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        PORT: String(port),
        CLAIRVEIL_DAPP_PORT: String(port),
        CLAIRVEIL_DAPP_LOCAL_TEST_MODE: "1",
        CLAIRVEIL_PROVER_PROXY_ENABLED: "1",
        CLAIRVEIL_PROVER_BEARER_TOKEN: "CANARY_MUST_NOT_BE_SENT",
        CLAIRVEIL_PROVER_URL: "http://127.0.0.1:8080",
        CLAIRVEIL_COSMOS_DEPOSIT_PROVER_URL: "",
        CLAIRVEIL_DEPOSIT_PROOF_URL: "",
        [name]: "http://prover.remote.example/tenant",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    const [code] = await once(child, "exit");
    assert.notEqual(code, 0, name);
    assert.match(
      stderr,
      new RegExp(`${name} must use HTTPS unless its host is localhost, 127\\.0\\.0\\.1, or \\[::1\\]`),
    );
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/config`));
  }
});

test("DApp rejects unsafe URL components for every private prover upstream before listening", async () => {
  const canary = "CANARY_PROVER_SECRET";
  const cases = [
    ["CLAIRVEIL_PROVER_URL", `https://user:${canary}@prover.example/tenant`],
    ["CLAIRVEIL_COSMOS_DEPOSIT_PROVER_URL", `https://prover.example/tenant?token=${canary}`],
    ["CLAIRVEIL_DEPOSIT_PROOF_URL", `https://prover.example/tenant#${canary}`],
  ];
  for (const [name, endpoint] of cases) {
    const port = await freePort();
    const child = spawn(process.execPath, ["server.js"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        PORT: String(port),
        CLAIRVEIL_DAPP_PORT: String(port),
        CLAIRVEIL_PROVER_URL: "http://127.0.0.1:8080",
        CLAIRVEIL_COSMOS_DEPOSIT_PROVER_URL: "",
        CLAIRVEIL_DEPOSIT_PROOF_URL: "",
        [name]: endpoint,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    const [code] = await once(child, "exit");
    assert.notEqual(code, 0, name);
    assert.match(
      stderr,
      new RegExp(`${name} must not include URL userinfo, query, or fragment`),
    );
    assert.doesNotMatch(stderr, new RegExp(canary));
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/config`));
  }
});

test("DApp exposes config, health, and bundled frontend assets", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PUBLIC_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_COSMOS_REST_ENDPOINTS: "http://127.0.0.1:1317, http://127.0.0.1:2317"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const config = await waitForJson(`${baseUrl}/api/config`);
    assert.equal(config.response.status, 200);
    assert.equal(config.json.chainId.startsWith("clairveil-local-"), true);
    assert.equal("evmChainId" in config.json, false);
    assert.equal(config.json.activeChainProfileId, "clairveil-local");
    assert.equal(config.json.chainProfiles.length, 1);
    assert.equal(config.json.chainProfiles[0].id, "clairveil-local");
    assert.equal(config.json.chainProfiles[0].wallet, "keplr");
    assert.equal(config.json.chainProfiles.find(profile => profile.id === "evm-local"), undefined);
    assert.equal(config.json.chainProfiles.find(profile => profile.id === "clairveil-local").proverUrl, "http://127.0.0.1:8080");
    assert.deepEqual(config.json.chainProfiles[0].restEndpoints, [
      "http://127.0.0.1:1317",
      "http://127.0.0.1:2317"
    ]);
    assert.equal(config.json.keplrChainInfo.bech32Config.bech32PrefixAccAddr, "clair");
    assert.equal(config.json.schemaVersion, "clairveil-web-client-config-v1");
    assert.equal(config.json.serverFeatures.depositProof, true);
    assert.equal(config.json.serverFeatures.relayer, true);
    assert.equal(validatedConfig(config.json).activeProfile.id, "clairveil-local");

    const health = await waitForJson(`${baseUrl}/api/health`);
    assert.equal(health.response.status, 200);
    assert.equal(health.json.config.keplrChainInfo.chainId, config.json.chainId);
    assert.equal("evmChainId" in health.json.config, false);
    assert.ok(Array.isArray(health.json.errors));

    const appBundle = await fetch(`${baseUrl}/app.bundle.js`);
    assert.equal(appBundle.status, 200);
    assert.equal(appBundle.headers.get("x-content-type-options"), "nosniff");
    assert.equal(appBundle.headers.get("referrer-policy"), "no-referrer");
    assert.equal(appBundle.headers.get("cross-origin-opener-policy"), "same-origin");
    const csp = appBundle.headers.get("content-security-policy");
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /http:\/\/127\.0\.0\.1:26657/);
    assert.match(csp, /http:\/\/127\.0\.0\.1:1317/);
    assert.match(csp, /http:\/\/127\.0\.0\.1:2317/);
    assert.match(csp, /http:\/\/127\.0\.0\.1:8080/);
    assert.match(await appBundle.text(), /createClairveilBrowserDappClient/);

    const removedEventsProxy = await fetch(`${baseUrl}/api/events`);
    assert.equal(removedEventsProxy.status, 404);

    const removedAuditorProxy = await fetch(`${baseUrl}/api/auditor/transfers`);
    assert.equal(removedAuditorProxy.status, 404);

    const removedSdkStatic = await fetch(`${baseUrl}/sdk/clairveiljs/browser-public.js`);
    assert.equal(removedSdkStatic.status, 404);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    assert.equal(stderr.join("").trim(), "");
  }
});

test("health gateway bounds admission and aborts upstream work on timeout or disconnect", async () => {
  let upstreamRequests = 0;
  let upstreamClosed = 0;
  const upstream = await startHttpFixture((_req, res) => {
    upstreamRequests += 1;
    res.once("close", () => {
      upstreamClosed += 1;
    });
    // Intentionally never respond. The DApp must abort this request itself.
  });
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_RPC: upstream.url,
      CLAIRVEIL_REST: upstream.url,
      CLAIRVEIL_PUBLIC_RPC: "",
      CLAIRVEIL_PUBLIC_REST: "",
      CLAIRVEIL_COSMOS_RPC: "",
      CLAIRVEIL_COSMOS_REST: "",
      CLAIRVEIL_DAPP_UPSTREAM_TIMEOUT_MS: "75",
      CLAIRVEIL_DAPP_HEALTH_MAX_IN_FLIGHT: "1",
      CLAIRVEIL_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PUBLIC_DEPOSIT_PROOF_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/api/config`);
    const first = fetch(`${baseUrl}/api/health`);
    await waitForCondition(() => upstreamRequests >= 3);
    const rejected = await fetch(`${baseUrl}/api/health`);
    assert.equal(rejected.status, 503);
    assert.deepEqual(await rejected.json(), {
      error: "health request capacity is exhausted",
      code: "capacity_exceeded",
      retry_after_ms: 1000,
    });

    const timedOut = await first;
    assert.equal(timedOut.status, 200);
    const timedOutBody = await timedOut.json();
    assert.equal(timedOutBody.errors.length, 3);
    assert.equal(timedOutBody.errors.every(message => /timed out after 75ms/.test(message)), true);
    await waitForCondition(() => upstreamClosed >= 3);

    const abortController = new AbortController();
    const requestsBeforeAbort = upstreamRequests;
    const closesBeforeAbort = upstreamClosed;
    const aborted = fetch(`${baseUrl}/api/health`, { signal: abortController.signal });
    await waitForCondition(() => upstreamRequests >= requestsBeforeAbort + 3);
    abortController.abort();
    await assert.rejects(aborted, error => error?.name === "AbortError");
    await waitForCondition(() => upstreamClosed >= closesBeforeAbort + 3);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await upstream.close();
    assert.equal(stderr.join("").trim(), "");
  }
});

test("health gateway rejects oversized upstream JSON before parsing", async () => {
  const largeBody = JSON.stringify({ padding: "x".repeat(1024) });
  const upstream = await startHttpFixture((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(largeBody)),
    });
    res.end(largeBody);
  });
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_RPC: upstream.url,
      CLAIRVEIL_REST: upstream.url,
      CLAIRVEIL_PUBLIC_RPC: "",
      CLAIRVEIL_PUBLIC_REST: "",
      CLAIRVEIL_COSMOS_RPC: "",
      CLAIRVEIL_COSMOS_REST: "",
      CLAIRVEIL_DAPP_UPSTREAM_MAX_RESPONSE_BYTES: "128",
      CLAIRVEIL_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PUBLIC_DEPOSIT_PROOF_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/api/config`);
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.status, null);
    assert.equal(body.tree, null);
    assert.equal(body.audit, null);
    assert.equal(body.errors.length, 3);
    assert.equal(body.errors.every(message => /exceeds 128 byte limit/.test(message)), true);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await upstream.close();
    assert.equal(stderr.join("").trim(), "");
  }
});

test("local signer mutation routes require exact same-origin JSON requests", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_DAPP_HOST: "127.0.0.1",
      CLAIRVEIL_DAPP_LOCAL_TEST_MODE: "1",
      CLAIRVEIL_TRANSPORT: "cosmos",
      CLAIRVEIL_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PUBLIC_DEPOSIT_PROOF_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/api/config`);
    const path = "/api/faucet";

    const crossOrigin = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: "{}",
    });
    assert.equal(crossOrigin.status, 403);
    assert.match((await crossOrigin.json()).error, /exact same-origin/);

    const simpleCsrf = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: "https://attacker.example",
      },
      body: "{}",
    });
    assert.equal(simpleCsrf.status, 415);
    assert.match((await simpleCsrf.json()).error, /application\/json/);

    const missingOrigin = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(missingOrigin.status, 403);

    const sameOrigin = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        origin: baseUrl,
      },
      body: JSON.stringify({ amount: "not-a-coin" }),
    });
    assert.equal(sameOrigin.status, 400);
    assert.match((await sameOrigin.json()).error, /amount must look like/);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    assert.equal(stderr.join("").trim(), "");
  }
});

test("an explicit LAN bind keeps rewritten local browser endpoints in the CSP", async t => {
  const lanAddress = lanIpv4Address();
  if (!lanAddress) {
    t.skip("no LAN IPv4 address is available");
    return;
  }
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_DAPP_HOST: "0.0.0.0",
      CLAIRVEIL_DAPP_LOCAL_TEST_MODE: "1",
      CLAIRVEIL_TRANSPORT: "cosmos",
      CLAIRVEIL_RPC: "tcp://127.0.0.1:26657",
      CLAIRVEIL_REST: "http://127.0.0.1:1317",
      CLAIRVEIL_PUBLIC_RPC: "",
      CLAIRVEIL_PUBLIC_REST: "",
      CLAIRVEIL_PUBLIC_REST_ENDPOINTS: "",
      CLAIRVEIL_COSMOS_RPC: "",
      CLAIRVEIL_COSMOS_REST: "",
      CLAIRVEIL_COSMOS_REST_ENDPOINTS: "",
      CLAIRVEIL_PROVER_URL: "http://127.0.0.1:8080",
      CLAIRVEIL_PUBLIC_PROVER_URL: "",
      CLAIRVEIL_COSMOS_PROVER_URL: "",
      CLAIRVEIL_DEPOSIT_PROOF_URL: "http://127.0.0.1:8081/v1/prove",
      CLAIRVEIL_PUBLIC_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_COSMOS_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PROVER_PROXY_ENABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));
  try {
    await waitForJson(`http://127.0.0.1:${port}/api/config`);
    const response = await fetch(`http://${lanAddress}:${port}/app.bundle.js`);
    assert.equal(response.status, 200);
    const csp = response.headers.get("content-security-policy") || "";
    assert.ok(csp.includes(`http://${lanAddress}:26657`), csp);
    assert.ok(csp.includes(`http://${lanAddress}:1317`), csp);
    assert.equal(csp.includes(`http://${lanAddress}:8080`), false, csp);
    assert.ok(csp.includes(`http://${lanAddress}:${port}`), csp);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    assert.equal(stderr.join("").trim(), "");
  }
});

test("the bundled prover proxy remains loopback-only even when a legacy LAN opt-in is set", async t => {
  const lanAddress = lanIpv4Address();
  if (!lanAddress) {
    t.skip("no LAN IPv4 address is available");
    return;
  }
  const prover = await startDummyProver();
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_DAPP_HOST: "0.0.0.0",
      CLAIRVEIL_DAPP_LOCAL_TEST_MODE: "1",
      CLAIRVEIL_PROVER_URL: prover.url,
      CLAIRVEIL_PUBLIC_PROVER_URL: "",
      CLAIRVEIL_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PUBLIC_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PROVER_BEARER_TOKEN: "LAN_CANARY",
      CLAIRVEIL_PROVER_PROXY_ENABLED: "1",
      CLAIRVEIL_DAPP_ALLOW_LAN_PROVER: "1",
      CLAIRVEIL_PROVER_PROXY_RATE_LIMIT_MAX: "100",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const loopbackConfig = await waitForJson(`http://127.0.0.1:${port}/api/config`);
    assert.equal(loopbackConfig.json.serverFeatures.proverProxy, true);
    assert.equal(loopbackConfig.json.serverFeatures.depositProof, true);
    const loopbackHealth = await waitForJson(`http://127.0.0.1:${port}/api/health`);
    assert.deepEqual(loopbackHealth.json.config, loopbackConfig.json);
    const lanConfig = await waitForJson(`http://${lanAddress}:${port}/api/config`);
    assert.equal(lanConfig.json.serverFeatures.proverProxy, false);
    assert.equal(lanConfig.json.serverFeatures.depositProof, false);
    const lanHealth = await waitForJson(`http://${lanAddress}:${port}/api/health`);
    assert.deepEqual(lanHealth.json.config, lanConfig.json);
    const lanResponse = await fetch(`http://${lanAddress}:${port}/v1/prover/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(lanResponse.status, 401);
    assert.equal(lanResponse.headers.get("content-type"), "application/json");
    assert.equal(lanResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await lanResponse.json(), {
      version: "v1",
      code: "unauthorized",
      message: "prover authorization failed",
      retryable: false,
    });
    assert.equal(prover.calls.length, 0);

    const loopbackResponse = await fetch(`http://127.0.0.1:${port}/v1/prover/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(loopbackResponse.status, 200);
    assert.equal(loopbackResponse.headers.get("content-type"), "application/json");
    assert.equal(loopbackResponse.headers.get("cache-control"), "no-store");
    assert.equal(prover.calls.length, 1);
    assert.equal(prover.calls[0].authorization, "Bearer LAN_CANARY");
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await prover.close();
    assert.equal(stderr.join("").trim(), "");
  }
});

test("LAN config keeps an explicit HTTPS prover while hiding the local proxy capability", async t => {
  const lanAddress = lanIpv4Address();
  if (!lanAddress) {
    t.skip("no LAN IPv4 address is available");
    return;
  }
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_DAPP_HOST: "0.0.0.0",
      CLAIRVEIL_DAPP_LOCAL_TEST_MODE: "1",
      CLAIRVEIL_PROVER_URL: "http://127.0.0.1:8080",
      CLAIRVEIL_PUBLIC_PROVER_URL: "https://prover.example",
      CLAIRVEIL_COSMOS_PROVER_URL: "",
      CLAIRVEIL_COSMOS_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PROVER_PROXY_ENABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const lanConfig = await waitForJson(`http://${lanAddress}:${port}/api/config`);
    assert.equal(lanConfig.json.serverFeatures.proverProxy, false);
    assert.equal(lanConfig.json.serverFeatures.depositProof, true);
    assert.equal(lanConfig.json.chainProfiles[0].proverUrl, "https://prover.example");
    const lanHealth = await waitForJson(`http://${lanAddress}:${port}/api/health`);
    assert.deepEqual(lanHealth.json.config, lanConfig.json);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    assert.equal(stderr.join("").trim(), "");
  }
});

test("DApp exposes EVM profile only when EVM transport is active", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_TRANSPORT: "evm",
      CHAIN_ID: "evm-privacy-local-1",
      CLAIRVEIL_ACCOUNT_PREFIX: "evm",
      CLAIRVEIL_DENOM: "utoken",
      CLAIRVEIL_DISPLAY_DENOM: "TOKEN",
      CLAIRVEIL_EVM_PRIVACY_PRECOMPILE: "0x0000000000000000000000000000000000000808",
      CLAIRVEIL_EVM_DEPOSIT_MODE: "payable-exact-value",
      CLAIRVEIL_EVM_NATIVE_DENOM: "utoken",
      CLAIRVEIL_EVM_HOST_REST_ENDPOINTS: "http://127.0.0.1:1317, http://127.0.0.1:3317",
      CLAIRVEIL_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PUBLIC_DEPOSIT_PROOF_URL: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const config = await waitForJson(`${baseUrl}/api/config`);
    assert.equal(config.response.status, 200);
    assert.equal(config.json.transport, "evm");
    assert.equal(config.json.accountPrefix, "clair");
    assert.equal(config.json.evmChainId, "0x32f");
    assert.equal(config.json.activeChainProfileId, "evm-local");
    assert.equal(config.json.chainProfiles.length, 1);
    const evmProfile = config.json.chainProfiles[0];
    assert.equal(evmProfile.id, "evm-local");
    assert.equal(evmProfile.accountPrefix, "clair");
    assert.equal("hostAccountPrefix" in evmProfile, false);
    assert.equal(evmProfile.denom, "utoken");
    assert.equal(evmProfile.evmDepositMode, "payable-exact-value");
    assert.equal(evmProfile.evmNativeDenom, "utoken");
    assert.deepEqual(evmProfile.restEndpoints, [
      "http://127.0.0.1:1317",
      "http://127.0.0.1:3317"
    ]);
    assert.equal(validatedConfig(config.json).activeProfile.id, "evm-local");
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    assert.equal(stderr.join("").trim(), "");
  }
});

test("DApp proxies same-origin prover requests for browser SDK flows", async () => {
  const port = await freePort();
  const prover = await startDummyProver();
  const canonicalDepositProver = await startDummyProver(call => {
    const request = JSON.parse(call.body);
    return {
      version: "v1",
      proof: {
        version: "v1",
        proof_hex: canonicalEmptyGroth16ProofHex(),
        note_commitment_hex: request.payload.note_commitment_hex,
      },
    };
  });
  const depositProof = await startDummyProver({
    version: "v1",
    proof_hex: "aa",
    note_commitment_hex: "33".repeat(32),
  });
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_PROVER_URL: `${prover.url}/tenant/cosmos`,
      CLAIRVEIL_COSMOS_PROVER_URL: "",
      CLAIRVEIL_COSMOS_DEPOSIT_PROVER_URL: `${canonicalDepositProver.url}/tenant/deposit`,
      CLAIRVEIL_PUBLIC_PROVER_URL: "",
      CLAIRVEIL_DEPOSIT_PROOF_URL: `${depositProof.url}/exact-deposit-proof`,
      CLAIRVEIL_PROVER_BEARER_TOKEN: "test-token",
      CLAIRVEIL_PROVER_PROXY_ENABLED: "1",
      CLAIRVEIL_PROVER_PROXY_RATE_LIMIT_MAX: "3"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const config = await waitForJson(`${baseUrl}/api/config`);
    assert.equal(config.json.proverUrl, baseUrl);
    assert.equal(config.json.chainProfiles[0].proverUrl, baseUrl);
    assert.equal(config.json.serverFeatures.depositProof, true);
    assert.equal(config.json.chainProfiles[0].depositProofUrl, `${baseUrl}/v1/prover/deposit`);
    assert.equal(validatedConfig(config.json).activeProfile.depositProofUrl, `${baseUrl}/v1/prover/deposit`);
    assert.equal(JSON.stringify(config.json).includes(prover.url), false);
    assert.equal(JSON.stringify(config.json).includes(canonicalDepositProver.url), false);

    const response = await fetch(`${baseUrl}/v1/prover/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: "v1",
        payload: {
          memo: "browser-sdk-prover-proxy"
        }
      })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      version: "v2",
      proof: {
        version: "v2",
        proof_hex: "00",
        payload_hash: "11".repeat(32),
      },
    });
    assert.equal(prover.calls.length, 1);
    assert.equal(prover.calls[0].method, "POST");
    assert.equal(prover.calls[0].path, "/tenant/cosmos/v1/prover/transfer");
    assert.equal(prover.calls[0].authorization, "Bearer test-token");
    assert.match(prover.calls[0].body, /browser-sdk-prover-proxy/);

    const depositResponse = await fetch(`${baseUrl}/v1/prover/deposit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
      },
      body: JSON.stringify(canonicalDepositRequest()),
    });
    assert.equal(depositResponse.status, 200);
    assert.equal(depositResponse.headers.get("content-type"), "application/json");
    assert.equal(depositResponse.headers.get("cache-control"), "no-store");
    const canonicalDeposit = await depositResponse.json();
    assert.equal(canonicalDeposit.version, "v1");
    assert.equal(canonicalDeposit.proof.version, "v1");
    assert.equal(canonicalDeposit.proof.proof_hex.length, 328);
    assert.equal(
      canonicalDeposit.proof.note_commitment_hex,
      canonicalDepositRequest().payload.note_commitment_hex,
    );
    assert.equal(prover.calls.length, 1);
    assert.equal(canonicalDepositProver.calls.length, 1);
    assert.equal(canonicalDepositProver.calls[0].path, "/tenant/deposit/v1/prover/deposit");
    assert.equal(canonicalDepositProver.calls[0].authorization, "Bearer test-token");
    assert.equal(depositProof.calls.length, 0);

    const legacyDepositResponse = await fetch(`${baseUrl}/v1/prover/deposit-legacy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        note_json: "{}",
        note_commitment_hex: "33".repeat(32),
      })
    });
    assert.equal(legacyDepositResponse.status, 200);
    assert.equal(legacyDepositResponse.headers.get("content-type"), "application/json");
    assert.deepEqual(await legacyDepositResponse.json(), {
      version: "v1",
      proof_hex: "aa",
      note_commitment_hex: "33".repeat(32),
    });
    assert.equal(depositProof.calls.length, 1);
    assert.equal(depositProof.calls[0].path, "/exact-deposit-proof");
    assert.equal(depositProof.calls[0].authorization, "Bearer test-token");

    const callsBeforeCrossOrigin = prover.calls.length;
    const crossOrigin = await fetch(`${baseUrl}/v1/prover/transfer`, {
      method: "POST",
      headers: { origin: "https://untrusted.example" },
      body: new TextEncoder().encode("{}"),
    });
    assert.equal(crossOrigin.status, 401);
    assert.equal(crossOrigin.headers.get("content-type"), "application/json");
    assert.equal((await crossOrigin.json()).code, "unauthorized");
    assert.equal(prover.calls.length, callsBeforeCrossOrigin);

    const rateLimited = await fetch(`${baseUrl}/v1/prover/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "v2", payload: {} })
    });
    assert.equal(rateLimited.status, 429);
    assert.equal(rateLimited.headers.get("content-type"), "application/json");
    assert.deepEqual(await rateLimited.json(), {
      version: "v1",
      code: "busy",
      message: "prover is busy",
      retryable: true,
    });
    assert.equal(prover.calls.length, 1);

    const preflight = await fetch(`${baseUrl}/v1/prover/transfer`, {
      method: "OPTIONS",
      headers: { origin: "https://untrusted.example" }
    });
    assert.equal(preflight.status, 405);
    assert.equal(preflight.headers.get("allow"), "POST");
    assert.equal(preflight.headers.get("content-type"), "application/json");
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    assert.equal((await preflight.json()).code, "method_not_allowed");

    const getResponse = await fetch(`${baseUrl}/v1/prover/transfer`);
    assert.equal(getResponse.status, 405);
    assert.equal(getResponse.headers.get("allow"), "POST");
    assert.equal(getResponse.headers.get("content-type"), "application/json");
    const getJson = await getResponse.json();
    assert.equal(getJson.code, "method_not_allowed");
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await prover.close();
    await canonicalDepositProver.close();
    await depositProof.close();
    assert.equal(stderr.join("").trim(), "");
  }
});

test("canonical deposit proxy rejects commitment, proof-frame, and duplicate-key responses", async () => {
  let responseMode = "commitment-mismatch";
  const request = canonicalDepositRequest();
  const validProof = {
    version: "v1",
    note_commitment_hex: request.payload.note_commitment_hex,
    proof_hex: canonicalEmptyGroth16ProofHex(),
  };
  const upstream = await startHttpFixture(async (req, res) => {
    for await (const _chunk of req) {
      // Drain the canonical request before returning the selected response.
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (responseMode === "duplicate-key") {
      res.end(`{"version":"v1","version":"v1","proof":${JSON.stringify(validProof)}}`);
      return;
    }
    res.end(JSON.stringify({
      version: "v1",
      proof: responseMode === "commitment-mismatch"
        ? { ...validProof, note_commitment_hex: `${"00".repeat(31)}01` }
        : { ...validProof, proof_hex: "00".repeat(164) },
    }));
  });
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_PROVER_URL: upstream.url,
      CLAIRVEIL_PUBLIC_PROVER_URL: "",
      CLAIRVEIL_COSMOS_DEPOSIT_PROVER_URL: upstream.url,
      CLAIRVEIL_PROVER_PROXY_ENABLED: "1",
      CLAIRVEIL_PROVER_PROXY_RATE_LIMIT_MAX: "100",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/api/config`);
    for (const mode of ["commitment-mismatch", "invalid-proof", "duplicate-key"]) {
      responseMode = mode;
      const response = await fetch(`${baseUrl}/v1/prover/deposit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      assert.equal(response.status, 500, mode);
      assert.equal(response.headers.get("content-type"), "application/json", mode);
      assert.equal(response.headers.get("cache-control"), "no-store", mode);
      assert.deepEqual(await response.json(), {
        version: "v1",
        code: "proof_failed",
        message: "prover returned an invalid response",
        retryable: false,
      }, mode);
    }
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await upstream.close();
    assert.equal(stderr.join("").trim(), "");
  }
});

test("canonical prover proxy rejects duplicate JSON keys for every non-deposit proof route", async () => {
  const canary = "UPSTREAM_DUPLICATE_KEY_CANARY";
  const payloadHash = "11".repeat(32);
  const upstream = await startHttpFixture(async (req, res) => {
    for await (const _chunk of req) {
      // Drain the request before returning the route-specific duplicate-key response.
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/v1/prover/transfer") {
      res.end(`{"version":"${canary}","version":"v2","proof":{"version":"v2","payload_hash":"${payloadHash}","proof_hex":"00"}}`);
      return;
    }
    if (req.url === "/v1/prover/withdraw") {
      res.end(`{"version":"v2","proof":{"version":"${canary}","\\u0076ersion":"v2","payload_hash":"${payloadHash}","proof_hex":"00"}}`);
      return;
    }
    res.end(`{"version":"v1","proof":{"version":"${canary}"},"proof":{"version":"batch-transfer-proof-v1","request_payload_hash":"${payloadHash}","proof":"AA=="}}`);
  });
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_PROVER_URL: upstream.url,
      CLAIRVEIL_PUBLIC_PROVER_URL: "",
      CLAIRVEIL_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PUBLIC_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PROVER_PROXY_ENABLED: "1",
      CLAIRVEIL_PROVER_PROXY_RATE_LIMIT_MAX: "100",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/api/config`);
    for (const path of [
      "/v1/prover/transfer",
      "/v1/prover/withdraw",
      "/v1/proofs/batch-transfer",
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 500, path);
      assert.equal(response.headers.get("content-type"), "application/json", path);
      assert.equal(response.headers.get("cache-control"), "no-store", path);
      const body = await response.json();
      assert.deepEqual(body, {
        version: "v1",
        code: "proof_failed",
        message: "prover returned an invalid response",
        retryable: false,
      }, path);
      assert.equal(JSON.stringify(body).includes(canary), false, path);
    }
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await upstream.close();
    assert.equal(stderr.join("").trim(), "");
  }
});

test("local prover proxy preserves the canonical error, media, encoding, and body-limit contract", async () => {
  let upstreamStatus = 400;
  let dropConnection = false;
  const upstreamCalls = [];
  const upstream = await startHttpFixture(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamCalls.push({
      contentEncoding: req.headers["content-encoding"] || "",
      contentType: req.headers["content-type"] || "",
      body: Buffer.concat(chunks),
    });
    if (dropConnection) {
      req.socket.destroy();
      return;
    }
    res.writeHead(upstreamStatus, {
      "content-type": upstreamStatus === 200 ? "application/json" : "text/plain",
    });
    if (upstreamStatus === 200) {
      res.end(JSON.stringify({
        version: "v2",
        proof: {
          version: "v2",
          proof_hex: "00",
          payload_hash: "11".repeat(32),
        },
      }));
      return;
    }
    res.end("private upstream failure details");
  });
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_PROVER_URL: upstream.url,
      CLAIRVEIL_PUBLIC_PROVER_URL: upstream.url,
      CLAIRVEIL_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PUBLIC_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PROVER_PROXY_ENABLED: "1",
      CLAIRVEIL_PROVER_PROXY_MAX_REQUEST_BYTES: "1024",
      CLAIRVEIL_PROVER_PROXY_RATE_LIMIT_MAX: "100",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/api/config`);
    const mappings = [
      { upstreamStatus: 400, status: 400, code: "invalid_request", retryable: false },
      { upstreamStatus: 413, status: 413, code: "invalid_request", retryable: false },
      { upstreamStatus: 415, status: 415, code: "invalid_request", retryable: false },
      { upstreamStatus: 401, status: 401, code: "unauthorized", retryable: false },
      { upstreamStatus: 404, status: 404, code: "not_found", retryable: false },
      { upstreamStatus: 405, status: 405, code: "method_not_allowed", retryable: false },
      { upstreamStatus: 429, status: 429, code: "busy", retryable: true },
      { upstreamStatus: 500, status: 500, code: "proof_failed", retryable: false },
      { upstreamStatus: 503, status: 503, code: "unavailable", retryable: false },
      { upstreamStatus: 502, status: 503, code: "unavailable", retryable: false },
      { upstreamStatus: 201, status: 503, code: "unavailable", retryable: false },
    ];
    for (const mapping of mappings) {
      upstreamStatus = mapping.upstreamStatus;
      const response = await fetch(`${baseUrl}/v1/prover/transfer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, mapping.status);
      assert.equal(response.headers.get("content-type"), "application/json");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("allow"), mapping.status === 405 ? "POST" : null);
      const body = await response.json();
      assert.equal(body.version, "v1");
      assert.equal(body.code, mapping.code);
      assert.equal(body.retryable, mapping.retryable);
      assert.equal(JSON.stringify(body).includes("private upstream"), false);
    }

    const callsBeforeLocalRejections = upstreamCalls.length;
    for (const rejection of [
      { headers: { "content-type": "text/plain" }, status: 415 },
      { headers: { "content-type": "" }, status: 415 },
      {
        headers: { "content-type": "application/json", "content-encoding": "br" },
        status: 400,
      },
      {
        headers: { "content-type": "application/json", "content-encoding": "" },
        status: 400,
      },
    ]) {
      const response = await fetch(`${baseUrl}/v1/prover/transfer`, {
        method: "POST",
        headers: rejection.headers,
        body: "{}",
      });
      assert.equal(response.status, rejection.status);
      assert.equal(response.headers.get("content-type"), "application/json");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.json()).code, "invalid_request");
    }
    assert.equal(upstreamCalls.length, callsBeforeLocalRejections);

    const notFound = await fetch(`${baseUrl}/v1/prover/unknown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(notFound.status, 404);
    assert.equal(notFound.headers.get("content-type"), "application/json");
    assert.equal(notFound.headers.get("cache-control"), "no-store");
    assert.deepEqual(await notFound.json(), {
      version: "v1",
      code: "not_found",
      message: "prover endpoint was not found",
      retryable: false,
    });
    assert.equal(upstreamCalls.length, callsBeforeLocalRejections);

    const oversized = await fetch(`${baseUrl}/v1/prover/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.headers.get("content-type"), "application/json");
    assert.equal(oversized.headers.get("cache-control"), "no-store");
    assert.equal((await oversized.json()).code, "invalid_request");
    assert.equal(upstreamCalls.length, callsBeforeLocalRejections);

    const unsupportedEncoding = await fetch(`${baseUrl}/v1/prover/transfer`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "br",
      },
      body: "{}",
    });
    assert.equal(unsupportedEncoding.status, 400);
    assert.equal(unsupportedEncoding.headers.get("content-type"), "application/json");
    assert.equal(unsupportedEncoding.headers.get("cache-control"), "no-store");
    assert.equal((await unsupportedEncoding.json()).code, "invalid_request");
    assert.equal(upstreamCalls.length, callsBeforeLocalRejections);

    upstreamStatus = 200;
    const uncompressed = Buffer.from(JSON.stringify({ version: "v2", payload: {} }));
    const compressed = gzipSync(uncompressed);
    const compressedResponse = await fetch(`${baseUrl}/v1/prover/transfer`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-encoding": "gzip",
      },
      body: compressed,
    });
    assert.equal(compressedResponse.status, 200);
    assert.equal(compressedResponse.headers.get("content-type"), "application/json");
    assert.equal(compressedResponse.headers.get("cache-control"), "no-store");
    assert.equal(upstreamCalls.at(-1).contentEncoding, "gzip");
    assert.equal(upstreamCalls.at(-1).contentType, "application/json; charset=utf-8");
    assert.deepEqual(gunzipSync(upstreamCalls.at(-1).body), uncompressed);

    const callsBeforeDecompressedOverflow = upstreamCalls.length;
    const decompressedOverflow = gzipSync(Buffer.from(JSON.stringify({
      padding: "x".repeat(2048),
    })));
    assert.ok(decompressedOverflow.length < 1024);
    const decompressedOverflowResponse = await fetch(`${baseUrl}/v1/prover/transfer`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: decompressedOverflow,
    });
    assert.equal(decompressedOverflowResponse.status, 413);
    assert.equal(decompressedOverflowResponse.headers.get("content-type"), "application/json");
    assert.equal((await decompressedOverflowResponse.json()).code, "invalid_request");
    assert.equal(upstreamCalls.length, callsBeforeDecompressedOverflow);

    const malformedGzipResponse = await fetch(`${baseUrl}/v1/prover/transfer`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: new TextEncoder().encode("not-a-gzip-frame"),
    });
    assert.equal(malformedGzipResponse.status, 400);
    assert.equal(malformedGzipResponse.headers.get("content-type"), "application/json");
    assert.equal((await malformedGzipResponse.json()).code, "invalid_request");
    assert.equal(upstreamCalls.length, callsBeforeDecompressedOverflow);

    dropConnection = true;
    const unavailable = await fetch(`${baseUrl}/v1/prover/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("content-type"), "application/json");
    assert.equal(unavailable.headers.get("cache-control"), "no-store");
    assert.deepEqual(await unavailable.json(), {
      version: "v1",
      code: "unavailable",
      message: "prover is unavailable",
      retryable: false,
    });
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await upstream.close();
    assert.equal(stderr.join("").trim(), "");
  }
});

test("local prover proxy times out or cancels incomplete request bodies and releases capacity", async () => {
  const prover = await startDummyProver();
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_PROVER_URL: prover.url,
      CLAIRVEIL_PUBLIC_PROVER_URL: prover.url,
      CLAIRVEIL_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PUBLIC_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PROVER_PROXY_ENABLED: "1",
      CLAIRVEIL_PROVER_TIMEOUT_MS: "75",
      CLAIRVEIL_PROVER_PROXY_MAX_IN_FLIGHT: "1",
      CLAIRVEIL_PROVER_PROXY_RATE_LIMIT_MAX: "100",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  function startIncompletePost(url) {
    let request;
    const response = new Promise((resolveResponse, rejectResponse) => {
      request = createHttpRequest(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "1024",
        },
      }, responseMessage => {
        const chunks = [];
        responseMessage.on("data", chunk => chunks.push(chunk));
        responseMessage.on("end", () => resolveResponse({
          status: responseMessage.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      request.on("error", rejectResponse);
      request.write("{");
    });
    return { request, response };
  }

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/api/config`);

    const timedOutBody = startIncompletePost(`${baseUrl}/v1/prover/transfer`);
    const timedOutOutcome = timedOutBody.response.catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 25));
    const capacityRejected = await fetch(`${baseUrl}/v1/prover/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(capacityRejected.status, 429);
    assert.equal(capacityRejected.headers.get("content-type"), "application/json");
    assert.equal(capacityRejected.headers.get("cache-control"), "no-store");
    assert.deepEqual(await capacityRejected.json(), {
      version: "v1",
      code: "busy",
      message: "prover is busy",
      retryable: true,
    });

    const timeoutResponse = await timedOutOutcome;
    assert.equal(timeoutResponse instanceof Error, false);
    assert.equal(timeoutResponse.status, 503);
    assert.deepEqual(JSON.parse(timeoutResponse.body), {
      version: "v1",
      code: "unavailable",
      message: "prover request timed out",
      retryable: false,
    });
    timedOutBody.request.destroy();

    const afterTimeout = await fetch(`${baseUrl}/v1/prover/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(afterTimeout.status, 200);

    const disconnectedBody = startIncompletePost(`${baseUrl}/v1/prover/transfer`);
    const disconnectedOutcome = disconnectedBody.response.catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 25));
    disconnectedBody.request.destroy();
    assert.equal((await disconnectedOutcome) instanceof Error, true);
    await new Promise(resolve => setTimeout(resolve, 25));

    const afterDisconnect = await fetch(`${baseUrl}/v1/prover/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(afterDisconnect.status, 200);
    assert.equal(prover.calls.length, 2);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await prover.close();
    assert.equal(stderr.join("").trim(), "");
  }
});

test("local prover proxy aborts upstream work after the browser disconnects", async () => {
  let hang = true;
  let upstreamRequests = 0;
  let upstreamClosed = 0;
  const upstream = await startHttpFixture(async (req, res) => {
    for await (const _chunk of req) {
      // Drain the witness before simulating a long-running proof.
    }
    upstreamRequests += 1;
    res.once("close", () => {
      upstreamClosed += 1;
    });
    if (hang) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      version: "v2",
      proof: {
        version: "v2",
        proof_hex: "00",
        payload_hash: "11".repeat(32),
      },
    }));
  });
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_PROVER_URL: upstream.url,
      CLAIRVEIL_PUBLIC_PROVER_URL: "",
      CLAIRVEIL_PROVER_PROXY_ENABLED: "1",
      CLAIRVEIL_PROVER_PROXY_MAX_IN_FLIGHT: "1",
      CLAIRVEIL_PROVER_PROXY_RATE_LIMIT_MAX: "100",
      CLAIRVEIL_PROVER_TIMEOUT_MS: "2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/api/config`);
    let browserRequest;
    const browserOutcome = new Promise((resolve, reject) => {
      browserRequest = createHttpRequest(`${baseUrl}/v1/prover/transfer`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "2",
        },
      }, resolve);
      browserRequest.on("error", reject);
      browserRequest.end("{}");
    }).catch(error => error);

    await waitForCondition(() => upstreamRequests === 1);
    browserRequest.destroy(new Error("browser cancelled proof request"));
    assert.equal((await browserOutcome) instanceof Error, true);
    await waitForCondition(() => upstreamClosed === 1);

    hang = false;
    const afterDisconnect = await fetch(`${baseUrl}/v1/prover/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(afterDisconnect.status, 200);
    assert.equal(afterDisconnect.headers.get("content-type"), "application/json");
    assert.equal(afterDisconnect.headers.get("cache-control"), "no-store");
    assert.equal(upstreamRequests, 2);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await upstream.close();
    assert.equal(stderr.join("").trim(), "");
  }
});

test("local prover proxy rejects upstream redirects without forwarding the witness", async () => {
  let redirectedCalls = 0;
  const redirectedTarget = await startHttpFixture((_req, res) => {
    redirectedCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      version: "v2",
      proof: {
        version: "v2",
        payload_hash: "11".repeat(32),
        proof_hex: "00",
      },
    }));
  });
  const redirectingProver = await startHttpFixture((_req, res) => {
    res.writeHead(307, { location: `${redirectedTarget.url}/stolen-witness` });
    res.end();
  });
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_PROVER_URL: redirectingProver.url,
      CLAIRVEIL_PUBLIC_PROVER_URL: redirectingProver.url,
      CLAIRVEIL_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PUBLIC_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PROVER_PROXY_ENABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/api/config`);
    const response = await fetch(`${baseUrl}/v1/prover/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "v2", payload: { private: "witness" } }),
    });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      version: "v1",
      code: "proof_failed",
      message: "prover returned an invalid response",
      retryable: false,
    });
    assert.equal(redirectedCalls, 0);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await redirectingProver.close();
    await redirectedTarget.close();
    assert.equal(stderr.join("").trim(), "");
  }
});

test("local prover proxy bounds and validates responses and redacts upstream errors", async () => {
  const upstream = await startHttpFixture((req, res) => {
    if (req.url === "/v1/prover/transfer") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(JSON.stringify({ version: "v2", proof: {} }));
      return;
    }
    if (req.url === "/v1/prover/withdraw") {
      const body = JSON.stringify({ padding: "x".repeat(1024) });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      res.end(body);
      return;
    }
    if (req.url === "/v1/prover/deposit") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        version: "legacy",
        proof_hex: "00",
        note_commitment_hex: "11".repeat(32),
      }));
      return;
    }
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("private witness and prover internals must not escape");
  });
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_PROVER_URL: upstream.url,
      CLAIRVEIL_PUBLIC_PROVER_URL: upstream.url,
      CLAIRVEIL_DEPOSIT_PROOF_URL: `${upstream.url}/exact-deposit-proof`,
      CLAIRVEIL_PUBLIC_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PROVER_PROXY_ENABLED: "1",
      CLAIRVEIL_PROVER_PROXY_MAX_RESPONSE_BYTES: "256",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/api/config`);
    for (const path of [
      "/v1/prover/transfer",
      "/v1/prover/withdraw",
      "/v1/prover/deposit",
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: path === "/v1/prover/deposit"
          ? JSON.stringify(canonicalDepositRequest())
          : "{}",
      });
      assert.equal(response.status, 500, path);
      assert.equal(response.headers.get("content-type"), "application/json", path);
      assert.equal(response.headers.get("cache-control"), "no-store", path);
      const body = await response.json();
      assert.equal(body.code, "proof_failed", path);
      assert.equal(body.message, "prover returned an invalid response", path);
      assert.equal(JSON.stringify(body).includes("private witness"), false, path);
    }

    const upstreamFailure = await fetch(`${baseUrl}/v1/proofs/batch-transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(upstreamFailure.status, 500);
    const upstreamFailureBody = await upstreamFailure.json();
    assert.deepEqual(upstreamFailureBody, {
      version: "v1",
      code: "proof_failed",
      message: "prover failed to produce a proof",
      retryable: false,
    });
    assert.equal(JSON.stringify(upstreamFailureBody).includes("private witness"), false);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await upstream.close();
    assert.equal(stderr.join("").trim(), "");
  }
});

test("DApp disables local-only backend routes outside local test mode", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CLAIRVEIL_DAPP_PORT: String(port),
      CLAIRVEIL_DAPP_LOCAL_TEST_MODE: "0",
      CLAIRVEIL_DAPP_PUBLIC_ORIGIN: "https://app.public.example",
      CLAIRVEIL_RPC: "https://rpc.public.example",
      CLAIRVEIL_REST: "https://rest.public.example",
      CLAIRVEIL_PUBLIC_RPC: "https://rpc.public.example",
      CLAIRVEIL_PUBLIC_REST: "https://rest.public.example",
      CLAIRVEIL_PUBLIC_REST_ENDPOINTS: "",
      CLAIRVEIL_COSMOS_RPC: "",
      CLAIRVEIL_COSMOS_REST: "",
      CLAIRVEIL_COSMOS_REST_ENDPOINTS: "",
      CLAIRVEIL_PROVER_URL: "https://prover.public.example",
      CLAIRVEIL_PUBLIC_PROVER_URL: "https://prover.public.example",
      CLAIRVEIL_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PUBLIC_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_COSMOS_DEPOSIT_PROOF_URL: "",
      CLAIRVEIL_PROVER_BEARER_TOKEN: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const config = await waitForJson(`${baseUrl}/api/config`);
    assert.equal(config.response.status, 200);
    assert.equal(config.json.localTestMode, false);
    assert.equal(config.json.modeLabel, "Public Node DApp");
    assert.equal(config.json.serverFeatures.localSigners, false);
    assert.equal(config.json.serverFeatures.faucet, false);
    assert.equal(config.json.serverFeatures.relayer, false);
    assert.equal(config.json.serverFeatures.auditorAdmin, false);
    assert.equal(config.json.serverFeatures.proverProxy, false);
    assert.equal(config.json.localSignerHome, "");
    assert.equal("accounts" in config.json, false);

    const health = await waitForJson(`${baseUrl}/api/health`);
    assert.deepEqual(health.json.config, config.json);

    const disabledProverProxy = await fetch(`${baseUrl}/v1/prover/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "v2", payload: {} })
    });
    assert.equal(disabledProverProxy.status, 404);

    const localOnlyRoutes = [
      { path: "/api/local-signers/ensure", init: { method: "POST", body: "{}" } },
      { path: "/api/faucet", init: { method: "POST", body: "{}" } },
      { path: "/api/relayer/withdraw", init: { method: "POST", body: "{}" } },
      { path: "/api/auditor/test-scalar", init: { method: "GET" } },
      { path: "/api/auditor/decode", init: { method: "POST", body: "{}" } },
      { path: "/api/wallet/alice/show-address", init: { method: "GET" } },
      { path: "/api/wallet/alice/notes", init: { method: "GET" } },
      { path: "/api/deposit", init: { method: "POST", body: "{}" } }
    ];

    for (const route of localOnlyRoutes) {
      const response = await fetch(`${baseUrl}${route.path}`, {
        headers: { "content-type": "application/json" },
        ...route.init
      });
      assert.equal(response.status, 403, route.path);
      const json = await response.json();
      assert.match(json.error, /CLAIRVEIL_DAPP_LOCAL_TEST_MODE is off/);
    }

    const removedWalletFeatureRoutes = [
      { path: "/api/tx/keplr/bank-send/sign-doc", init: { method: "POST", body: "{}" } },
      { path: "/api/tx/keplr/privacy-deposit/sign-doc", init: { method: "POST", body: "{}" } },
      { path: "/api/tx/keplr/privacy-transfer/sign-doc", init: { method: "POST", body: "{}" } },
      { path: "/api/tx/keplr/privacy-withdraw/sign-doc", init: { method: "POST", body: "{}" } },
      { path: "/api/tx/evm/bank-send/transaction", init: { method: "POST", body: "{}" } },
      { path: "/api/tx/evm/privacy-deposit/transaction", init: { method: "POST", body: "{}" } },
      { path: "/api/tx/evm/privacy-transfer/transaction", init: { method: "POST", body: "{}" } },
      { path: "/api/tx/evm/privacy-withdraw/transaction", init: { method: "POST", body: "{}" } },
      { path: "/api/keplr/privacy/notes", init: { method: "POST", body: "{}" } },
      { path: "/api/keplr/privacy/disclosure/decode", init: { method: "POST", body: "{}" } }
    ];

    for (const route of removedWalletFeatureRoutes) {
      const response = await fetch(`${baseUrl}${route.path}`, {
        headers: { "content-type": "application/json" },
        ...route.init
      });
      assert.equal(response.status, 404, `${route.path} should be owned by browser ClairveilJS, not the demo server`);
    }
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    assert.equal(stderr.join("").trim(), "");
  }
});

test("public DApp mode rejects a missing origin and cleartext browser endpoint", async () => {
  const cases = [
    {
      overrides: { CLAIRVEIL_DAPP_PUBLIC_ORIGIN: "" },
      expected: /CLAIRVEIL_DAPP_PUBLIC_ORIGIN must be a valid HTTPS URL/,
    },
    {
      overrides: {
        CLAIRVEIL_DAPP_PUBLIC_ORIGIN: "https://app.public.example",
        CLAIRVEIL_PUBLIC_RPC: "http://rpc.public.example",
      },
      expected: /clairveil-local\.rpc must be a valid HTTPS URL/,
    },
    {
      overrides: {
        CLAIRVEIL_DAPP_PUBLIC_ORIGIN: "https://app.public.example",
        CLAIRVEIL_PROVER_PROXY_ENABLED: "1",
      },
      expected: /CLAIRVEIL_PROVER_PROXY_ENABLED is local-test-only/,
    },
    {
      overrides: {
        CLAIRVEIL_DAPP_PUBLIC_ORIGIN: "https://app.public.example",
        CLAIRVEIL_PRIVACY_PROVER_BEARER_TOKEN: "PUBLIC_SECRET_CANARY",
      },
      expected: /must not hold prover bearer credentials/,
    },
  ];
  for (const { overrides, expected } of cases) {
    const port = await freePort();
    const child = spawn(process.execPath, ["server.js"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        PORT: String(port),
        CLAIRVEIL_DAPP_PORT: String(port),
        CLAIRVEIL_DAPP_LOCAL_TEST_MODE: "0",
        CLAIRVEIL_RPC: "https://rpc.internal.example",
        CLAIRVEIL_REST: "https://rest.internal.example",
        CLAIRVEIL_PUBLIC_RPC: "https://rpc.public.example",
        CLAIRVEIL_PUBLIC_REST: "https://rest.public.example",
        CLAIRVEIL_PUBLIC_REST_ENDPOINTS: "",
        CLAIRVEIL_COSMOS_RPC: "",
        CLAIRVEIL_COSMOS_REST: "",
        CLAIRVEIL_COSMOS_REST_ENDPOINTS: "",
        CLAIRVEIL_PROVER_URL: "https://prover.internal.example",
        CLAIRVEIL_PUBLIC_PROVER_URL: "https://prover.public.example",
        CLAIRVEIL_DEPOSIT_PROOF_URL: "",
        CLAIRVEIL_PUBLIC_DEPOSIT_PROOF_URL: "",
        CLAIRVEIL_COSMOS_DEPOSIT_PROOF_URL: "",
        CLAIRVEIL_PROVER_BEARER_TOKEN: "",
        CLAIRVEIL_PRIVACY_PROVER_BEARER_TOKEN: "",
        ...overrides,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    const [code] = await once(child, "exit");
    assert.notEqual(code, 0);
    assert.match(stderr, expected);
    assert.equal(stderr.includes("PUBLIC_SECRET_CANARY"), false);
  }
});
