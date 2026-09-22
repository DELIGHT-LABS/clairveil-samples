import { createCustodyProvider, createDirectBridgeTransport } from 'clairveiljs/custody-provider';
import { createClairveilDappClient, createArtifactVerifier } from 'clairveiljs/dapp';
import { createLocalCustodyBridge } from './custody-bridge.js';
import { createCustodySession } from './custody-session.js';
import { createCustodyWallet, watchCustodyWallet, broadcastCustodyCosmos } from './custody-wallet.js';

// React owns rendering; this adapter owns one profile's wallet/RPC resources.
export function createCustodyRuntime({ profile, onChange, browser = window }) {
  const bridge = createLocalCustodyBridge(browser);
  const provider = createCustodyProvider({ transport: createDirectBridgeTransport({ exchange: bridge.exchange }), subscribeInvalidation: bridge.subscribe, timeoutMs: 12000 });
  let session, cleanWalletEvents = () => {}, disposed = false;
  try {
    const wallet = createCustodyWallet(profile);
    const client = createClairveilDappClient({ custodyProvider: provider, chainWallet: wallet,
      validateArtifact: createArtifactVerifier({ profileDigest: profile.profileDigest, chainId: profile.caip, assetDenom: profile.denom,
        ...(profile.contract ? { contractAddress: profile.contract, protocolChainId: profile.chainId } : {}) }),
      broadcastCosmos: broadcastCustodyCosmos
    });
    session = createCustodySession({ client, provider, wallet, profile, checkAvailability: bridge.probe, onChange });
  } catch (error) { provider.dispose(); bridge.close(); throw error; }
  return {
    session,
    async connectWallet() {
      await session.connectWallet();
      if (disposed) return;
      cleanWalletEvents();
      cleanWalletEvents = watchCustodyWallet(browser, () => session.invalidate());
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanWalletEvents(); session.dispose(); provider.dispose(); bridge.close();
    }
  };
}
