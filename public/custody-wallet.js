import { createKeplrChainWalletAdapter, createEip1193ChainWalletAdapter } from 'clairveiljs/chain-wallet';

function cosmosChainInfo(profile, origin) {
  // Pinned cc002-local-1 bank metadata: 1 CLAIR = 10^18 uclair.
  const coin = { coinDenom: 'CLAIR', coinMinimalDenom: profile.denom, coinDecimals: 18 };
  return {
    chainId: profile.chainId,
    chainName: 'CC002 Local Cosmos',
    rpc: `${origin}/cosmos-rpc`,
    rest: `${origin}/cosmos-rest`,
    bip44: { coinType: 118 },
    bech32Config: {
      bech32PrefixAccAddr: 'clair', bech32PrefixAccPub: 'clairpub',
      bech32PrefixValAddr: 'clairvaloper', bech32PrefixValPub: 'clairvaloperpub',
      bech32PrefixConsAddr: 'clairvalcons', bech32PrefixConsPub: 'clairvalconspub'
    },
    currencies: [coin],
    feeCurrencies: [{ ...coin, gasPriceStep: { low: 0, average: 0, high: 0 } }],
    stakeCurrency: coin
  };
}

// Chain adapters own ordinary-wallet calls; this module never holds privacy keys.
export function createCustodyWallet(profile, page = window) {
  let adapter;
  return {
    async connect() {
      if (profile.transport === 'cosmos') {
        if (!page.keplr) throw new Error('이 브라우저 프로필에 Keplr를 설치하세요.');
        await page.keplr.experimentalSuggestChain(cosmosChainInfo(profile, page.location.origin));
        adapter = createKeplrChainWalletAdapter({ keplr: page.keplr, chainId: profile.chainId, accountPrefix: profile.prefix });
      } else {
        if (!page.ethereum) throw new Error('이 브라우저 프로필에 MetaMask를 설치하세요.');
        await page.ethereum.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: profile.evmChainId, chainName: 'CC002 Local EVM',
          nativeCurrency: { name: 'Local test', symbol: 'TEST', decimals: 18 }, rpcUrls: [profile.evmRpc]
        }] });
        await page.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: profile.evmChainId }] });
        adapter = createEip1193ChainWalletAdapter({ provider: page.ethereum, chainId: profile.evmChainId });
      }
      return adapter.connect();
    },
    getActor: () => adapter.getActor(),
    signDirect: (...args) => adapter.signDirect(...args),
    sendTransaction: (...args) => adapter.sendTransaction(...args)
  };
}

export function watchCustodyWallet(page, invalidate) {
  page.addEventListener('keplr_keystorechange', invalidate);
  page.ethereum?.on?.('accountsChanged', invalidate);
  page.ethereum?.on?.('chainChanged', invalidate);
  return () => {
    page.removeEventListener('keplr_keystorechange', invalidate);
    page.ethereum?.removeListener?.('accountsChanged', invalidate);
    page.ethereum?.removeListener?.('chainChanged', invalidate);
  };
}

export async function broadcastCustodyCosmos(bytes) {
  const response = await fetch('/custody-broadcast', {
    method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx_bytes: btoa(String.fromCharCode(...bytes)), mode: 'BROADCAST_MODE_SYNC' })
  });
  if (!response.ok) throw new Error('체인 제출 결과를 확인하지 못했습니다.');
  const result = (await response.json()).tx_response;
  if (!result || Number(result.code) !== 0 || !/^[0-9a-fA-F]{64}$/.test(result.txhash)) {
    throw new Error('체인 제출 결과를 확인하지 못했습니다.');
  }
  return result.txhash;
}
