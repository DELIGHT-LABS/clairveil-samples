import assert from "node:assert/strict";
import test from "node:test";
import { computeAssetIdV1 } from "clairveiljs/core";
import {
  noteAssetIDHex,
  notesForResolvedDenom,
  resolveNoteAssetDenoms,
  resolvedNoteAssetDenom
} from "../public/note-asset-inventory.js";

function assetIDHex(denom) {
  return computeAssetIdV1(denom).toString(16).padStart(64, "0");
}

function registryAsset(denom, assetID = assetIDHex(denom)) {
  return {
    canonical_denom: denom,
    asset_id: Uint8Array.from(Buffer.from(assetID, "hex")),
    asset_id_hex: assetID
  };
}

function storedNote(amount, denom) {
  const assetID = assetIDHex(denom);
  return {
    amount: String(amount),
    asset_id_hex: assetID,
    note: { assetID: BigInt(`0x${assetID}`).toString() }
  };
}

test("mixed-asset notes resolve once per asset and active totals exclude foreign notes", async () => {
  const notes = [
    storedNote(7, "aokrw"),
    storedNote(11, "uatom"),
    storedNote(0, "uatom"),
    storedNote(2, "aokrw")
  ];
  const calls = [];
  const denoms = await resolveNoteAssetDenoms(notes, async assetID => {
    calls.push(assetID);
    return assetID === assetIDHex("aokrw")
      ? registryAsset("aokrw")
      : registryAsset("uatom");
  });

  assert.deepEqual(calls.sort(), [assetIDHex("aokrw"), assetIDHex("uatom")].sort());
  assert.equal(resolvedNoteAssetDenom(notes[0], denoms), "aokrw");
  assert.equal(resolvedNoteAssetDenom(notes[1], denoms), "uatom");
  const activeNotes = notesForResolvedDenom(notes, denoms, "aokrw");
  assert.equal(activeNotes.reduce((sum, note) => sum + BigInt(note.amount), 0n), 9n);
  assert.deepEqual(activeNotes.map(note => note.amount), ["7", "2"]);
});

test("note asset identity rejects missing and disagreeing projections", () => {
  assert.throws(() => noteAssetIDHex({ amount: "1" }), /asset_id_hex is required/);
  assert.throws(() => noteAssetIDHex({
    ...storedNote(1, "aokrw"),
    note: { assetID: BigInt(`0x${assetIDHex("uatom")}`).toString() }
  }), /does not match/);
});

test("asset resolution fails closed on unknown, mismatched, and malformed registry entries", async () => {
  const notes = [storedNote(1, "aokrw")];
  await assert.rejects(
    resolveNoteAssetDenoms(notes, async () => {
      throw new Error("not found");
    }),
    error => error?.code === "ASSET_REGISTRY_RESOLUTION_FAILED" && /not found/.test(error.message)
  );
  await assert.rejects(
    resolveNoteAssetDenoms(notes, async () => registryAsset("uatom")),
    error => error?.code === "ASSET_REGISTRY_RESOLUTION_FAILED" && /requested asset ID/.test(error.message)
  );
  await assert.rejects(
    resolveNoteAssetDenoms(notes, async () => ({
      ...registryAsset("aokrw"),
      canonical_denom: ""
    })),
    error => error?.code === "ASSET_REGISTRY_RESOLUTION_FAILED"
  );
});

test("unresolved note rows and filters never fall back to the active denom", () => {
  const note = storedNote(3, "uatom");
  assert.throws(() => resolvedNoteAssetDenom(note, new Map()), /is unresolved/);
  assert.throws(() => notesForResolvedDenom([note], new Map(), "aokrw"), /is unresolved/);
});
