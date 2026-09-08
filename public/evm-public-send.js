import { evmReceiptStatusKind } from "./transaction-status.js";

function evmHash(value) {
  const hex = String(value || "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("Invalid EVM transaction hash");
  return `0x${hex.toLowerCase()}`;
}

// Native sends have no privacy payload or privacy events. Keep their receipt
// confirmation separate from the SDK's prepared-privacy-transaction verifier.
export async function waitForPublicEvmSend(client, txHash) {
  const hash = evmHash(txHash);
  await client.assertEvmNetwork();
  const receipt = await client.waitForEvmReceipt(hash);
  await client.assertEvmNetwork();
  if (!receipt) return { txHash: hash, receipt: null, unknown: true };
  if (evmHash(receipt.transactionHash) !== hash) {
    throw new Error("EVM send receipt transaction hash mismatch");
  }
  if (!/^0x[0-9a-f]+$/i.test(String(receipt.blockNumber || ""))
    || BigInt(receipt.blockNumber) <= 0n
    || !/^0x[0-9a-f]{64}$/i.test(String(receipt.blockHash || ""))) {
    throw new Error("EVM send receipt is missing its included block identity");
  }
  const status = evmReceiptStatusKind(receipt.status);
  if (status === "unknown") throw new Error("EVM send receipt status is unknown");
  const result = { txHash: hash, receipt, unknown: false, ok: status === "success" };
  if (status === "failure") {
    const error = new Error("EVM send failed on-chain");
    error.code = "TX_FAILED_ON_CHAIN";
    error.txHash = hash;
    error.broadcast = result;
    throw error;
  }
  return result;
}
