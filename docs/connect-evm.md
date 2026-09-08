# Connect an existing EVM chain

[README](../README.md) · [한국어](connect-evm-kr.md)

Start the chain using its own repository's instructions. This guide connects the samples web to an already running Clairveil-compatible chain using environment variables. No JSON editing is needed.

## 1. Copy the environment example

Use [.env.evm.example](../.env.evm.example). Install SDK/web dependencies as described in the README, then from the samples root:

```bash
cp .env.evm.example .env
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
| EIP-155 ID (`eth_chainId`) | `CLAIRVEIL_EVM_CHAIN_ID` |
| EVM RPC | `CLAIRVEIL_EVM_RPC` |
| EVM-derived host account prefix | `CLAIRVEIL_EVM_PRIVACY_ACCOUNT_PREFIX` |
| Privacy precompile address | `CLAIRVEIL_EVM_PRIVACY_PRECOMPILE` |
| Deposit mode / native denom | `CLAIRVEIL_EVM_DEPOSIT_MODE`, `CLAIRVEIL_EVM_NATIVE_DENOM` |
| Exact EVM deposit provider | `CLAIRVEIL_EVM_DEPOSIT_PROOF_URL` |

Replace every example ID, URL, prefix, decimal count, and gas value with the chain's published metadata. A denom prefix does not determine decimals.
`CHAIN_ID` is the host string network ID; `CLAIRVEIL_EVM_CHAIN_ID` is MetaMask's EIP-155 ID (4660 = 0x1234). Both must identify the same chain. `payable-exact-value` requires matching privacy/native denoms. Use the chain's published precompile and deposit mode. CLI-local proving does not supply an HTTP prover to the browser. Configure an explicit EVM-compatible deposit provider; do not assume the Cosmos deposit route is interchangeable.

The examples default to public HTTPS endpoints with local helpers disabled. Set `CLAIRVEIL_DAPP_PUBLIC_ORIGIN` to the actual deployed HTTPS web origin. The Node server listens over HTTP; public deployment needs an HTTPS reverse proxy at that origin.

For local HTTP chain testing, configure the following in `.env` **before opening the browser**, then set `CLAIRVEIL_DAPP_LOCAL_TEST_MODE=1` and your loopback endpoints. Keep `CLAIRVEIL_DAPP_HOST=127.0.0.1`.

```bash
# Replace both absolute paths. Use a separate disposable test keyring/home.
CLAIRVEILD_BIN=/absolute/path/to/chain-cli
CLAIRVEIL_HOME=/absolute/path/to/disposable-test-home
CLAIRVEIL_LOCAL_SIGNER_BIN=/absolute/path/to/chain-cli
CLAIRVEIL_LOCAL_SIGNER_HOME=/absolute/path/to/disposable-test-home
CLAIRVEIL_LOCAL_SIGNER_KEYRING=test
CLAIRVEIL_DAPP_LOCAL_TEST_MODE=1
```

Local EVM mode is not a wallet-only connection mode: during page bootstrap, if no recognized local signer is returned, the browser requests `/api/local-signers/ensure`. The server then attempts to recover missing `dev0`–`dev3` accounts from bundled public test mnemonics. A CLI lookup failure also appears as an empty account list and can trigger this path. Merely avoiding the local helper buttons does not prevent it.

Specify both the general CLI/home and the local signer CLI/home so helpers do not fall back to `clairveild` or an existing Core home. Use absolute paths; CLI commands run with the sibling Core checkout as their working directory. Do not point these variables at a personal or production keyring, or fund the bundled public keys with real assets. Do not use empty-string overrides: the server treats them as configured values.

The target CLI must support `keys list`, `keys add --recover --algo eth_secp256k1`, the `test` keyring backend, and any local transaction helpers you use. Account names alone do not establish funding or chain authorization. If local key setup fails, browser bootstrap can fail before MetaMask connection; correct the CLI/home compatibility before retrying. The environment variables are also listed in [.env.evm.example](../.env.evm.example) and [.env.example](../.env.example).

For an arbitrary chain without these compatible local helpers, use the HTTPS endpoint mode (`CLAIRVEIL_DAPP_LOCAL_TEST_MODE=0`) instead; that skips automatic signer setup. There is currently no separate environment switch for local HTTP wallet-only mode. Fund wallet tests through the chain's own faucet.

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

1. Use a browser with MetaMask. Check the profile name, chain ID, advancing height, and REST Online.
2. Wait for protocol validation, then Connect MetaMask to the intended network/account. `v0.3.1 ready` identifies the wallet contract, not the chain release.
3. Complete Setup Clairveil, fund through the chain's faucet, refresh balance, and satisfy chain-specific account authorization.
4. Deposit a small amount in the input's displayed unit. Verify proof, signing, transaction inclusion, and note recovery. Then Transfer to another wallet, Scan, and Withdraw.

Health/protocol checks do not prove transaction completion. For failures, check browser endpoint reachability, CORS, HTTPS, prover readiness/contract, and fee units. Remote provers require HTTPS; HTTP is only for loopback testing. Another device's 127.0.0.1 does not refer to your chain computer. Reconcile an unresolved transaction's existing hash before another submission.
