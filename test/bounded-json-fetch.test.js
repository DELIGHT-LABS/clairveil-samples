import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultBoundedJsonMaxBytes,
  defaultBoundedJsonTimeoutMs,
  fetchBoundedJson
} from "../public/bounded-json-fetch.js";

const endpoint = "https://rpc.example.com/status";

function jsonResponse(body, init = {}) {
  const response = new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {})
    }
  });
  Object.defineProperty(response, "url", { value: init.url || endpoint });
  return response;
}

test("bounded JSON fetch returns a direct valid JSON response", async () => {
  assert.equal(defaultBoundedJsonTimeoutMs, 30_000);
  assert.equal(defaultBoundedJsonMaxBytes, 1024 * 1024);
  const value = await fetchBoundedJson(endpoint, {
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Accept, "application/json");
      return jsonResponse({ height: "7" });
    },
    timeoutMs: 100,
    maxBytes: 1024,
    label: "Latest block time query"
  });
  assert.deepEqual(value, { height: "7" });
});

test("bounded JSON errors expose validated response evidence only when requested", async () => {
  const body = { checkTxRejected: true, txCode: 5 };
  const fetchImpl = async () => jsonResponse(body, { status: 400 });
  await assert.rejects(fetchBoundedJson(endpoint, { fetchImpl }), error =>
    /HTTP 400/.test(error.message) && error.responseBody === undefined);
  await assert.rejects(fetchBoundedJson(endpoint, { fetchImpl, includeErrorBody: true }), error =>
    error.httpStatus === 400 && assert.deepEqual(error.responseBody, body) === undefined);
});

test("error response evidence remains subject to URL, type, byte and time bounds", async () => {
  for (const init of [
    { url: 'https://other.example.com/error' },
    { headers: { 'content-type': 'text/plain' } },
    { headers: { 'content-length': '2048' } }
  ]) {
    await assert.rejects(fetchBoundedJson(endpoint, { includeErrorBody: true, maxBytes: 32,
      fetchImpl: async () => jsonResponse({ checkTxRejected: true }, { status: 400, ...init }) }), error => error.responseBody === undefined);
  }
  for (const body of ['{', JSON.stringify({ value: 'x'.repeat(64) }), new ReadableStream({ start() {} })]) {
    await assert.rejects(fetchBoundedJson(endpoint, { includeErrorBody: true, maxBytes: 32, timeoutMs: 20,
      fetchImpl: async () => {
        const response = new Response(body, { status: 400, headers: { 'content-type': 'application/json' } });
        Object.defineProperty(response, 'url', { value: endpoint }); return response;
      } }), error => error.responseBody === undefined);
  }
});

test("bounded JSON fetch times out stalled headers and stalled bodies", async () => {
  await assert.rejects(
    () => fetchBoundedJson(endpoint, {
      fetchImpl: () => new Promise(() => {}),
      timeoutMs: 5,
      maxBytes: 1024,
      label: "Latest block time query"
    }),
    error => error?.name === "TimeoutError" && error?.code === "BOUNDED_JSON_TIMEOUT"
  );

  const stalledBody = new ReadableStream({ start() {} });
  await assert.rejects(
    () => fetchBoundedJson(endpoint, {
      fetchImpl: async () => {
        const response = new Response(stalledBody, {
          headers: { "content-type": "application/json" }
        });
        Object.defineProperty(response, "url", { value: endpoint });
        return response;
      },
      timeoutMs: 5,
      maxBytes: 1024,
      label: "Latest block time query"
    }),
    error => error?.name === "TimeoutError" && error?.code === "BOUNDED_JSON_TIMEOUT"
  );
});

test("bounded JSON fetch preserves caller cancellation", async () => {
  const controller = new AbortController();
  const pending = fetchBoundedJson(endpoint, {
    fetchImpl: () => new Promise(() => {}),
    signal: controller.signal,
    timeoutMs: 100,
    maxBytes: 1024
  });
  controller.abort();
  await assert.rejects(pending, error => error?.name === "AbortError");
});

test("bounded JSON fetch rejects declared and streamed oversized responses", async () => {
  await assert.rejects(
    () => fetchBoundedJson(endpoint, {
      fetchImpl: async () => jsonResponse({ ok: true }, {
        headers: { "content-length": "2048" }
      }),
      timeoutMs: 100,
      maxBytes: 32,
      label: "Latest block time query"
    }),
    /response exceeds 32 bytes/
  );

  const oversized = new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode("{\"value\":\""));
      stream.enqueue(new Uint8Array(64));
      stream.enqueue(new TextEncoder().encode("\"}"));
      stream.close();
    }
  });
  await assert.rejects(
    () => fetchBoundedJson(endpoint, {
      fetchImpl: async () => {
        const response = new Response(oversized, {
          headers: { "content-type": "application/json" }
        });
        Object.defineProperty(response, "url", { value: endpoint });
        return response;
      },
      timeoutMs: 100,
      maxBytes: 32,
      label: "Latest block time query"
    }),
    /response exceeds 32 bytes/
  );
});

test("bounded JSON fetch rejects non-JSON and final-URL mismatches", async () => {
  await assert.rejects(
    () => fetchBoundedJson(endpoint, {
      fetchImpl: async () => {
        const response = new Response("ok", { headers: { "content-type": "text/plain" } });
        Object.defineProperty(response, "url", { value: endpoint });
        return response;
      }
    }),
    /must return JSON/
  );
  await assert.rejects(
    () => fetchBoundedJson(endpoint, {
      fetchImpl: async () => jsonResponse({ ok: true }, { url: "https://other.example.com/latest" })
    }),
    /final URL does not match/
  );
});
