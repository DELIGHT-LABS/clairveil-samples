const supportedTransports = new Set(["cosmos", "evm"]);
const cleartextProverHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

function environmentValue(environment, name) {
  const value = environment?.[name];
  return value == null ? "" : String(value).trim();
}

export function normalizeConfiguredTransport(value = "cosmos") {
  const transport = String(value || "cosmos").trim().toLowerCase();
  if (!supportedTransports.has(transport)) {
    throw new Error("CLAIRVEIL_TRANSPORT must be cosmos or evm");
  }
  return transport;
}

export function assertSecureProverUpstreamUrl(value, label = "prover upstream") {
  const text = String(value || "").trim();
  if (!text) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL`);
  }
  let authority = "";
  if (url.protocol === "http:" || url.protocol === "https:") {
    const authorityMatch = text.match(/^https?:\/\/([^/?#\\]+)(?:[/?#]|$)/i);
    if (!authorityMatch) {
      throw new Error(`${label} must use canonical HTTP(S) URL syntax`);
    }
    authority = authorityMatch[1];
  }
  if (url.username
    || url.password
    || authority.includes("@")
    || text.includes("?")
    || text.includes("#")) {
    throw new Error(`${label} must not include URL userinfo, query, or fragment`);
  }
  if (url.protocol === "https:" && url.hostname) return url.toString();
  if (url.protocol === "http:" && cleartextProverHostnames.has(url.hostname.toLowerCase())) {
    return url.toString();
  }
  throw new Error(
    `${label} must use HTTPS unless its host is localhost, 127.0.0.1, or [::1]`,
  );
}

export function resolveProfileDenom({
  transport,
  environment = {},
  fallbackDenom = "uclair",
} = {}) {
  const normalizedTransport = normalizeConfiguredTransport(transport);
  const transportKeys = normalizedTransport === "evm"
    ? ["CLAIRVEIL_EVM_DENOM", "CLAIRVEIL_EVM_NATIVE_DENOM"]
    : ["CLAIRVEIL_COSMOS_DENOM"];
  for (const name of [...transportKeys, "CLAIRVEIL_DENOM"]) {
    const value = environmentValue(environment, name);
    if (value) return value;
  }
  const fallback = String(fallbackDenom || "").trim();
  if (!fallback) throw new Error("profile denom fallback must not be empty");
  return fallback;
}
