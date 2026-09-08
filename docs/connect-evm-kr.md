# 실행 중인 EVM 체인에 웹 연결하기

[README](../README-kr.md) · [English](connect-evm.md)

체인은 해당 저장소의 방법대로 실행하세요. 이 가이드는 이미 실행 중인 Clairveil 호환 체인에 환경변수로 samples 웹을 연결하는 방법입니다. JSON을 수정할 필요가 없습니다.

## 1. 환경변수 예제 복사

[.env.evm.example](../.env.evm.example)을 사용합니다. SDK/의존성 설치는 README를 따르세요. Samples 루트에서:

```bash
cp .env.evm.example .env
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
| EIP-155 ID (`eth_chainId`) | `CLAIRVEIL_EVM_CHAIN_ID` |
| EVM RPC | `CLAIRVEIL_EVM_RPC` |
| EVM-derived host account prefix | `CLAIRVEIL_EVM_PRIVACY_ACCOUNT_PREFIX` |
| Privacy precompile address | `CLAIRVEIL_EVM_PRIVACY_PRECOMPILE` |
| Deposit mode / native denom | `CLAIRVEIL_EVM_DEPOSIT_MODE`, `CLAIRVEIL_EVM_NATIVE_DENOM` |
| Exact EVM deposit provider | `CLAIRVEIL_EVM_DEPOSIT_PROOF_URL` |

예제의 chain ID, URL, prefix, decimals, gas 값은 모두 실제 체인 값으로 교체합니다. 같은 `u` 접두사라도 decimals가 같다고 가정하지 마세요.
`CHAIN_ID`는 host chain 문자열 ID이고 `CLAIRVEIL_EVM_CHAIN_ID`는 MetaMask의 EIP-155 ID입니다(예: 4660 = 0x1234). 같은 체인을 가리켜야 합니다. `payable-exact-value`는 privacy denom과 native denom이 같아야 합니다. Precompile과 mode는 체인이 공개한 값을 사용하세요. CLI 내장 proving은 브라우저 HTTP prover를 제공하지 않습니다. EVM-compatible deposit provider를 별도로 설정하고 Cosmos deposit route와 같다고 가정하지 마세요.

예제는 공개 HTTPS 체인 연결용으로 local helper를 끈 상태입니다. `CLAIRVEIL_DAPP_PUBLIC_ORIGIN`에 실제 배포 웹의 HTTPS origin을 넣으세요. Node 서버는 HTTP로 listen하므로 공개 배포에서는 해당 origin의 HTTPS reverse proxy로 연결합니다.

로컬 HTTP 체인을 테스트하려면 **브라우저를 열기 전에** 아래 값을 `.env`에 설정하고, endpoint를 실제 loopback 주소로 바꾸세요. `CLAIRVEIL_DAPP_HOST=127.0.0.1`을 유지합니다.

```bash
# 두 absolute path를 실제 경로로 교체. 별도 폐기 가능한 test keyring/home 사용.
CLAIRVEILD_BIN=/absolute/path/to/chain-cli
CLAIRVEIL_HOME=/absolute/path/to/disposable-test-home
CLAIRVEIL_LOCAL_SIGNER_BIN=/absolute/path/to/chain-cli
CLAIRVEIL_LOCAL_SIGNER_HOME=/absolute/path/to/disposable-test-home
CLAIRVEIL_LOCAL_SIGNER_KEYRING=test
CLAIRVEIL_DAPP_LOCAL_TEST_MODE=1
```

로컬 EVM 모드는 wallet 연결만 하는 모드가 아닙니다. 페이지 bootstrap에서 인식 가능한 local signer가 없으면 브라우저가 `/api/local-signers/ensure`를 호출하고, 서버가 공개된 test mnemonic으로 누락된 `dev0`–`dev3` 계정 복구를 시도합니다. CLI 조회 실패도 빈 계정 목록으로 처리되므로 이 경로를 실행할 수 있습니다. Local helper 버튼을 누르지 않아도 발생합니다.

일반 CLI/home과 local signer CLI/home을 모두 지정하여 `clairveild`나 기존 Core home으로 fallback하지 않게 하세요. CLI 명령은 형제 Core checkout을 작업 디렉터리로 사용하므로 absolute path를 넣습니다. 개인·운영 keyring을 지정하거나 공개 test key에 실제 자산을 보내지 마세요. 빈 문자열은 명시된 값으로 처리되므로 사용하지 않는 override는 빈 값 대신 생략합니다.

대상 CLI는 `keys list`, `keys add --recover --algo eth_secp256k1`, `test` keyring backend 및 사용할 local transaction helper 명령을 지원해야 합니다. 계정 이름만 있다고 funding이나 체인 권한이 준비된 것은 아닙니다. Local key setup 실패 시 MetaMask 연결 전에 bootstrap부터 실패할 수 있으므로 CLI/home 호환성을 먼저 확인하세요. 변수는 [.env.evm.example](../.env.evm.example)과 [.env.example](../.env.example)에도 설명되어 있습니다.

이 local helper를 지원하지 않는 체인은 HTTPS endpoint 모드(`CLAIRVEIL_DAPP_LOCAL_TEST_MODE=0`)로 연결하세요. 이 모드는 자동 signer setup을 건너뜁니다. 현재 local HTTP에서 wallet 연결만 허용하는 별도 환경변수는 없습니다. Wallet 테스트 자금은 해당 체인 faucet에서 준비하세요.

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

1. MetaMask가 설치된 브라우저에서 profile 이름, chain ID, 증가하는 block height, REST Online을 확인합니다.
2. Protocol 검사를 기다린 뒤 Connect MetaMask에서 의도한 network/account를 연결합니다. `v0.3.1 ready`는 wallet contract 표시이며 chain 릴리스 버전이 아닙니다.
3. Setup Clairveil을 완료하고 체인 faucet에서 자금을 받은 뒤 잔액을 갱신합니다. 체인별 계정 권한 조건도 충족해야 합니다.
4. 입력창 옆 단위로 소액 Deposit하여 proof·서명·transaction 포함·note 복구를 확인합니다. 다른 wallet으로 Transfer, Scan, Withdraw도 검증합니다.

Health/protocol 성공은 거래 완료 검증이 아닙니다. 오류 시 브라우저의 endpoint 접근성, CORS, HTTPS, prover 준비 상태와 contract, 수수료 단위부터 확인하세요. Remote prover는 HTTPS가 필요하고 HTTP는 loopback 테스트용입니다. 다른 기기의 127.0.0.1은 체인 컴퓨터가 아닙니다. 미해결 tx는 기존 hash를 reconcile한 뒤 새 제출을 진행합니다.
