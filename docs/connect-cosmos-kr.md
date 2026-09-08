# 실행 중인 Cosmos 체인에 웹 연결하기

[README](../README-kr.md) · [English](connect-cosmos.md)

체인은 해당 저장소의 방법대로 실행하세요. 이 가이드는 이미 실행 중인 Clairveil 호환 체인에 환경변수로 samples 웹을 연결하는 방법입니다. JSON을 수정할 필요가 없습니다.

## 1. 환경변수 예제 복사

[.env.cosmos.example](../.env.cosmos.example)을 사용합니다. SDK/의존성 설치는 README를 따르세요. Samples 루트에서:

```bash
cp .env.cosmos.example .env
```

기존 `.env`가 있으면 먼저 백업하세요. 복사본 `.env`를 열어 아래 체인 정보와 endpoint를 채웁니다. Example 파일은 재사용하도록 유지합니다.

## 2. 체인 정보 입력

| 체인 정보 | 환경변수 |
| --- | --- |
| Host RPC /status의 network ID | `CHAIN_ID` |
| Host CometBFT HTTP(S) RPC / Cosmos REST | `CLAIRVEIL_RPC`, `CLAIRVEIL_REST` |
| Prover base URL | `CLAIRVEIL_PROVER_URL` |
| 최소 denom / 표시 symbol / decimals | `CLAIRVEIL_DENOM`, `CLAIRVEIL_DISPLAY_DENOM`, `CLAIRVEIL_COIN_DECIMALS` |
| Host account / shielded prefix | `CLAIRVEIL_ACCOUNT_PREFIX`, `CLAIRVEIL_SHIELDED_PREFIX` |
| Coin type | `CLAIRVEIL_COSMOS_COIN_TYPE` |
| Gas prices (minimal denom/gas) | `CLAIRVEIL_KEPLR_GAS_LOW`, `CLAIRVEIL_KEPLR_GAS_AVERAGE`, `CLAIRVEIL_KEPLR_GAS_HIGH` |
| Optional exact canonical deposit URL | `CLAIRVEIL_COSMOS_DEPOSIT_PROOF_URL` |

예제의 chain ID, URL, prefix, decimals, gas 값은 모두 실제 체인 값으로 교체합니다. 같은 `u` 접두사라도 decimals가 같다고 가정하지 마세요.
서버가 환경변수에서 `keplrChainInfo`를 생성하므로 중복 JSON을 작성할 필요가 없습니다. Gas price는 display token이 아닌 최소 denom/gas입니다. 예를 들어 decimals 6이면 1 TOKEN은 1,000,000 utoken이고 gas price 0.025는 0.025 utoken/gas입니다. 기본 Keplr 메타정보는 같은 asset의 fee/staking 및 일반적인 Bech32 suffix를 사용하므로 체인 메타정보와 일치하는지 확인하세요. Cosmos deposit은 prover base의 `/v1/prover/deposit`을 사용하며 별도 canonical 서비스는 exact URL로 지정합니다.

예제는 공개 HTTPS 체인 연결용으로 local helper를 끈 상태입니다. `CLAIRVEIL_DAPP_PUBLIC_ORIGIN`에 실제 배포 웹의 HTTPS origin을 넣으세요. Node 서버는 HTTP로 listen하므로 공개 배포에서는 해당 origin의 HTTPS reverse proxy로 연결합니다.

로컬 HTTP 체인을 내 컴퓨터에서 테스트할 때는 `CLAIRVEIL_DAPP_LOCAL_TEST_MODE=1`, host는 `127.0.0.1`로 두고 endpoint를 실제 loopback 주소로 바꾸세요. 이 모드에서는 local signer/faucet/admin 기능도 켜집니다. 해당 기능은 별도 chain CLI·home·test key 설정이 필요하므로 자동으로 타 체인에 호환된다고 가정하지 말고, wallet 테스트 자금은 해당 체인 faucet에서 준비하세요. 고급 helper 설정은 [.env.example](../.env.example)을 참고합니다.

## 3. 웹 실행

`.env`는 자동 로드되지 않습니다. 새 터미널에서 samples 루트로 이동한 뒤:

```bash
set -a
source .env
set +a
npm start
```

기본 로컬 접속 주소는 http://127.0.0.1:5173/ 입니다. 포트 충돌 시 `CLAIRVEIL_DAPP_PORT`를 변경하세요. 환경변수 변경 후 서버를 재시작하고 브라우저를 새로고침합니다. Cosmos/EVM 전환 시 이전 export가 남지 않도록 새 shell에서 선택한 예제를 로드하세요.

브라우저는 서버의 `/api/health` 응답의 `config` 필드를 읽습니다. `/api/config`에서 생성된 profile을 확인할 수 있습니다. 이 방식에서 `public/dapp-config.json`은 수정하지 않습니다. Python 정적 서버는 환경변수를 읽지 않으므로 위 `npm start`를 사용합니다.

## 4. 연결 확인과 테스트

1. Keplr가 설치된 브라우저에서 profile 이름, chain ID, 증가하는 block height, REST Online을 확인합니다.
2. Protocol 검사를 기다린 뒤 Connect Keplr에서 의도한 network/account를 연결합니다. `v0.3.1 ready`는 wallet contract 표시이며 chain 릴리스 버전이 아닙니다.
3. Setup Clairveil을 완료하고 체인 faucet에서 자금을 받은 뒤 잔액을 갱신합니다. 체인별 계정 권한 조건도 충족해야 합니다.
4. 입력창 옆 단위로 소액 Deposit하여 proof·서명·transaction 포함·note 복구를 확인합니다. 다른 wallet으로 Transfer, Scan, Withdraw도 검증합니다.

Health/protocol 성공은 거래 완료 검증이 아닙니다. 오류 시 브라우저의 endpoint 접근성, CORS, HTTPS, prover 준비 상태와 contract, 수수료 단위부터 확인하세요. Remote prover는 HTTPS가 필요하고 HTTP는 loopback 테스트용입니다. 다른 기기의 127.0.0.1은 체인 컴퓨터가 아닙니다. 미해결 tx는 기존 hash를 reconcile한 뒤 새 제출을 진행합니다.
