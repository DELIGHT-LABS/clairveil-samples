import {
  canonicalAssetDenomV1,
  canonicalAssetIDHexV1,
  normalizeAssetRegistryEntryV1
} from "clairveiljs/asset-registry";

function nestedNoteAssetIDHex(note) {
  const value = note?.note?.assetID ?? note?.note?.asset_id;
  if (value === undefined || value === null || value === "") return "";
  try {
    const parsed = typeof value === "bigint" ? value : BigInt(String(value));
    if (parsed <= 0n) throw new Error("note asset ID must be positive");
    return canonicalAssetIDHexV1(parsed.toString(16).padStart(64, "0"));
  } catch (error) {
    throw new Error(`note asset ID is invalid: ${error.message}`);
  }
}

export function noteAssetIDHex(note) {
  const supplied = note?.asset_id_hex ?? note?.assetIdHex;
  const topLevel = supplied === undefined || supplied === null || supplied === ""
    ? ""
    : canonicalAssetIDHexV1(String(supplied));
  const nested = nestedNoteAssetIDHex(note);
  if (!topLevel && !nested) throw new Error("note asset_id_hex is required");
  if (topLevel && nested && topLevel !== nested) {
    throw new Error("note asset_id_hex does not match NoteV1 assetID");
  }
  return topLevel || nested;
}

function assetResolutionError(error) {
  const wrapped = new Error(`AssetRegistryV1 could not resolve the note inventory: ${error.message}`);
  wrapped.code = "ASSET_REGISTRY_RESOLUTION_FAILED";
  wrapped.cause = error;
  return wrapped;
}

export async function resolveNoteAssetDenoms(notes, resolveAssetByID) {
  try {
    if (!Array.isArray(notes)) throw new Error("note inventory must be an array");
    const assetIDs = [...new Set(notes.map(noteAssetIDHex))];
    if (assetIDs.length && typeof resolveAssetByID !== "function") {
      throw new Error("AssetRegistryV1 reverse resolver is required");
    }
    const entries = await Promise.all(assetIDs.map(async assetIDHex => {
      const asset = normalizeAssetRegistryEntryV1(
        await resolveAssetByID(assetIDHex),
        { asset_id_hex: assetIDHex }
      );
      return [assetIDHex, asset.canonical_denom];
    }));
    return new Map(entries);
  } catch (error) {
    if (error?.code === "ASSET_REGISTRY_RESOLUTION_FAILED") throw error;
    throw assetResolutionError(error instanceof Error ? error : new Error(String(error)));
  }
}

export function resolvedNoteAssetDenom(note, assetDenoms) {
  if (!(assetDenoms instanceof Map)) throw new Error("resolved note asset map is required");
  const assetIDHex = noteAssetIDHex(note);
  const denom = assetDenoms.get(assetIDHex);
  if (!denom) throw new Error(`note asset ${assetIDHex} is unresolved`);
  return denom;
}

export function notesForResolvedDenom(notes, assetDenoms, denom) {
  const canonicalDenom = canonicalAssetDenomV1(denom);
  return (notes || []).filter(note => resolvedNoteAssetDenom(note, assetDenoms) === canonicalDenom);
}
