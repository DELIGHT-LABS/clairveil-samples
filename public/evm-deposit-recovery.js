import { AbiCoder, id } from "ethers";
import { evmTransactionBindingHash, waitForEvmFinality } from "clairveiljs/evm";
import { evmReceiptStatusKind } from "./transaction-status.js";

// Sample confirmation policy: one canonical inclusion, not irreversible finality.
export const sampleEvmFinalityPolicy = Object.freeze({ mode: "confirmations", confirmations: 1 });
const depositTopic = id("PrivacyDeposit(address,address,string,bytes)");
const depositEventCoder = AbiCoder.defaultAbiCoder();
const hex = value => String(value || "").replace(/^0x/i, "").toLowerCase();

export async function saveEvmDepositRecovery(store, privacyTransaction, sender, prepared) {
  if (!store) throw new Error("Encrypted deposit recovery storage is required before wallet submission");
  const payloadHash = hex(evmTransactionBindingHash(privacyTransaction));
  // JSON preserves the SDK's enumerable binding metadata, but not its Symbol.
  // Never persist root seeds, note plaintext, or the complete preparation object.
  await store.save({ payloadHash, privacyTransaction, sender, prepared: {
    noteCommitmentHex: prepared?.noteCommitmentHex,
    encryptedNoteHex: prepared?.encryptedNoteHex,
    amount: prepared?.amount,
    shieldedAddress: prepared?.shieldedAddress
  } });
  return payloadHash;
}

export async function loadEvmDepositRecovery(store, id, sender) {
  if (!store) throw new Error("Setup Clairveil to unlock encrypted deposit recovery");
  const saved = await store.load(id);
  if (!saved || hex(saved.sender) !== hex(sender)
    || hex(evmTransactionBindingHash(saved.privacyTransaction)) !== id) {
    throw new Error("Saved deposit transaction identity is missing or mismatched");
  }
  return saved;
}

export async function waitForPreparedEvmPrivacy(client, txHash, binding = {}) {
  const hash = `0x${hex(txHash)}`;
  if (!binding.privacyTransaction || !binding.sender) {
    throw Object.assign(new Error("Original prepared transaction and sender are required for recovery"), { txHash: hash });
  }
  let broadcast;
  try {
    broadcast = await client.waitForEvmTransaction(hash, {
      privacyTransaction: binding.privacyTransaction,
      sender: binding.sender,
      finalityPolicy: client.evmFinalityPolicy || sampleEvmFinalityPolicy
    });
  } catch (cause) {
    throw Object.assign(new Error("EVM receipt verification could not complete", { cause }), {
      txHash: hash, code: "TX_RESULT_UNKNOWN"
    });
  }
  if (!broadcast?.receipt) return { ...broadcast, txHash: hash, unknown: true };
  const exact = hex(broadcast.receipt.transactionHash) === hex(hash)
    && broadcast.evmTransactionVerified === true;
  if (!exact || broadcast.ok !== true || broadcast.evmPrivacyReceiptVerified !== true
    || broadcast.evmFinalityVerified !== true) {
    const failed = exact && evmReceiptStatusKind(broadcast.receipt.status) === "failure";
    throw Object.assign(new Error(broadcast.error || "EVM privacy transaction verification is incomplete"), {
      txHash: hash,
      code: failed ? "TX_FAILED_ON_CHAIN" : "TX_RESULT_UNKNOWN",
      // Unverified/mismatched receipts must not be treated as failure evidence.
      broadcast: failed ? broadcast : { txHash: hash, unknown: true }
    });
  }
  return { ...broadcast, txHash: hash, unknown: false };
}

// Recovery of older hash-only entries is deliberately not prepared-call verification.
// Bind a canonical deposit event to the exact hash/account/contract; the caller
// must additionally recover the matching owned note from the authoritative scan.
export async function waitForLegacyEvmDeposit(client, txHash, { sender, contractAddress }) {
  const hash = `0x${hex(txHash)}`;
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid deposit transaction hash");
  await client.assertEvmNetwork();
  const receipt = await client.waitForEvmReceipt(hash);
  if (!receipt) return { txHash: hash, unknown: true };
  const tx = await client.evmJsonRpc("eth_getTransactionByHash", [hash]);
  await client.assertEvmNetwork();
  if (hex(receipt.transactionHash) !== hex(hash) || hex(tx?.hash) !== hex(hash)
    || hex(tx?.from) !== hex(sender) || hex(tx?.to) !== hex(contractAddress)) {
    throw new Error("Deposit recovery transaction identity mismatch");
  }
  const finality = await waitForEvmFinality({
    txHash: hash, receipt,
    rpc: (method, params) => client.evmJsonRpc(method, params),
    policy: client.evmFinalityPolicy || sampleEvmFinalityPolicy
  });
  if (finality.verified !== true) throw new Error(finality.error || "Deposit inclusion is not canonical");
  const logs = (receipt.logs || []).filter(log => hex(log.address) === hex(contractAddress)
    && hex(log.topics?.[0]) === hex(depositTopic));
  if (logs.length !== 1 || logs[0].removed === true) throw new Error("Expected exactly one canonical deposit event");
  const [amount, noteCommitment] = depositEventCoder.decode(["string", "bytes"], logs[0].data);
  const accountTopic = hex(sender).padStart(64, "0");
  if (logs[0].topics.length !== 3
    || hex(logs[0].topics[1]) !== accountTopic || hex(logs[0].topics[2]) !== accountTopic
    || !/^[0-9a-f]{64}$/.test(hex(noteCommitment))
    || hex(depositEventCoder.encode(["string", "bytes"], [amount, noteCommitment])) !== hex(logs[0].data)) {
    throw new Error("Deposit event account or commitment mismatch");
  }
  return { txHash: hash, receipt, unknown: false, recoveryOnly: true,
    depositCommitment: hex(noteCommitment), depositAmount: amount };
}

export function recoveredLegacyEvmDepositNote(notes, result, denom) {
  if (!result?.depositCommitment || !result?.receipt) return null;
  return notes.find(note => hex(note.commitment || note.commitmentHex || note.commitment_hex
    || note.noteCommitmentHex || note.note_commitment_hex) === result.depositCommitment
    && String(note.amount) + denom === result.depositAmount
    && BigInt(note.height || 0) === BigInt(result.receipt.blockNumber)) || null;
}
