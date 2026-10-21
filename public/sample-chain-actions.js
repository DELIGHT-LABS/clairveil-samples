import { fromBech32 } from '@cosmjs/encoding';
import { createKeplrChainWalletAdapter } from 'clairveiljs/chain-wallet';
import { TxBody, AuthInfo, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx.js';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx.js';
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys.js';
import { fetchBoundedJson } from './bounded-json-fetch.js';
import { broadcastCustodyCosmos } from './custody-wallet.js';

const bytes = hex => Uint8Array.from(hex.match(/../g) || [], part => parseInt(part, 16));
const equal = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((byte, index) => byte === b[index]);

export async function readTransparentBalance(profile, actor, browser = window) {
  if (profile.transport === 'evm') {
    return BigInt(await browser.ethereum.request({ method: 'eth_getBalance', params: [actor.address, 'latest'] })).toString();
  }
  const value = await fetchBoundedJson(`/cosmos-rest/cosmos/bank/v1beta1/balances/${encodeURIComponent(actor.address)}/by_denom?denom=${encodeURIComponent(profile.denom)}`, { timeoutMs: 10000, maxBytes: 16384 });
  if (!value.balance || value.balance.denom !== profile.denom || !/^\d+$/.test(value.balance.amount)) throw new Error('Invalid transparent balance response');
  return value.balance.amount;
}

// Public bank/native sends only. Sign through the ordinary adapter; never import
// a private-key wallet, privacy kernel or generic SDK root entry.
export async function sendTransparent({ profile, actor, recipient, amount, browser = window, isCurrent = () => true,
  fetchJson = fetchBoundedJson, broadcast = broadcastCustodyCosmos, signal, beforeBroadcast = () => {} }) {
  if (!/^[1-9][0-9]*$/.test(amount) || amount.length > 78) throw new Error('Enter a positive integer in base units.');
  if (profile.transport === 'evm') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error('Enter an EVM recipient address.');
    const chainId = await browser.ethereum.request({ method: 'eth_chainId' });
    const accounts = await browser.ethereum.request({ method: 'eth_accounts' });
    if (!isCurrent() || BigInt(chainId) !== BigInt(profile.evmChainId) || accounts[0]?.toLowerCase() !== actor.address.toLowerCase()) throw new Error('Wallet changed; submission stopped.');
    beforeBroadcast();
    try {
      return await browser.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: actor.address, to: recipient, value: `0x${BigInt(amount).toString(16)}` }] });
    } catch (cause) {
      // EIP-1193 user rejection is definite non-submission. Other provider
      // failures can lose a successful broadcast reply and must stay pending.
      if (cause?.code === 4001) throw Object.assign(new Error('Wallet request rejected; no transaction sent.'), { publicSendRejected: true });
      throw cause;
    }
  }
  const destination = fromBech32(recipient, 200);
  if (destination.prefix !== profile.prefix || destination.data.length !== 20) throw new Error('Enter a recipient on the selected Cosmos network.');
  const wallet = createKeplrChainWalletAdapter({ keplr: browser.keplr, chainId: profile.chainId, accountPrefix: profile.prefix });
  const [accountResponse, status] = await Promise.all([
    fetchJson(`/cosmos-rest/cosmos/auth/v1beta1/accounts/${encodeURIComponent(actor.address)}`, { timeoutMs: 10000, maxBytes: 16384 }),
    fetchJson('/cosmos-rpc/status', { timeoutMs: 10000, maxBytes: 16384 })
  ]);
  const account = accountResponse.account?.base_account || accountResponse.account;
  if (status.result?.node_info?.network !== profile.chainId || account?.address !== actor.address
    || !/^\d+$/.test(account?.account_number) || !/^\d+$/.test(account?.sequence) || !/^[0-9a-fA-F]{66}$/.test(actor.pubKeyHex)) throw new Error('Account or chain response mismatch; submission stopped.');
  const message = MsgSend.encode(MsgSend.fromPartial({ fromAddress: actor.address, toAddress: recipient,
    amount: [{ denom: profile.denom, amount }] })).finish();
  const bodyBytes = TxBody.encode(TxBody.fromPartial({ messages: [{ typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: message }] })).finish();
  const authInfoBytes = AuthInfo.encode(AuthInfo.fromPartial({ signerInfos: [{ publicKey: {
    typeUrl: '/cosmos.crypto.secp256k1.PubKey', value: PubKey.encode({ key: bytes(actor.pubKeyHex) }).finish()
  }, modeInfo: { single: { mode: 1 } }, sequence: BigInt(account.sequence) }], fee: { amount: [], gasLimit: 200000n } })).finish();
  const document = { bodyBytes, authInfoBytes, chainId: profile.chainId, accountNumber: BigInt(account.account_number) };
  if (!isCurrent()) throw new Error('Connection changed; submission stopped.');
  const signed = await wallet.signDirect(document, actor, { signal });
  if (!isCurrent() || signed.signed?.chainId !== document.chainId || signed.signed.accountNumber !== document.accountNumber
    || !equal(signed.signed.bodyBytes, bodyBytes) || !equal(signed.signed.authInfoBytes, authInfoBytes)) throw new Error('Signed transaction differs from the requested public send.');
  const signature = signed.signature?.signature;
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw new Error('Invalid ordinary-wallet signature.');
  const signatureBytes = Uint8Array.from(atob(signature), char => char.charCodeAt(0));
  if (signatureBytes.length !== 64) throw new Error('Invalid ordinary-wallet signature.');
  const raw = TxRaw.encode(TxRaw.fromPartial({ bodyBytes, authInfoBytes, signatures: [signatureBytes] })).finish();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  signal?.throwIfAborted();
  if (!isCurrent()) throw new Error('Connection changed; submission stopped.');
  beforeBroadcast(hash);
  try {
    const returnedHash = await broadcast(raw);
    if (typeof returnedHash !== 'string' || returnedHash.toLowerCase() !== hash) throw new Error('Broadcast response does not match the signed transaction.');
    return hash;
  }
  catch (cause) {
    if (cause?.cosmosCheckTxRejected === true) throw Object.assign(new Error(cause.message), { publicSendRejected: true });
    throw cause;
  }
}
