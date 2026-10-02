// Synthetic public RPC metadata: Comet envelope hashes and Ethereum hashes differ.
export function privacyEventRpc(profile) {
  const events = ['a', 'b'].map(char => ({ tx_hash_hex: char.toUpperCase().repeat(64), height: '10', event_type: 'shielded_transfer' }));
  const status = { result: { node_info: { network: profile.chainId }, sync_info: { latest_block_height: '11' } } };
  const transactions = new Map(events.map((event, index) => {
    const ethereumHash = '0x' + ['e', 'f'][index].repeat(64);
    const attrs = values => Object.entries(values).map(([key, value]) => ({ key, value }));
    return [event.tx_hash_hex.toLowerCase(), { result: { hash: event.tx_hash_hex, height: event.height, index,
      tx_result: { code: 0, events: [
        { type: 'ethereum_tx', attributes: attrs({ ethereumTxHash: ethereumHash, txIndex: String(index) }) },
        { type: 'ethereum_tx', attributes: attrs({ amount: '0', ethereumTxHash: ethereumHash, txGasUsed: '123', txHash: event.tx_hash_hex.toLowerCase(), recipient: profile.contract }) }
      ] } } }];
  }));
  const requests = [];
  const fetchJson = async (url, options) => {
    requests.push({ url, options });
    const parsed = new URL(url, 'http://127.0.0.1:4320');
    if (parsed.pathname.endsWith('/status')) return status;
    if (parsed.pathname.endsWith('/events')) {
      const page = Number(parsed.searchParams.get('page') || 1), limit = Number(parsed.searchParams.get('limit') || 30);
      return { events: events.slice((page - 1) * limit, page * limit), page: String(page), limit: String(limit), has_more: page * limit < events.length };
    }
    if (parsed.pathname === '/evm-rpc/tx') return transactions.get(parsed.searchParams.get('hash').slice(2));
    throw new Error('Unexpected synthetic RPC route');
  };
  return { events, status, transactions, requests, fetchJson };
}
