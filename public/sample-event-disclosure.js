import { fetchBoundedJson } from './bounded-json-fetch.js';

export function normalizeDisclosureHash(value, transport) {
  if (typeof value !== 'string' || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(value)) return '';
  const normalized = value.toLowerCase(), hex = normalized.replace(/^0x/, '');
  // Format a hash already belonging to the selected chain. EVM event hashes
  // still need the envelope-to-Ethereum lookup below before using this helper.
  return transport === 'cosmos' ? hex : transport === 'evm' ? `0x${hex}` : normalized;
}
const envelopeHash = value => normalizeDisclosureHash(value).replace(/^0x/, '');
const unavailable = () => new Error('Cannot resolve this event to a unique successful Ethereum transaction.');

// This lookup supplies a public transaction reference only. Custody independently
// verifies the transaction, disclosure source and release permission.
export async function resolveDisclosureTransactionHash({ profile, event, fetchJson = fetchBoundedJson, signal }) {
  const hash = envelopeHash(event.tx_hash_hex || event.tx_hash);
  if (!hash) throw new Error('Invalid public event transaction hash.');
  if (profile.transport === 'cosmos') return hash;
  const height = String(event.height);
  if (!/^[1-9][0-9]{0,19}$/.test(height) || !/^0x[0-9a-fA-F]{40}$/.test(profile.contract)) throw unavailable();
  const [status, response] = await Promise.all([
    fetchJson('/evm-rpc/status', { maxBytes: 16384, timeoutMs: 10000, signal }),
    fetchJson(`/evm-rpc/tx?hash=0x${hash}&prove=false`, { maxBytes: 2097152, timeoutMs: 10000, signal })
  ]);
  const tx = response.result;
  if (status.result?.node_info?.network !== profile.chainId || envelopeHash(tx?.hash) !== hash
    || tx?.height !== height || tx.tx_result?.code !== 0 || !Array.isArray(tx.tx_result.events)
    || tx.tx_result.events.length > 256) throw unavailable();
  const entries = tx.tx_result.events.filter(item => item?.type === 'ethereum_tx').map(item => {
    if (!Array.isArray(item.attributes) || item.attributes.length > 64) throw unavailable();
    const attributes = new Map();
    for (const attr of item.attributes) {
      if (typeof attr?.key !== 'string' || typeof attr.value !== 'string' || attributes.has(attr.key)) throw unavailable();
      attributes.set(attr.key, attr.value);
    }
    return attributes;
  });
  const results = entries.filter(attrs => attrs.has('txHash'));
  const markers = entries.filter(attrs => attrs.size === 2 && attrs.has('ethereumTxHash') && attrs.has('txIndex'));
  const ethereumHash = normalizeDisclosureHash(results[0]?.get('ethereumTxHash'));
  if (entries.length !== 2 || results.length !== 1 || markers.length !== 1 || !ethereumHash.startsWith('0x')
    || entries.some(attrs => normalizeDisclosureHash(attrs.get('ethereumTxHash')) !== ethereumHash)
    || !/^(0|[1-9][0-9]*)$/.test(markers[0].get('txIndex'))
    || envelopeHash(results[0].get('txHash')) !== hash || results[0].has('ethereumTxFailed')
    || results[0].get('recipient')?.toLowerCase() !== profile.contract.toLowerCase()) throw unavailable();
  return ethereumHash;
}
