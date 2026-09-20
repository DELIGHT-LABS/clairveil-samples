import { custodyActions } from './custody-state.js';

export const depositMethods = ['getCapabilities', 'connect', 'disconnect', 'getOperation', 'cancelOperation',
  'prepareDeposit', 'beginSubmission', 'recordSubmission', 'reconcile'].map(name => `clairveil_${name}`);
const base = { protocolVersion: '1', schemaRevision: 'draft', binding: 'clairveil-draft' };
const handle = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const sameActor = (a, b) => a && b && ['namespace', 'chainId', 'address', 'pubKeyHex'].every(key => a[key] === b[key]);

export function createCustodySession({ client, provider, wallet, profile, checkAvailability = async () => ({ workbench: 'ready' }), onChange = () => {} }) {
  const state = { actor: null, capabilities: null, connection: null, operation: null, busy: false,
    invalidated: false, uncertain: false, submissionAttempted: false, error: '' };
  let revision = 0, disposed = false;
  const notify = () => onChange({ ...state });
  const context = () => {
    if (!state.connection) throw new Error('커스터디 연결 승인이 필요합니다.');
    const { sessionHandle, accountHandle, networkHandle } = state.connection;
    return { sessionHandle, accountHandle, networkHandle };
  };
  const accountId = () => `${profile.caip}:${state.actor.address}`;
  const current = stamp => {
    if (disposed || state.invalidated || stamp !== revision) throw new Error('연결이 변경되었습니다. 기존 작업을 다시 제출하지 마세요.');
  };
  const invalidate = () => {
    revision++; state.invalidated = true; state.connection = null;
    state.error = '연결이 만료되었거나 지갑이 변경되었습니다. 새 서명을 중단했습니다. 미확정 작업을 다시 제출하지 마세요.'; notify();
  };
  const unsubscribe = provider.onInvalidation(invalidate);
  async function run(work) {
    if (state.busy) throw new Error('이전 요청을 처리 중입니다.');
    current(revision); const stamp = revision;
    state.busy = true; state.error = ''; notify();
    try { const result = await work(() => current(stamp)); current(stamp); return result; }
    catch (error) {
      state.error = error?.code === 4112
        ? '커스터디 응답 시간이 초과됐거나 요청 제한에 걸렸습니다. 작업창 상태를 확인하세요. 결과가 불명확한 연결·입금·서명 요청은 다시 제출하지 마세요.'
        : typeof error?.code === 'number' ? `커스터디 요청 오류 (${error.code}). 작업창과 요청 상태를 확인하세요.` : error.message;
      throw error;
    }
    finally { state.busy = false; notify(); }
  }
  async function checkActor(check) {
    const actor = await wallet.getActor(); check();
    if (!sameActor(state.actor, actor)) { provider.invalidate(); throw new Error('일반 지갑의 계정 또는 체인이 변경되었습니다.'); }
  }
  function accepted(value, kind) {
    state.uncertain = false; state.operation = { ...value, kind }; state.submissionAttempted = false;
  }
  return {
    get state() { return { ...state }; },
    connectWallet: () => run(async check => {
      if (state.actor) throw new Error('이미 연결된 일반 지갑입니다.');
      const actor = await wallet.connect(); check();
      if (actor.namespace !== (profile.transport === 'cosmos' ? 'cosmos' : 'eip155') || actor.chainId !== (profile.transport === 'cosmos' ? profile.chainId : profile.evmChainId)) throw new Error('선택한 로컬 체인과 지갑이 일치하지 않습니다.');
      state.actor = actor; return actor;
    }),
    connectCustody: () => run(async check => {
      if (!custodyActions(state).connect) throw new Error('먼저 일반 지갑을 연결하세요. 기존 연결 요청은 다시 보내지 않습니다.');
      const availability = await checkAvailability(); check();
      const guidance = {
        missing: '이 탭에서 커스터디 확장 응답을 받지 못했습니다. 같은 Chrome 프로필에 최신 미리보기 확장을 로드하고, 확장을 다시 로드한 뒤 이 웹 탭을 새로고침하세요. Codex 내장 미리보기와 다른 Chrome 프로필의 확장은 연결되지 않습니다.',
        closed: '커스터디 작업창이 닫혀 있습니다. 확장 아이콘을 눌러 작업창을 열고, 이 페이지의 공개 지갑 정보를 붙여넣어 로컬 테스트 계정을 준비하세요.',
        setup_required: '커스터디 계정 설정이 필요합니다. 이 페이지의 공개 지갑 정보를 복사해 확장 작업창에 붙여넣고 “로컬 테스트 계정 준비”를 누르세요. 작업창에 “준비 완료”가 표시된 뒤 연결을 요청하세요.',
        preparing: '커스터디 작업창에서 계정을 준비 중입니다. 체인 확인과 복구 검사가 끝나 “준비 완료”가 표시된 뒤 연결을 요청하세요.',
        failed: '커스터디 계정 준비가 실패했습니다. 작업창의 오류와 로컬 node·prover 실행 상태를 확인하세요. 아직 연결 승인 요청은 보내지 않았습니다.',
        unavailable: '커스터디 확장 연결이 끊겼습니다. 작업창 상태를 확인하세요. 진행 중인 작업이 없다면 확장과 웹 탭을 다시 로드하세요.',
        wrong_origin: 'http://127.0.0.1:4320/custody.html 에서 연결하세요.'
      };
      if (availability.workbench !== 'ready') throw new Error(guidance[availability.workbench] || '커스터디 준비 상태를 확인하지 못했습니다.');
      const caps = await client.getCapabilities({ protocolVersion: '1' }); check();
      if (!depositMethods.every(method => caps.methods.includes(method))) throw new Error('이 커스터디는 입금 RPC 전체를 지원하지 않습니다.');
      if (!caps.networks.some(network => network.networkId === profile.id && network.chainId === profile.caip && network.profileDigest === profile.profileDigest)) throw new Error('커스터디와 샘플의 네트워크 프로필이 다릅니다. 같은 미리보기로 다시 빌드하세요.');
      state.capabilities = caps;
      await checkActor(check);
      state.uncertain = true;
      const result = await client.connect({ ...base, idempotencyKey: handle(), networkId: profile.id,
        permissions: ['deposit.request'], chainActor: { accountId: accountId() }, protocol: { publicAccountFields: [] } });
      check(); accepted(result, 'connect');
    }),
    refresh: () => run(async check => {
      if (!state.operation) return;
      const op = await client.getOperation({ ...base, ...(state.operation.kind === 'connect' ? {} : context()), operationId: state.operation.operationId });
      check();
      if (op.kind === 'connect' && op.state === 'completed') {
        if (!op.connection?.permissions.includes('deposit.request') || !op.connection.chainActors.some(actor => actor.accountId === accountId())) throw new Error('승인된 일반 지갑이 요청과 다릅니다.');
        state.connection = op.connection;
      }
      state.operation = op;
    }),
    deposit: amount => run(async check => {
      if (!/^[1-9][0-9]{0,2}$/.test(amount)) throw new Error('로컬 입금은 최소 단위 1~999 사이의 정수로 입력하세요.');
      if (!custodyActions(state).deposit) throw new Error('기존 작업을 먼저 확인하세요.');
      await checkActor(check);
      const chainActor = state.connection.chainActors.find(actor => actor.accountId === accountId());
      state.uncertain = true;
      const result = await client.prepareDeposit({ ...base, ...context(), idempotencyKey: handle(), chainActorHandle: chainActor.chainActorHandle,
        protocol: { assetDenom: profile.denom, amountBaseUnits: amount, purpose: 'funding' },
        privacyConstraints: { allowRemoteWitness: true, allowPublicChainActor: true } });
      check(); accepted(result, 'deposit');
    }),
    submit: () => run(async check => {
      if (!custodyActions(state).submit) throw new Error('이미 시도했거나 서명 준비가 되지 않은 작업입니다.');
      await checkActor(check); state.submissionAttempted = true;
      return client.submit({ operation: state.operation, actor: state.actor, context: context(), idempotencyKey: handle(),
        networkProfileDigest: profile.profileDigest, chainActorAccountId: accountId() });
    }),
    reconcile: () => run(async () => {
      if (!custodyActions(state).reconcile) throw new Error('제출 상태를 먼저 조회하세요.');
      return client.reconcile({ ...base, ...context(), operationId: state.operation.operationId, idempotencyKey: handle() });
    }),
    cancel: () => run(async check => {
      if (!custodyActions(state).cancel) throw new Error('승인 전 입금 요청만 여기서 취소할 수 있습니다.');
      const result = await client.cancelOperation({ ...base, ...context(), operationId: state.operation.operationId, idempotencyKey: handle() });
      check(); state.operation = result.operation;
    }),
    disconnect: () => run(async () => {
      const { sessionHandle } = context();
      return client.disconnect({ ...base, sessionHandle });
    }),
    invalidate() { provider.invalidate(); },
    dispose() { disposed = true; revision++; unsubscribe(); }
  };
}
