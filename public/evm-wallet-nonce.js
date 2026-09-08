function nonceQuantity(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    throw new Error("EVM nonce must be a canonical hex quantity");
  }
  return BigInt(value);
}

// Run under the public account lock and BEFORE the durable wallet-attempt
// marker. Never infer non-submission from a post-wallet nonce error: the
// wallet might be reporting a retry of an already included transaction.
export async function withPublicEvmNonce(client, transaction) {
  if (!/^0x[0-9a-f]{40}$/i.test(transaction.from || "")) {
    throw new Error("EVM nonce lookup requires the submitting account");
  }
  await client.assertEvmNetwork();
  const latest = nonceQuantity(await client.evmJsonRpc("eth_getTransactionCount", [transaction.from, "latest"]));
  const pending = nonceQuantity(await client.evmJsonRpc("eth_getTransactionCount", [transaction.from, "pending"]));
  await client.assertEvmNetwork();
  if (pending < latest) throw new Error("EVM RPC returned inconsistent account nonces; refresh before submitting");
  const nonce = transaction.nonce == null ? pending : nonceQuantity(transaction.nonce);
  if (nonce < pending) {
    const error = new Error("The prepared transaction nonce is already used or pending. Prepare a new request; the wallet was not called.");
    error.code = "EVM_NONCE_STALE_BEFORE_WALLET";
    throw error;
  }
  return { ...transaction, nonce: `0x${nonce.toString(16)}` };
}
