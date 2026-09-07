import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateClairveilWebClientConfig } from "clairveiljs/browser-dapp";
import {
  serverBackedDappConfigPath,
  staticDappConfigPath,
} from "../public/dapp-config.js";

const requiredEnvironment = [
  "CLAIRVEIL_WEBAPP_ORIGIN",
  "CLAIRVEIL_WEBAPP_CONFIG_URL",
];
const verifierProverBearerTokenEnvironment =
  "CLAIRVEIL_WEBAPP_PROVER_BEARER_TOKEN";
const verifierProverBearerOriginEnvironment =
  "CLAIRVEIL_WEBAPP_PROVER_BEARER_ORIGIN";
const deploymentResponseMaxBytes = 1 << 20;
const serverBackedInformationalConfigPath = "/api/config";

export function parseStrictJson(source) {
  const text = String(source);
  let index = 0;
  const fail = (message) => {
    throw new Error(`${message} at byte ${index}`);
  };
  const whitespace = () => {
    while (index < text.length && " \n\r\t".includes(text[index])) index += 1;
  };
  const string = () => {
    const start = index;
    if (text[index] !== "\"") fail("expected JSON string");
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === "\"") {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          fail("invalid JSON string");
        }
      }
      if (character === "\\") {
        index += 1;
        const escape = text[index];
        if (!'"\\/bfnrtu'.includes(escape || "")) fail("invalid JSON string escape");
        if (escape === "u") {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid JSON unicode escape");
          index += 4;
        }
      } else if (character.codePointAt(0) <= 0x1f) {
        fail("invalid JSON control character");
      }
      index += 1;
    }
    fail("unterminated JSON string");
  };
  const value = () => {
    whitespace();
    const character = text[index];
    if (character === "{") {
      index += 1;
      whitespace();
      const object = Object.create(null);
      const keys = new Set();
      if (text[index] === "}") {
        index += 1;
        return object;
      }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) fail("duplicate JSON object key");
        keys.add(key);
        whitespace();
        if (text[index] !== ":") fail("expected JSON object colon");
        index += 1;
        object[key] = value();
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return object;
        }
        if (text[index] !== ",") fail("expected JSON object comma");
        index += 1;
      }
    }
    if (character === "[") {
      index += 1;
      whitespace();
      const array = [];
      if (text[index] === "]") {
        index += 1;
        return array;
      }
      while (true) {
        array.push(value());
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return array;
        }
        if (text[index] !== ",") fail("expected JSON array comma");
        index += 1;
      }
    }
    if (character === "\"") return string();
    for (const [literal, result] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return result;
      }
    }
    const number = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!number) fail("expected JSON value");
    index += number[0].length;
    return Number(number[0]);
  };
  const parsed = value();
  whitespace();
  if (index !== text.length) fail("multiple JSON values are not allowed");
  return parsed;
}

function requiredValue(environment, name) {
  const value = String(environment[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function httpsUrlValue(value, label, { exactOrigin = false } = {}) {
  const text = String(value || "").trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  const hasQueryOrFragmentDelimiter = text.includes("?") || text.includes("#");
  if (exactOrigin
    && (hasQueryOrFragmentDelimiter || url.href !== `${url.origin}/`)) {
    throw new Error(`${label} must be an exact HTTPS origin`);
  }
  if (hasQueryOrFragmentDelimiter) {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  return url;
}

function httpsUrl(environment, name) {
  return httpsUrlValue(requiredValue(environment, name), name);
}

function exactHttpsOrigin(environment, name) {
  return httpsUrlValue(requiredValue(environment, name), name, { exactOrigin: true });
}

function verifierProverCredential(environment) {
  const token = String(environment[verifierProverBearerTokenEnvironment] || "").trim();
  const originValue = String(environment[verifierProverBearerOriginEnvironment] || "").trim();
  if (!token && !originValue) return null;
  if (!token || !originValue) {
    throw new Error(
      `${verifierProverBearerTokenEnvironment} and `
      + `${verifierProverBearerOriginEnvironment} must be set together`,
    );
  }
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error(`${verifierProverBearerTokenEnvironment} must be a valid bearer token`);
  }
  const url = httpsUrlValue(
    originValue,
    verifierProverBearerOriginEnvironment,
    { exactOrigin: true },
  );
  return Object.freeze({ origin: url.origin, token });
}

function endpoint(base, path = "") {
  return new URL(path.replace(/^\//, ""), `${base.toString().replace(/\/$/, "")}/`);
}

function headerIncludesMethod(value, method) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .includes(method.toUpperCase());
}

function headerIncludesHeader(value, header) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .includes(header.toLowerCase());
}

function cspDirective(csp, name) {
  const normalizedName = String(name || "").toLowerCase();
  return String(csp || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.split(/\s+/, 1)[0].toLowerCase() === normalizedName);
}

export function cspDirectiveSources(csp, name) {
  const directive = cspDirective(csp, name);
  if (directive === undefined) return [];
  return directive.split(/\s+/).slice(1);
}

export function connectSrcSources(csp) {
  return cspDirectiveSources(csp, "connect-src");
}

function assertExactHttpsOrigins(sources, directive, { allowSelf = false, allowNone = false } = {}) {
  for (const source of sources) {
    if (allowSelf && source === "'self'") continue;
    if (allowNone && source === "'none'") continue;
    let url;
    try {
      url = new URL(source);
    } catch {
      throw new Error(`WebApp CSP ${directive} must enumerate exact HTTPS origins`);
    }
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.hostname.includes("*") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error(`WebApp CSP ${directive} must enumerate exact HTTPS origins`);
    }
  }
}

export function assertRestrictiveConnectSrc(csp) {
  const sources = connectSrcSources(csp);
  if (!sources.length) {
    throw new Error("WebApp response is missing a connect-src CSP directive");
  }
  if (sources.includes("*")) {
    throw new Error("WebApp CSP connect-src must not allow *");
  }
  assertExactHttpsOrigins(sources, "connect-src", { allowSelf: true });
  return sources;
}

export function assertRestrictiveFrameAncestors(csp) {
  const sources = cspDirectiveSources(csp, "frame-ancestors");
  if (!sources.length) {
    throw new Error("WebApp response is missing a frame-ancestors CSP directive");
  }
  if (sources.includes("*")) {
    throw new Error("WebApp CSP frame-ancestors must not allow *");
  }
  assertExactHttpsOrigins(sources, "frame-ancestors", {
    allowSelf: true,
    allowNone: true,
  });
  return sources;
}

export function assertRestrictiveScriptSrc(csp) {
  const sources = cspDirectiveSources(csp, "script-src");
  if (!sources.length) {
    throw new Error("WebApp response is missing a script-src CSP directive");
  }
  if (sources.length !== 1 || sources[0] !== "'self'") {
    throw new Error("WebApp CSP script-src must allow only 'self'");
  }
  const elementDirective = cspDirective(csp, "script-src-elem");
  const elementSources = cspDirectiveSources(csp, "script-src-elem");
  if (elementDirective !== undefined && (elementSources.length !== 1 || elementSources[0] !== "'self'")) {
    throw new Error("WebApp CSP script-src-elem must allow only 'self'");
  }
  const attributeDirective = cspDirective(csp, "script-src-attr");
  const attributeSources = cspDirectiveSources(csp, "script-src-attr");
  if (attributeDirective !== undefined && (attributeSources.length !== 1 || attributeSources[0] !== "'none'")) {
    throw new Error("WebApp CSP script-src-attr must allow only 'none'");
  }
  return sources;
}

function cspAllowsConnectSource(sources, source, pageOrigin) {
  return (
    sources.includes(source) ||
    (source === pageOrigin && sources.includes("'self'"))
  );
}

export function validateDeployedWebAppConfig(config) {
  const resolved = config?.config ?? config;
  try {
    const validated = validateClairveilWebClientConfig(resolved);
    if (validated.serverFeatures?.batchTransfer !== false) {
      throw new Error(
        "Clairveil v0.3.1 WebApp requires serverFeatures.batchTransfer=false",
      );
    }
    return validated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`deployed WebApp config is invalid: ${message}`);
  }
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalJsonValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalJsonValue(value[key])]),
    );
  }
  return value;
}

function canonicalConfigJson(config) {
  return JSON.stringify(canonicalJsonValue(config));
}

function healthConfigPayload(payload) {
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || !Object.hasOwn(payload, "config")
    || !payload.config
    || typeof payload.config !== "object"
    || Array.isArray(payload.config)
  ) {
    throw new Error(
      `WebApp ${serverBackedDappConfigPath} must contain the browser config under config`,
    );
  }
  return payload.config;
}

function bareConfigPayload(payload, path) {
  if (
    payload
    && typeof payload === "object"
    && !Array.isArray(payload)
    && Object.hasOwn(payload, "config")
  ) {
    throw new Error(`WebApp ${path} must return the bare Web client config`);
  }
  return payload;
}

function assertDirectConfigResponse(response, expectedUrl) {
  if (response?.redirected === true) {
    throw new Error("WebApp config must not redirect");
  }
  const finalUrl = String(response?.url || "");
  if (!finalUrl) return;
  let actual;
  try {
    actual = new URL(finalUrl);
  } catch {
    throw new Error("WebApp config response URL is invalid");
  }
  if (actual.href !== expectedUrl.href) {
    throw new Error("WebApp config must be served directly from its configured same-origin URL");
  }
}

export function assertDirectEndpointResponse(response, expectedUrl, label = "deployment endpoint") {
  if (response?.redirected === true) {
    throw new Error(`${label} must not redirect`);
  }
  const finalUrl = String(response?.url || "");
  if (!finalUrl) {
    throw new Error(`${label} response URL is missing`);
  }
  let actual;
  try {
    actual = new URL(finalUrl);
  } catch {
    throw new Error(`${label} response URL is invalid`);
  }
  if (actual.href !== new URL(expectedUrl).href) {
    throw new Error(`${label} must be served directly from its configured URL`);
  }
}

function assertJsonConfigResponse(response) {
  const contentType = String(response?.headers?.get?.("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new Error("WebApp config must return Content-Type: application/json");
  }
}

function addEndpoint(endpoints, seen, endpointValue) {
  const { profileId, label, kind, url } = endpointValue;
  const parsed = httpsUrlValue(url, label);
  const key = `${profileId}:${kind}:${parsed.toString()}`;
  if (!seen.has(key)) {
    seen.add(key);
    endpoints.push({ ...endpointValue, profileId, label, kind, url: parsed });
  }
}

function deploymentEndpointsFromProfiles(profiles) {
  const endpoints = [];
  const seen = new Set();
  const ids = new Set();

  for (const profile of profiles) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error("deployed WebApp config contains an invalid profile");
    }
    const id = String(profile.id || "").trim();
    if (!id || ids.has(id)) {
      throw new Error("deployed WebApp config contains duplicate or missing profile IDs");
    }
    ids.add(id);
    if (!["cosmos", "evm"].includes(profile.transport)) {
      throw new Error(`${id}.transport must be cosmos or evm`);
    }

    addEndpoint(endpoints, seen, {
      label: `${id}.rest`,
      profileId: id,
      kind: "rest",
      url: profile.rest,
    });
    if (profile.restEndpoints !== undefined) {
      if (!Array.isArray(profile.restEndpoints) || !profile.restEndpoints.length) {
        throw new Error(`${id}.restEndpoints must be a non-empty array when configured`);
      }
      for (const [index, value] of profile.restEndpoints.entries()) {
        addEndpoint(endpoints, seen, {
          label: `${id}.restEndpoints[${index}]`,
          profileId: id,
          kind: "rest",
          url: value,
        });
      }
    }
    addEndpoint(endpoints, seen, {
      label: `${id}.rpc`,
      profileId: id,
      kind: "rpc",
      url: profile.rpc,
    });
    addEndpoint(endpoints, seen, {
      label: `${id}.proverUrl`,
      profileId: id,
      kind: "prover",
      transport: profile.transport,
      deriveCosmosDeposit: profile.transport === "cosmos"
        && profile.depositProofUrl === undefined,
      url: profile.proverUrl,
    });
    if (profile.depositProofUrl !== undefined) {
      addEndpoint(endpoints, seen, {
        label: `${id}.depositProofUrl`,
        profileId: id,
        kind: profile.transport === "cosmos"
          ? "cosmos-deposit-proof"
          : "evm-deposit-proof",
        transport: profile.transport,
        url: profile.depositProofUrl,
      });
    }

    if (profile.transport === "cosmos") {
      if (!profile.keplrChainInfo || typeof profile.keplrChainInfo !== "object") {
        throw new Error(`${id}.keplrChainInfo must be an object for a Cosmos profile`);
      }
      addEndpoint(endpoints, seen, {
        label: `${id}.keplrChainInfo.rpc`,
        profileId: id,
        kind: "rpc",
        url: profile.keplrChainInfo.rpc,
      });
      addEndpoint(endpoints, seen, {
        label: `${id}.keplrChainInfo.rest`,
        profileId: id,
        kind: "rest",
        url: profile.keplrChainInfo.rest,
      });
    }

    if (profile.transport === "evm") {
      addEndpoint(endpoints, seen, {
        label: `${id}.evmRpc`,
        profileId: id,
        kind: "evm-rpc",
        url: profile.evmRpc,
      });
    }
  }
  return endpoints;
}

export function deploymentEndpoints(config) {
  return deploymentEndpointsFromProfiles(
    validateDeployedWebAppConfig(config).chainProfiles,
  );
}

function responseContentLength(response) {
  const raw = response?.headers?.get?.("content-length");
  if (!raw || !/^(0|[1-9][0-9]*)$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

async function readBoundedResponseText(response, maxResponseBytes) {
  const declaredLength = responseContentLength(response);
  if (declaredLength !== null && declaredLength > maxResponseBytes) {
    throw new Error(`WebApp response exceeds ${maxResponseBytes} byte limit`);
  }
  if (!response?.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxResponseBytes) {
      throw new Error(`WebApp response exceeds ${maxResponseBytes} byte limit`);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxResponseBytes) {
        try {
          await reader.cancel();
        } catch {
          // The oversized response is already rejected; cancellation is best effort.
        }
        throw new Error(`WebApp response exceeds ${maxResponseBytes} byte limit`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function timedFetch(
  fetchImpl,
  url,
  options = {},
  { readBody = false, maxResponseBytes = deploymentResponseMaxBytes } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!readBody) return response;
    return {
      response,
      text: await readBoundedResponseText(response, maxResponseBytes),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function assertCanonicalProverErrorProbe({ response, text, label, authenticated = false }) {
  const contentType = String(response?.headers?.get?.("content-type") || "")
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new Error(`${label} must return exact Content-Type: application/json`);
  }
  if (String(response?.headers?.get?.("cache-control") || "").trim().toLowerCase() !== "no-store") {
    throw new Error(`${label} must return Cache-Control: no-store`);
  }
  const expectedCode = response.status === 400
    ? "invalid_request"
    : !authenticated && response.status === 401
      ? "unauthorized"
      : "";
  if (!expectedCode) {
    throw new Error(
      authenticated
        ? `${label} authenticated empty-request probe must return HTTP 400 invalid_request`
        : `${label} empty-request probe must return HTTP 400 invalid_request or HTTP 401 unauthorized`,
    );
  }
  let payload;
  try {
    payload = parseStrictJson(text);
  } catch {
    throw new Error(`${label} must return valid JSON without duplicate object keys`);
  }
  const keys = Object.keys(payload || {}).sort();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || keys.some((key) => !["code", "message", "retryable", "version"].includes(key))
    || payload.version !== "v1"
    || payload.code !== expectedCode
    || typeof payload.message !== "string"
    || !payload.message
    || (Object.hasOwn(payload, "retryable") && payload.retryable !== false)) {
    throw new Error(`${label} must return the canonical v1 ${expectedCode} envelope`);
  }
}

function assertJsonEndpointProbe({
  response,
  text,
  label,
  method,
  canonicalProver = false,
  authenticated = false,
}) {
  if (canonicalProver) {
    assertCanonicalProverErrorProbe({ response, text, label, authenticated });
    return;
  }
  const contentType = String(response?.headers?.get?.("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json" && !contentType.endsWith("+json")) {
    throw new Error(`${label} must return a bounded JSON response`);
  }
  if (method === "GET" && !response.ok) {
    throw new Error(`${label} GET probe failed with HTTP ${response.status}`);
  }
  if (method === "POST"
    && (response.status === 404 || response.status === 405 || response.status >= 500)) {
    throw new Error(`${label} POST route probe failed with HTTP ${response.status}`);
  }
  if (authenticated && response.status === 401) {
    throw new Error(`${label} rejected the verifier bearer credential`);
  }
  try {
    JSON.parse(text);
  } catch {
    throw new Error(`${label} must return valid JSON`);
  }
}

async function probeActualEndpoint({
  fetchImpl,
  label,
  url,
  origin,
  method,
  validateRoute = true,
  canonicalProver = false,
  bearerToken = "",
}) {
  const result = await timedFetch(fetchImpl, url, {
    method,
    redirect: "error",
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    },
    // This is intentionally an empty, non-sensitive probe. A provider may
    // reject its schema, but the configured route itself must exist and reply
    // with bounded JSON rather than an HTML fallback or proxy error.
    ...(method === "POST" ? { body: "{}" } : {}),
  }, { readBody: validateRoute });
  const response = validateRoute ? result.response : result;
  assertDirectEndpointResponse(response, url, label);
  if (validateRoute) {
    assertJsonEndpointProbe({
      response,
      text: result.text,
      label,
      method,
      canonicalProver,
      authenticated: Boolean(bearerToken),
    });
  }
  return response;
}

async function verifyActualCors({
  fetchImpl,
  label,
  url,
  origin,
  method,
  untrusted = false,
  canonicalProver = false,
  bearerToken = "",
}) {
  const response = await probeActualEndpoint({
    fetchImpl,
    label,
    url,
    origin,
    method,
    validateRoute: !untrusted,
    canonicalProver,
    bearerToken: untrusted ? "" : bearerToken,
  });
  const allowedOrigin = String(
    response.headers.get("access-control-allow-origin") || "",
  ).trim();
  if (untrusted) {
    if (allowedOrigin === origin || allowedOrigin === "*") {
      throw new Error(`${label} actual response must not allow an untrusted WebApp origin`);
    }
    return;
  }
  if (allowedOrigin !== origin) {
    throw new Error(`${label} actual response must allow only the exact WebApp origin`);
  }
}

async function verifySameOriginEndpoint({
  fetchImpl,
  label,
  url,
  origin,
  method,
  canonicalProver,
  bearerToken,
}) {
  await probeActualEndpoint({
    fetchImpl,
    label,
    url,
    origin,
    method,
    canonicalProver,
    bearerToken,
  });
}

async function verifyCors({
  fetchImpl,
  label,
  url,
  origin,
  method,
  canonicalProver,
  bearerToken,
}) {
  const requestedHeaders = ["content-type", ...(bearerToken ? ["authorization"] : [])];
  const response = await timedFetch(fetchImpl, url, {
    method: "OPTIONS",
    redirect: "error",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": method,
      "Access-Control-Request-Headers": requestedHeaders.join(", "),
    },
  });
  assertDirectEndpointResponse(response, url, label);
  if (!response.ok) {
    throw new Error(`${label} CORS preflight failed with HTTP ${response.status}`);
  }
  if (response.headers.get("access-control-allow-origin") !== origin) {
    throw new Error(`${label} must allow only the exact WebApp origin`);
  }
  if (!headerIncludesMethod(response.headers.get("access-control-allow-methods"), method)) {
    throw new Error(`${label} CORS preflight does not allow ${method}`);
  }
  if (!headerIncludesMethod(response.headers.get("access-control-allow-methods"), "OPTIONS")) {
    throw new Error(`${label} CORS preflight does not allow OPTIONS`);
  }
  if (!headerIncludesHeader(response.headers.get("access-control-allow-headers"), "content-type")) {
    throw new Error(`${label} CORS preflight does not allow Content-Type`);
  }
  if (bearerToken
    && !headerIncludesHeader(response.headers.get("access-control-allow-headers"), "authorization")) {
    throw new Error(`${label} CORS preflight does not allow Authorization`);
  }

  const allowedMethods = String(response.headers.get("access-control-allow-methods") || "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  if (allowedMethods.some((value) => !["GET", "POST", "OPTIONS"].includes(value))) {
    throw new Error(`${label} CORS preflight allows an unnecessary method`);
  }
  const allowedHeaders = String(response.headers.get("access-control-allow-headers") || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (allowedHeaders.some((value) => !["content-type", "authorization"].includes(value))) {
    throw new Error(`${label} CORS preflight allows an unnecessary request header`);
  }

  await verifyActualCors({
    fetchImpl,
    label,
    url,
    origin,
    method,
    canonicalProver,
    bearerToken,
  });

  const probeOrigin = "https://clairveil-cors-probe.invalid";
  const probe = await timedFetch(fetchImpl, url, {
    method: "OPTIONS",
    redirect: "error",
    headers: {
      Origin: probeOrigin,
      "Access-Control-Request-Method": method,
      "Access-Control-Request-Headers": requestedHeaders.join(", "),
    },
  });
  assertDirectEndpointResponse(probe, url, label);
  const probeAllowedOrigin = String(
    probe.headers.get("access-control-allow-origin") || "",
  ).trim();
  if (probeAllowedOrigin === probeOrigin || probeAllowedOrigin === "*") {
    throw new Error(`${label} must not allow an untrusted WebApp origin`);
  }
  await verifyActualCors({
    fetchImpl,
    label,
    url,
    origin: probeOrigin,
    method,
    untrusted: true,
    canonicalProver,
    bearerToken,
  });
}

function corsTargets(endpointValue) {
  if (endpointValue.kind === "rest") {
    return [
      {
        label: `${endpointValue.label} tree_state`,
        url: endpoint(endpointValue.url, "/clairveil/privacy/v1/tree_state"),
        method: "GET",
      },
      {
        label: `${endpointValue.label} privacy_scan`,
        url: endpoint(endpointValue.url, "/clairveil/privacy/v1/privacy_scan"),
        method: "POST",
      },
    ];
  }
  if (endpointValue.kind === "rpc") {
    return [
      {
        label: `${endpointValue.label} JSON-RPC`,
        url: endpointValue.url,
        method: "POST",
      },
      {
        label: `${endpointValue.label} status`,
        url: endpoint(endpointValue.url, "/status"),
        method: "GET",
      },
    ];
  }
  if (endpointValue.kind === "prover") {
    const targets = [
      {
        label: `${endpointValue.label} transfer`,
        url: endpoint(endpointValue.url, "/v1/prover/transfer"),
        method: "POST",
        canonicalProver: true,
        proverCredential: true,
      },
      {
        label: `${endpointValue.label} withdraw`,
        url: endpoint(endpointValue.url, "/v1/prover/withdraw"),
        method: "POST",
        canonicalProver: true,
        proverCredential: true,
      },
    ];
    if (endpointValue.transport === "cosmos" && endpointValue.deriveCosmosDeposit) {
      targets.push({
        label: `${endpointValue.label} deposit`,
        url: endpoint(endpointValue.url, "/v1/prover/deposit"),
        method: "POST",
        canonicalProver: true,
        proverCredential: true,
      });
    }
    return targets;
  }
  if (endpointValue.kind === "cosmos-deposit-proof") {
    return [{
      label: endpointValue.label,
      url: endpointValue.url,
      method: "POST",
      canonicalProver: true,
      proverCredential: true,
    }];
  }
  if (endpointValue.kind === "evm-deposit-proof") {
    return [{
      label: endpointValue.label,
      url: endpointValue.url,
      method: "POST",
      proverCredential: true,
    }];
  }
  return [{ label: endpointValue.label, url: endpointValue.url, method: "POST" }];
}

export async function verifyProductionDeployment({
  environment = process.env,
  fetchImpl = fetch,
} = {}) {
  for (const name of requiredEnvironment) requiredValue(environment, name);
  const proverCredential = verifierProverCredential(environment);

  const webApp = exactHttpsOrigin(environment, "CLAIRVEIL_WEBAPP_ORIGIN");
  const webAppConfig = httpsUrl(environment, "CLAIRVEIL_WEBAPP_CONFIG_URL");
  if (webAppConfig.origin !== webApp.origin) {
    throw new Error("CLAIRVEIL_WEBAPP_CONFIG_URL must be served from the final WebApp origin");
  }
  const webAppOrigin = webApp.origin;

  const webAppResponse = await timedFetch(fetchImpl, webApp, { redirect: "error" });
  if (!webAppResponse.ok) {
    throw new Error(`WebApp origin returned HTTP ${webAppResponse.status}`);
  }
  const csp = webAppResponse.headers.get("content-security-policy");
  const defaultSources = cspDirectiveSources(csp, "default-src");
  if (defaultSources.length !== 1 || defaultSources[0] !== "'self'") {
    throw new Error("WebApp CSP default-src must allow only 'self'");
  }
  assertRestrictiveFrameAncestors(csp);
  assertRestrictiveScriptSrc(csp);
  const configResult = await timedFetch(
    fetchImpl,
    webAppConfig,
    { redirect: "error" },
    { readBody: true },
  );
  const { response: configResponse, text: configText } = configResult;
  if (!configResponse.ok) {
    throw new Error(`WebApp config returned HTTP ${configResponse.status}`);
  }
  assertDirectConfigResponse(configResponse, webAppConfig);
  assertJsonConfigResponse(configResponse);
  let config;
  try {
    config = JSON.parse(configText);
  } catch {
    throw new Error("WebApp config must return JSON");
  }
  const expectedHealthUrl = new URL(serverBackedDappConfigPath, webApp);
  const requestedConfig = webAppConfig.href === expectedHealthUrl.href
    ? healthConfigPayload(config)
    : bareConfigPayload(config, webAppConfig.pathname);
  const resolvedConfig = validateDeployedWebAppConfig(requestedConfig);
  const browserConfigPath = resolvedConfig?.serverBacked === true
    ? serverBackedDappConfigPath
    : resolvedConfig?.serverBacked === false
      ? staticDappConfigPath
      : "";
  if (!browserConfigPath) {
    throw new Error("deployed WebApp config must declare serverBacked as true or false");
  }
  const browserConfigUrl = new URL(browserConfigPath, webApp);
  if (webAppConfig.href !== browserConfigUrl.href) {
    throw new Error(
      `WebApp verification must use the browser-loaded ${browserConfigPath} response`,
    );
  }
  if (resolvedConfig.serverBacked === true) {
    const informationalConfigUrl = new URL(serverBackedInformationalConfigPath, webApp);
    const informationalResult = await timedFetch(
      fetchImpl,
      informationalConfigUrl,
      { redirect: "error" },
      { readBody: true },
    );
    const {
      response: informationalResponse,
      text: informationalText,
    } = informationalResult;
    if (!informationalResponse.ok) {
      throw new Error(
        `WebApp ${serverBackedInformationalConfigPath} returned HTTP ${informationalResponse.status}`,
      );
    }
    assertDirectConfigResponse(informationalResponse, informationalConfigUrl);
    assertJsonConfigResponse(informationalResponse);
    let informationalConfig;
    try {
      informationalConfig = JSON.parse(informationalText);
    } catch {
      throw new Error(`WebApp ${serverBackedInformationalConfigPath} must return JSON`);
    }
    const informationalConfigPayload = bareConfigPayload(
      informationalConfig,
      serverBackedInformationalConfigPath,
    );
    validateDeployedWebAppConfig(informationalConfigPayload);
    if (
      canonicalConfigJson(requestedConfig)
      !== canonicalConfigJson(informationalConfigPayload)
    ) {
      throw new Error(
        `WebApp ${serverBackedDappConfigPath}.config must match ${serverBackedInformationalConfigPath}`,
      );
    }
  }
  const endpoints = deploymentEndpointsFromProfiles(resolvedConfig.chainProfiles);
  if (proverCredential && !endpoints.some((endpointValue) =>
    ["prover", "cosmos-deposit-proof", "evm-deposit-proof"].includes(endpointValue.kind)
      && endpointValue.url.origin === proverCredential.origin)) {
    throw new Error(
      `${verifierProverBearerOriginEnvironment} does not match a configured prover origin`,
    );
  }
  const connectSources = assertRestrictiveConnectSrc(csp);
  for (const source of new Set(endpoints.map((endpointValue) => endpointValue.url.origin))) {
    if (!cspAllowsConnectSource(connectSources, source, webAppOrigin)) {
      throw new Error(`WebApp CSP connect-src does not allow ${source}`);
    }
  }
  for (const [header, expected] of [
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "no-referrer"],
    ["cross-origin-opener-policy", "same-origin"],
  ]) {
    if (webAppResponse.headers.get(header) !== expected) {
      throw new Error(`WebApp response must set ${header}: ${expected}`);
    }
  }

  for (const endpointValue of endpoints) {
    for (const target of corsTargets(endpointValue)) {
      const bearerToken = target.proverCredential === true
        && target.url.origin === proverCredential?.origin
        ? proverCredential.token
        : "";
      const verifier = target.url.origin === webAppOrigin
        ? verifySameOriginEndpoint
        : verifyCors;
      await verifier({
          fetchImpl,
          label: target.label,
          url: target.url,
          origin: webAppOrigin,
          method: target.method,
          canonicalProver: target.canonicalProver === true,
          bearerToken,
        });
    }
  }
  return {
    profileCount: new Set(endpoints.map((endpointValue) => endpointValue.profileId)).size,
    endpointCount: endpoints.length,
  };
}

async function main() {
  const result = await verifyProductionDeployment();
  console.log(`Production WebApp CSP and endpoint CORS verification passed for ${result.profileCount} profile(s) and ${result.endpointCount} endpoint(s).`);
  console.log("Before release, complete the documented Keplr/MetaMask wallet-extension flow against these same origins.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
