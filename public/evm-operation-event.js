import { waitForEvmFinality } from "clairveiljs/evm";
import {
  sampleEvmFinalityPolicy, loadEvmDepositRecovery, waitForPreparedEvmPrivacy
} from "./evm-deposit-recovery.js";

const hex = value => String(value || "").replace(/^0x/i, "").toLowerCase();
const hash = value => /^[0-9a-f]{64}$/.test(hex(value));
const same = (a, b) => hash(a) && hash(b) && hex(a) === hex(b);
const positiveHeight = value => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

// These flags are SDK verification results, not a substitute for verification.
// Re-run verification from the original encrypted preparation on every recovery.
export async function verifiedEvmOperationEvidence({ client, store, records, sender, txHash, evidence }) {
  const id = hex(records[0]?.tx_bytes_hash);
  if (!store || !hash(id) || !records.every(record => hex(record.tx_bytes_hash) === id)) return null;
  if (!await store.load(id)) return null;
  const saved = await loadEvmDepositRecovery(store, id, sender);
  const result = await waitForPreparedEvmPrivacy(client, txHash, {
    privacyTransaction: saved.privacyTransaction, sender: saved.sender
  });
  if (result.unknown) return null;
  return {
    ...evidence,
    txBytesHash: id,
    txResult: result,
    evmTransactionVerified: result.evmTransactionVerified,
    evmPrivacyReceiptVerified: result.evmPrivacyReceiptVerified,
    evmFinalityVerified: result.evmFinalityVerified
  };
}

function attributes(event) {
  const entries = event?.attributes;
  if (!Array.isArray(entries)) throw new Error("Privacy event attributes are missing");
  const result = new Map();
  for (const { key, value } of entries) {
    if (typeof key !== "string" || typeof value !== "string" || result.has(key)) {
      throw new Error("Privacy event attributes are ambiguous");
    }
    result.set(key, value);
  }
  return result;
}

// Cosmos-EVM chains expose an Ethereum hash to the wallet and a different hash
// in their privacy index. Never equate those hashes or match on height alone.
export async function findEvmTransferOperationEvent({
  client, txHash, contractAddress, chainId, fetchPage, fetchCosmosTx, fetchCosmosBlock,
  predicate, limit = 200, maxPages = 100
}) {
  if (!hash(txHash) || !/^0x[0-9a-f]{40}$/i.test(contractAddress || "") || !chainId) {
    throw new Error("EVM operation recovery requires configured transaction/chain identities");
  }
  const evmHash = `0x${hex(txHash)}`;
  await client.assertEvmNetwork();
  const [receipt, transaction] = await Promise.all([
    client.evmJsonRpc("eth_getTransactionReceipt", [evmHash]),
    client.evmJsonRpc("eth_getTransactionByHash", [evmHash])
  ]);
  if (!receipt) return { complete: false, event: null };
  const height = positiveHeight(receipt.blockNumber);
  if (!same(receipt.transactionHash, evmHash) || !same(transaction?.hash, evmHash)
    || !height || positiveHeight(transaction.blockNumber) !== height
    || !same(transaction.blockHash, receipt.blockHash)
    || hex(transaction.to) !== hex(contractAddress) || hex(receipt.to) !== hex(contractAddress)
    || receipt.status !== "0x1") {
    throw new Error("EVM operation receipt/transaction identity is not a confirmed success");
  }
  const block = (await fetchCosmosBlock(height))?.result;
  if (block?.block?.header?.chain_id !== chainId
    || positiveHeight(block.block.header.height) !== height
    || !same(block.block_id?.hash, receipt.blockHash)) {
    throw new Error("Cosmos block does not match the EVM receipt's canonical block");
  }
  for (let page = 1; page <= maxPages; page++) {
    const data = await fetchPage({ afterHeight: height - 1, page, limit, eventTypes: ["shielded_transfer"] });
    const candidates = (data?.events || []).filter(event => event?.event_type === "shielded_transfer"
      && positiveHeight(event.height) === height && predicate(event));
    for (const event of candidates) {
      if (!hash(event.tx_hash_hex)) throw new Error("Privacy event transaction hash is invalid");
      const included = (await fetchCosmosTx(hex(event.tx_hash_hex)))?.result;
      if (!included || !same(included.hash, event.tx_hash_hex)
        || positiveHeight(included.height) !== height || included.tx_result?.code !== 0
        || !Number.isSafeInteger(included.index) || included.index < 0
        || typeof included.tx !== "string" || !included.tx
        || block.block.data?.txs?.[included.index] !== included.tx) {
        throw new Error("Cosmos privacy transaction inclusion cannot be verified");
      }
      const raw = Uint8Array.from(atob(included.tx), char => char.charCodeAt(0));
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
      if (!same(Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join(""), included.hash)) {
        throw new Error("Cosmos transaction bytes do not match the indexed hash");
      }
      const events = included.tx_result.events || [];
      const linkedHashes = events.filter(item => item.type === "ethereum_tx")
        .flatMap(item => (item.attributes || []).filter(attribute => attribute.key === "ethereumTxHash")
          .map(attribute => attribute.value));
      if (!linkedHashes.length || linkedHashes.some(value => !same(value, evmHash))) continue;
      const observed = attributes(event);
      if (["nullifier_1", "nullifier_2", "commitment_1", "commitment_2", "audit_disclosure_digest"]
        .some(key => !hash(observed.get(key)))) {
        throw new Error("Privacy transfer output evidence is incomplete");
      }
      const matches = events.filter(item => item.type === "shielded_transfer").filter(item => {
        const canonical = attributes(item);
        return [...observed].every(([key, value]) => canonical.get(key) === value);
      });
      if (matches.length !== 1) throw new Error("Indexed privacy outputs do not match the included transaction event");
      const finality = await waitForEvmFinality({
        txHash: evmHash, receipt, rpc: (method, params) => client.evmJsonRpc(method, params),
        policy: client.evmFinalityPolicy || sampleEvmFinalityPolicy
      });
      await client.assertEvmNetwork();
      if (finality.verified !== true) throw new Error(finality.error || "EVM operation inclusion is not canonical");
      return { complete: true, event };
    }
    if (!data?.has_more || (data.events || []).some(event => positiveHeight(event.height) > height)) {
      return { complete: false, event: null };
    }
  }
  throw new Error("EVM operation event lookup exceeded its page budget");
}
