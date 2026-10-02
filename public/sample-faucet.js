import { fetchBoundedJson } from './bounded-json-fetch.js';

export function faucetMatchesProfile(configuration, profile) {
  let sameEvmChain = false;
  try { sameEvmChain = BigInt(configuration?.evmChainId) === BigInt(profile?.evmChainId); } catch { /* Invalid or non-EVM configuration. */ }
  return Boolean(configuration?.serverFeatures?.faucet === true && profile
    && configuration.transport === profile.transport && configuration.chainId === profile.chainId
    && configuration.denom === profile.denom
    && (profile.transport !== 'evm' || sameEvmChain)
    && Number.isInteger(configuration.coinDecimals) && configuration.coinDecimals >= 0 && configuration.coinDecimals <= 18);
}

export function faucetAmount(value, decimals, denom) {
  if (typeof value !== 'string' || value.length > 80 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) throw new Error('Enter a positive faucet amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error('Faucet amount has too many decimal places.');
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (units <= 0n || units >= (1n << 256n)) throw new Error('Faucet amount is out of range.');
  return `${units}${denom}`;
}

export async function requestSampleFaucet({ configuration, profile, actor, amount, signal, beforeDispatch,
  fetchImpl = globalThis.fetch }) {
  if (!faucetMatchesProfile(configuration, profile)) throw new Error('Faucet is unavailable for the selected chain.');
  const requested = faucetAmount(amount, configuration.coinDecimals, profile.denom);
  signal?.throwIfAborted();
  beforeDispatch();
  let result;
  try {
    result = await fetchBoundedJson('/api/faucet', { signal, timeoutMs: 60000, maxBytes: 1048576, includeErrorBody: true,
      fetchImpl: (url, options) => fetchImpl(url, { ...options, method: 'POST', credentials: 'omit',
        headers: { ...options.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ recipient: actor.address, amount: requested }) }) });
  } catch (cause) {
    const evidence = cause.responseBody;
    if (profile.transport === 'cosmos' && cause.httpStatus === 400 && evidence?.checkTxRejected === true
      && evidence.rpcInvoked === true && Number.isSafeInteger(evidence.txCode) && evidence.txCode > 0
      && typeof evidence.txHash === 'string' && /^[0-9a-fA-F]{64}$/.test(evidence.txHash)) {
      // Only funds/fee rejection permits another request. Duplicate and sequence
      // errors can refer to an already submitted transaction: retain its hash.
      const rejected = evidence.txCodespace === 'sdk' && evidence.txHeight === '0' && [5, 13].includes(evidence.txCode);
      throw Object.assign(new Error(rejected ? 'Faucet CheckTx rejected: insufficient funds or fee.'
        : 'Faucet submission unresolved; check the saved transaction.'), {
        faucetRejected: rejected, hash: evidence.txHash.toLowerCase(), amount: requested
      });
    }
    throw cause;
  }
  if ((result.recipientEvm || result.recipient)?.toLowerCase() !== actor.address.toLowerCase()
    || result.amount?.funded !== requested) throw new Error('Faucet response does not match the requested recipient and amount.');
  const hash = result.broadcast?.txhash;
  if (typeof hash !== 'string' || !(profile.transport === 'evm' ? /^0x[0-9a-fA-F]{64}$/ : /^[0-9a-fA-F]{64}$/).test(hash)) throw new Error('Faucet returned no valid transaction hash; inspect the local signer.');
  const tx = result.tx, receipt = result.receipt;
  const confirmed = result.included === true && result.unknown === false && result.failed === false
    && (profile.transport === 'evm'
      ? receipt?.transactionHash?.toLowerCase() === hash.toLowerCase() && ['0x1', 1, '1'].includes(receipt.status)
      : tx?.txhash?.toLowerCase() === hash.toLowerCase() && [0, '0'].includes(tx.code) && /^[1-9][0-9]*$/.test(String(tx.height)));
  return { hash, amount: requested, confirmed };
}
