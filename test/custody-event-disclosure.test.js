import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDisclosureTransactionHash } from '../public/sample-event-disclosure.js';
import { privacyEventRpc } from './helpers/privacy-event-rpc.js';

const profile = { transport: 'evm', chainId: 'synthetic-2', contract: '0x' + '12'.repeat(20) };

test('EVM event selection maps the Comet hash through the successful Ethereum keeper result', async () => {
  const f = privacyEventRpc(profile), event = f.events[0];
  const hash = await resolveDisclosureTransactionHash({ profile, event, fetchJson: f.fetchJson });
  assert.equal(hash, '0x' + 'e'.repeat(64));
  assert.notEqual(hash, '0x' + event.tx_hash_hex.toLowerCase());
  assert.deepEqual(f.requests.map(item => item.url), ['/evm-rpc/status', `/evm-rpc/tx?hash=0x${'a'.repeat(64)}&prove=false`]);
  assert(f.requests.every(({ options }) => options.timeoutMs === 10000 && options.maxBytes <= 2097152));
});

test('Cosmos event selection retains its normalized envelope hash and needs no EVM query', async () => {
  const hash = await resolveDisclosureTransactionHash({ profile: { transport: 'cosmos' }, event: { tx_hash_hex: 'AB'.repeat(32) }, fetchJson: () => assert.fail('EVM query') });
  assert.equal(hash, 'ab'.repeat(32));
});

test('missing, ambiguous, failed or unrelated EVM mappings never fall back to the envelope hash', async () => {
  const set = (entry, key, value) => { entry.attributes.find(item => item.key === key).value = value; };
  const mutations = {
    chain: (f, tx) => { f.status.result.node_info.network = 'wrong-chain'; },
    hash: (f, tx) => { tx.hash = 'c'.repeat(64); },
    height: (f, tx) => { tx.height = '12'; },
    failed: (f, tx) => { tx.tx_result.code = 1; },
    missing: (f, tx) => { tx.tx_result.events.pop(); },
    ambiguous: (f, tx) => { tx.tx_result.events.push(structuredClone(tx.tx_result.events[1])); },
    contract: (f, tx) => set(tx.tx_result.events[1], 'recipient', '0x' + '34'.repeat(20)),
    envelope: (f, tx) => set(tx.tx_result.events[1], 'txHash', 'c'.repeat(64)),
    marker: (f, tx) => set(tx.tx_result.events[0], 'ethereumTxHash', '0x' + 'f'.repeat(64)),
    malformed: (f, tx) => set(tx.tx_result.events[1], 'ethereumTxHash', 'e'.repeat(64)),
    execution: (f, tx) => { tx.tx_result.events[1].attributes.push({ key: 'ethereumTxFailed', value: 'reverted' }); },
    duplicate: (f, tx) => { tx.tx_result.events[1].attributes.push({ key: 'ethereumTxHash', value: '0x' + 'e'.repeat(64) }); }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const f = privacyEventRpc(profile); mutate(f, f.transactions.get('a'.repeat(64)).result);
    await assert.rejects(resolveDisclosureTransactionHash({ profile, event: f.events[0], fetchJson: f.fetchJson }), /Cannot resolve/, name);
  }
});
