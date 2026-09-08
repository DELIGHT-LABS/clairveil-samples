import { sha256Hex } from "clairveiljs/browser-crypto";
import { bech32AddressToEvm, evmAddressToBech32 } from "clairveiljs/evm";
import { hashAmount } from "clairveiljs/reservation";
import { AbiCoder, id } from "ethers";

import { cosmosWithdrawMessage } from "./relay-withdraw-reconciliation.js";

function normalizedHex(value, label, { bytes = 0 } = {}) {
  const hex = String(value || "").trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0 || (bytes && hex.length !== bytes * 2)) {
    throw new Error(`${label} must be canonical${bytes ? ` ${bytes}-byte` : ""} hex`);
  }
  return hex;
}

function bytesHex(value) {
  return [...(value || [])].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function eventAttribute(event, key) {
  return (event?.attributes || []).find(attribute => attribute?.key === key)?.value || "";
}

function parseCosmosCoin(value) {
  const match = /^(0|[1-9][0-9]*)([A-Za-z][A-Za-z0-9/:._-]{2,127})$/.exec(String(value || "").trim());
  if (!match) throw new Error("included MsgWithdraw amount must be a canonical Cosmos coin");
  return { amount: match[1], denom: match[2] };
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

// Normalize the user's intended recipient, not the payload's claimed recipient.
// Privacy payloads retain the host chain's bech32 representation on EVM too.
export function withdrawPayloadRecipient(recipient, { transport, accountPrefix } = {}) {
  const intended = requiredText(recipient, "withdraw recipient");
  if (transport === "evm" && /^0x[0-9a-f]{40}$/i.test(intended)) {
    return evmAddressToBech32(intended, requiredText(accountPrefix, "account prefix"));
  }
  return intended;
}

export function evmWithdrawOperationEvidence({ receipt, txHash, contractAddress, accountPrefix } = {}) {
  const expectedHash = normalizedHex(txHash, "withdraw transaction hash", { bytes: 32 });
  if (receipt?.status !== "0x1"
    || normalizedHex(receipt.transactionHash, "receipt transaction hash", { bytes: 32 }) !== expectedHash) {
    throw new Error("Withdraw receipt is not the requested successful transaction");
  }
  const contract = normalizedHex(contractAddress, "privacy contract", { bytes: 20 });
  const topic = id("PrivacyWithdraw(address,address,address,string)").toLowerCase();
  const logs = (receipt.logs || []).filter(log => String(log.address || "").replace(/^0x/i, "").toLowerCase() === contract
    && String(log.topics?.[0] || "").toLowerCase() === topic);
  if (logs.length !== 1 || logs[0].removed === true || logs[0].topics.length !== 4) {
    throw new Error("Expected one canonical PrivacyWithdraw event");
  }
  const log = logs[0];
  const recipientTopic = normalizedHex(log.topics[3], "withdraw recipient topic", { bytes: 32 });
  if (!recipientTopic.startsWith("0".repeat(24))) throw new Error("Invalid withdraw recipient topic padding");
  const recipient = evmAddressToBech32(`0x${recipientTopic.slice(24)}`, accountPrefix);
  const coder = AbiCoder.defaultAbiCoder();
  const [amount] = coder.decode(["string"], log.data);
  if (coder.encode(["string"], [amount]).toLowerCase() !== String(log.data).toLowerCase()) {
    throw new Error("Non-canonical PrivacyWithdraw amount data");
  }
  const coin = parseCosmosCoin(amount);
  return { txHash: expectedHash,
    recipientHash: hashTransparentCosmosRecipient(recipient, { accountPrefix }),
    amount: coin.amount, amountHash: hashAmount(coin.denom, coin.amount), denom: coin.denom,
    batchItemIndex: 0, batchItemIndexKnown: false };
}

export function hashTransparentCosmosRecipient(recipient, { accountPrefix } = {}) {
  const normalizedRecipient = requiredText(recipient, "transparent recipient");
  const normalizedPrefix = requiredText(accountPrefix, "account prefix").toLowerCase();
  if (!/^[a-z0-9]+$/.test(normalizedPrefix) || normalizedPrefix.includes("1")) {
    throw new Error("account prefix must be a lowercase bech32 prefix without separator");
  }
  let canonicalRecipient;
  try {
    const evmAddress = bech32AddressToEvm(normalizedRecipient, normalizedPrefix);
    canonicalRecipient = evmAddressToBech32(evmAddress, normalizedPrefix);
  } catch {
    throw new Error(`transparent recipient must be a ${normalizedPrefix} account address`);
  }
  return sha256Hex(canonicalRecipient);
}

export function cosmosWithdrawOperationEvidence({
  event,
  transaction,
  txHash,
  expectedNullifiers = [],
  accountPrefix
} = {}) {
  if (event?.event_type !== "withdraw") return null;

  const expectedTxHash = normalizedHex(txHash, "withdraw transaction hash");
  const eventTxHash = normalizedHex(event?.tx_hash_hex, "withdraw event transaction hash");
  if (eventTxHash !== expectedTxHash) return null;

  const normalizedExpectedNullifiers = expectedNullifiers.map((nullifier, index) => (
    normalizedHex(nullifier, `withdraw input nullifier ${index}`, { bytes: 32 })
  ));
  if (normalizedExpectedNullifiers.length !== 1 || new Set(normalizedExpectedNullifiers).size !== 1) {
    throw new Error("direct MsgWithdraw evidence requires exactly one reserved input nullifier");
  }

  const eventNullifier = normalizedHex(
    eventAttribute(event, "nullifier"),
    "withdraw event nullifier",
    { bytes: 32 }
  );
  if (eventNullifier !== normalizedExpectedNullifiers[0]) return null;

  const message = cosmosWithdrawMessage(transaction);
  const messageNullifier = normalizedHex(bytesHex(message.nullifier), "included MsgWithdraw nullifier", { bytes: 32 });
  if (messageNullifier !== eventNullifier) return null;

  const eventRecipient = requiredText(eventAttribute(event, "recipient"), "withdraw event recipient");
  const messageRecipient = requiredText(message.recipient, "included MsgWithdraw recipient");
  if (eventRecipient !== messageRecipient) return null;

  const coin = parseCosmosCoin(message.amount);
  const eventAmount = String(eventAttribute(event, "amount") || "").trim();
  if (eventAmount && eventAmount !== message.amount) return null;

  return {
    txHash: eventTxHash,
    outputCommitment: "",
    auditDisclosureDigest: "",
    recipientHash: hashTransparentCosmosRecipient(messageRecipient, { accountPrefix }),
    amount: coin.amount,
    amountHash: hashAmount(coin.denom, coin.amount),
    denom: coin.denom,
    batchItemIndex: 0,
    batchItemIndexKnown: false
  };
}
