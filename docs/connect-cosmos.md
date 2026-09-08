# Connect an existing Cosmos chain

[README](../README.md) · [한국어](connect-cosmos-kr.md)

Start the chain using its own repository's instructions. This guide connects the samples web to an already running Clairveil-compatible chain using environment variables. No JSON editing is needed.

## 1. Copy the environment example

Use [.env.cosmos.example](../.env.cosmos.example). Install SDK/web dependencies as described in the README, then from the samples root:

```bash
cp .env.cosmos.example .env
```

Back up an existing `.env` first. Edit the copy with your chain's metadata and endpoints; keep the example reusable.

## 2. Fill in chain metadata

| Chain information | Environment variable |
| --- | --- |
| Host network ID from RPC /status | `CHAIN_ID` |
| Host CometBFT HTTP(S) RPC / Cosmos REST | `CLAIRVEIL_RPC`, `CLAIRVEIL_REST` |
| Prover base URL | `CLAIRVEIL_PROVER_URL` |
| Minimal denom / display symbol / decimals | `CLAIRVEIL_DENOM`, `CLAIRVEIL_DISPLAY_DENOM`, `CLAIRVEIL_COIN_DECIMALS` |
| Host account / shielded prefix | `CLAIRVEIL_ACCOUNT_PREFIX`, `CLAIRVEIL_SHIELDED_PREFIX` |
| Coin type | `CLAIRVEIL_COSMOS_COIN_TYPE` |
| Gas prices (minimal denom/gas) | `CLAIRVEIL_KEPLR_GAS_LOW`, `CLAIRVEIL_KEPLR_GAS_AVERAGE`, `CLAIRVEIL_KEPLR_GAS_HIGH` |
| Optional exact canonical deposit URL | `CLAIRVEIL_COSMOS_DEPOSIT_PROOF_URL` |

Replace every example ID, URL, prefix, decimal count, and gas value with the chain's published metadata. A denom prefix does not determine decimals.
The server generates `keplrChainInfo` from the environment, avoiding duplicate JSON editing. Gas prices use minimal-denom units per gas: with six decimals, 1 TOKEN is 1,000,000 utoken, and a gas price of 0.025 means 0.025 utoken/gas. Generated Keplr metadata assumes the same fee/staking asset and conventional Bech32 suffixes; verify these against the chain. Cosmos deposit defaults to `/v1/prover/deposit` on the prover base. Set the exact canonical override if it runs on a separate service.

The examples default to public HTTPS endpoints with local helpers disabled. Set `CLAIRVEIL_DAPP_PUBLIC_ORIGIN` to the actual deployed HTTPS web origin. The Node server listens over HTTP; public deployment needs an HTTPS reverse proxy at that origin.

For local HTTP chain testing on your computer, set `CLAIRVEIL_DAPP_LOCAL_TEST_MODE=1`, keep the host at `127.0.0.1`, and enter your loopback endpoints. This also enables local signer/faucet/admin features. Those require separately configured chain CLI, home, and test keys; they are not automatically portable to another chain. Fund wallet tests through the chain's own faucet. See [.env.example](../.env.example) for advanced helper configuration.

## 3. Start the web

The server does not automatically load `.env`. In a fresh terminal at the samples root:

```bash
set -a
source .env
set +a
npm start
```

The local URL defaults to http://127.0.0.1:5173/. Change `CLAIRVEIL_DAPP_PORT` if occupied. Restart the server and reload the browser after changing environment values. Use a fresh shell when switching Cosmos/EVM examples to avoid stale exports.

The browser reads the `config` field in the server's `/api/health` response; inspect `/api/config` to see generated profiles. Leave `public/dapp-config.json` unchanged for this workflow. A Python static server cannot read these variables, so use `npm start`.

## 4. Connect and test

1. Use a browser with Keplr. Check the profile name, chain ID, advancing height, and REST Online.
2. Wait for protocol validation, then Connect Keplr to the intended network/account. `v0.3.1 ready` identifies the wallet contract, not the chain release.
3. Complete Setup Clairveil, fund through the chain's faucet, refresh balance, and satisfy chain-specific account authorization.
4. Deposit a small amount in the input's displayed unit. Verify proof, signing, transaction inclusion, and note recovery. Then Transfer to another wallet, Scan, and Withdraw.

Health/protocol checks do not prove transaction completion. For failures, check browser endpoint reachability, CORS, HTTPS, prover readiness/contract, and fee units. Remote provers require HTTPS; HTTP is only for loopback testing. Another device's 127.0.0.1 does not refer to your chain computer. Reconcile an unresolved transaction's existing hash before another submission.
