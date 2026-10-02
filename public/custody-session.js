import { custodyActions, canResetCustodySession } from './custody-state.js';
import { normalizeDisclosureHash } from './sample-event-disclosure.js';
import { validateWalletParams } from '@clairveil/custody-sdk/wallet-api';

export const depositMethods = ['getCapabilities', 'connect', 'disconnect', 'getOperation', 'cancelOperation',
  'prepareDeposit', 'beginSubmission', 'recordSubmission', 'reconcile'].map(name => `clairveil_${name}`);
export const fullFlowMethods = ['getPublicAccount', 'getBalances', 'authorizeTransfer', 'authorizeWithdraw', 'requestDisclosure'].map(name => `clairveil_${name}`);
const base = { protocolVersion: '1', schemaRevision: 'draft', binding: 'clairveil-draft' };
const handle = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const sameActor = (a, b) => a && b && ['namespace', 'chainId', 'address', 'pubKeyHex'].every(key => a[key] === b[key]);
const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});

export function createCustodySession({ client, provider, wallet, profile, onChange = () => {} }) {
  const state = { actor: null, capabilities: null, connection: null, operation: null, busy: false,
    invalidated: false, uncertain: false, submissionAttempted: false, balances: null, publicAccount: null, activeOperation: null, withdrawalPreparation: null, recoveryRequired: false, error: '' };
  let revision = 0, disposed = false, requestedPermissions = [], recoveryAccess;
  const snapshots = new Map(), submitted = new Set();
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
    revision++; state.invalidated = true; state.connection = null; state.balances = null; state.publicAccount = null; state.activeOperation = null;
    if (state.operation) {
      const { disclosureResult: _disclosure, publicArtifact: _artifact, ...publicStatus } = state.operation;
      state.operation = publicStatus;
    }
    state.error = '연결이 만료되었거나 지갑이 변경되었습니다. 새 서명을 중단했습니다. 미확정 작업을 다시 제출하지 마세요.'; notify();
  };
  const unsubscribe = provider.onInvalidation(invalidate);
  async function run(work, { disconnecting = false } = {}) {
    if (state.busy) throw new Error('이전 요청을 처리 중입니다.');
    current(revision); const stamp = revision;
    state.busy = true; state.error = ''; notify();
    try { const result = await work(() => current(stamp)); if (!disconnecting) current(stamp); return result; }
    catch (error) {
      if (state.connection && [4103, 4104].includes(error?.code)) provider.invalidate();
      state.error = error?.code === 4112
        ? '커스터디 응답 시간이 초과됐거나 요청 제한에 걸렸습니다. 작업창 상태를 확인하세요. 결과가 불명확한 연결·입금·서명 요청은 다시 제출하지 마세요.'
        : error?.code === 4104 ? '커스터디 작업창에서 금고를 생성하거나 잠금을 해제하고 백업을 검증하세요.'
        : error?.code === 4105 ? '금고가 복구 제한 상태입니다. 지원하는 프로필의 새 입금은 별도 승인 후 가능하지만 기존·새 노트의 지출은 제한됩니다. 백업 검증이나 스캔만으로는 이 제한이 해제되지 않습니다. 확장 작업창에서 입금 가능 여부와 복구 차단 사유를 확인하세요.'
        : error?.code === 4114 ? '커스터디 작업창에서 독립 백업 검증을 완료하세요.'
        : error?.code === -32602 && !state.uncertain ? '요청 입력 형식이 올바르지 않습니다. 복구 ID나 수신 주소를 확인하고 다시 요청하세요.'
        : typeof error?.code === 'number' ? `커스터디 요청 오류 (${error.code}). 작업창과 요청 상태를 확인하세요.` : error.message;
      if (error?.code === 4105) state.recoveryRequired = true;
      throw error;
    }
    finally { state.busy = false; notify(); }
  }
  async function checkActor(check) {
    const actor = await wallet.getActor(); check();
    if (!sameActor(state.actor, actor)) { provider.invalidate(); throw new Error('일반 지갑의 계정 또는 체인이 변경되었습니다.'); }
  }
  function accepted(value, kind) {
    state.uncertain = false; state.operation = { ...value, kind }; state.activeOperation = null; state.submissionAttempted = false;
    state.withdrawalPreparation = null;
  }
  function applySnapshot(value, id) {
    if (value.operationId !== id) throw new Error('응답 작업이 요청과 다릅니다.');
    const previous = snapshots.get(id);
    if (previous && typeof previous.statusRevision === 'string' && typeof value.statusRevision === 'string'
      && BigInt(value.statusRevision) <= BigInt(previous.statusRevision)) return previous;
    snapshots.set(id, value);
    if (value.runtimeState === 'recovery_required' || value.accessMode === 'recovery-only') state.recoveryRequired = true;
    return value;
  }
  const selected = () => state.activeOperation || state.operation;
  const actorHandle = () => {
    const actor = state.connection.chainActors.find(value => value.accountId === accountId());
    if (!actor) throw new Error('승인된 일반 지갑이 없습니다.');
    return actor.chainActorHandle;
  };
  const amountCheck = amount => {
    if (typeof amount !== 'string' || !/^[1-9][0-9]{0,19}$/.test(amount) || BigInt(amount) > (1n << 64n) - 1n)
      throw new Error('최소 단위 1~18446744073709551615 사이의 정수로 입력하세요.');
  };
  async function authorize(kind, amount, options, check) {
    amountCheck(amount);
    if (!custodyActions(state)[kind]) throw new Error('기존 작업, 공개 계정 조회와 승인 권한을 먼저 확인하세요.');
    await checkActor(check);
    // Local request validity leaves room below the pinned host's 1800-second
    // canonical-chain bound; the host still validates chain time independently.
    const protocol = { assetDenom: profile.denom, amountBaseUnits: amount, expiresAtUnix: String(Math.floor(Date.now() / 1000) + 600),
      ...(kind === 'transfer' ? { recipientShieldedAddress: options.recipientShieldedAddress || state.publicAccount.protocol.shieldedAddress,
        disclosure: options.disclosure ?? (options.publicDisclosure ? { policy: 'amount', mode: 'public' } : { policy: 'all-private', mode: 'none' }), selfViewEnabled: options.selfViewEnabled !== false }
        : { recipientAddress: options.recipientAddress || state.actor.address }) };
    const method = kind === 'transfer' ? 'authorizeTransfer' : 'authorizeWithdraw';
    // The provider validates before dispatch too. Validate the same snapshot here
    // before fencing unknown replies so a local input error remains correctable.
    const params = validateWalletParams(`clairveil_${method}`, { ...base, ...context(),
      idempotencyKey: handle(), chainActorHandle: actorHandle(), protocol,
      privacyConstraints: { allowRemoteWitness: true, allowPublicChainActor: true } });
    state.balances = null; state.uncertain = true;
    const result = await client[method](params);
    check(); accepted(result, kind);
    if (kind === 'withdraw') state.withdrawalPreparation = {
      withdrawOperationId: result.operationId, amountBaseUnits: amount, recipientAddress: protocol.recipientAddress
    };
  }
  return {
    get state() { return { ...state }; },
    connectWallet: () => run(async check => {
      if (state.actor) throw new Error('이미 연결된 일반 지갑입니다.');
      const actor = await wallet.connect(); check();
      if (actor.namespace !== (profile.transport === 'cosmos' ? 'cosmos' : 'eip155') || actor.chainId !== (profile.transport === 'cosmos' ? profile.chainId : profile.evmChainId)) throw new Error('선택한 로컬 체인과 지갑이 일치하지 않습니다.');
      state.actor = actor; return actor;
    }),
    connectCustody: ({ readBalances = false, fullFlow = false, recoveryOperationIds = [] } = {}) => run(async check => {
      if (!custodyActions(state).connect) throw new Error('먼저 일반 지갑을 연결하세요. 기존 연결 요청은 다시 보내지 않습니다.');
      const caps = await client.getCapabilities({ protocolVersion: '1' }); check();
      if (!depositMethods.every(method => caps.methods.includes(method))) throw new Error('커스터디 작업창에서 금고와 백업을 준비하고 선택한 로컬 체인을 신뢰·활성화하세요. 입금 RPC가 아직 활성화되지 않았습니다.');
      if (!caps.networks.some(network => network.networkId === profile.id && network.chainId === profile.caip && network.profileDigest === profile.profileDigest)) throw new Error('커스터디와 샘플의 네트워크 프로필이 다릅니다. 같은 미리보기로 다시 빌드하세요.');
      if (fullFlow && !fullFlowMethods.every(method => caps.methods.includes(method))) throw new Error('이 호스트는 전체 흐름 RPC를 지원하지 않습니다.');
      if (recoveryOperationIds.length && (recoveryOperationIds.length > 16 || recoveryOperationIds.some(id => !/^[A-Za-z0-9_-]{43}$/.test(id)))) throw new Error('작업창의 공개 작업 ID를 정확히 입력하세요.');
      if (readBalances && !caps.methods.includes('clairveil_getBalances')) throw new Error('이 호스트는 잔액 조회를 지원하지 않습니다.');
      state.capabilities = caps;
      await checkActor(check);
      requestedPermissions = recoveryOperationIds.length ? [] : ['deposit.request', ...(readBalances || fullFlow ? ['balance.read'] : []),
        ...(fullFlow ? ['account.read', 'transfer.request', 'withdraw.request', 'disclosure.request'] : [])];
      recoveryAccess = recoveryOperationIds.length ? { operationIds: [...recoveryOperationIds], methods: ['clairveil_getOperation', 'clairveil_reconcile', 'clairveil_cancelOperation'] } : undefined;
      const params = validateWalletParams('clairveil_connect', { ...base, idempotencyKey: handle(), networkId: profile.id,
        permissions: requestedPermissions, ...(recoveryAccess ? { recoveryAccess } : { chainActor: { accountId: accountId(), ...(state.actor.namespace === 'cosmos' ? { publicKeyHex: state.actor.pubKeyHex } : {}) } }), protocol: { publicAccountFields: fullFlow && !recoveryAccess ? ['shieldedAddress'] : [] } });
      state.uncertain = true;
      const result = await client.connect(params);
      check(); accepted(result, 'connect');
    }),
    refresh: () => run(async check => {
      if (!state.operation) return;
      const id = state.operation.operationId;
      const value = await client.getOperation({ ...base, ...(state.operation.kind === 'connect' ? {} : context()), operationId: id });
      check(); const op = applySnapshot(value, id);
      if (op.kind === 'connect' && op.state === 'completed') {
        if (canonical([...requestedPermissions].sort()) !== canonical([...(op.connection?.permissions ?? [])].sort())
          || (!recoveryAccess && !op.connection.chainActors.some(actor => actor.accountId === accountId()))
          || canonical(op.connection.recoveryAccess) !== canonical(recoveryAccess)) throw new Error('승인된 일반 지갑 또는 권한이 요청과 다릅니다.');
        state.connection = op.connection;
      }
      state.operation = op; state.activeOperation = null;
      if (op.kind === 'transfer') {
        const step = op.steps?.find(item => !['confirmed', 'cancelled'].includes(item.state)) || op.steps?.at(-1);
        if (step && (!state.connection.recoveryAccess || state.connection.recoveryAccess.operationIds.includes(step.operationId))) {
          const value = await client.getOperation({ ...base, ...context(), operationId: step.operationId });
          check(); const child = applySnapshot(value, step.operationId);
          if (child.parentOperationId !== op.operationId) throw new Error('전송 단계의 상위 작업이 다릅니다.');
          state.activeOperation = child;
        }
      }
      state.submissionAttempted = submitted.has(selected()?.operationId);
    }),
    publicAccount: () => run(async check => {
      if (!state.connection?.permissions.includes('account.read')) throw new Error('공개 계정 조회 권한이 필요합니다.');
      state.publicAccount = null;
      const result = await client.getPublicAccount({ ...base, ...context() }); check(); state.publicAccount = result;
    }),
    transfer: (amount, options = {}) => run(check => authorize('transfer', amount, options, check)),
    withdraw: (amount, options = {}) => run(check => authorize('withdraw', amount, options, check)),
    prepareWithdrawNote: () => run(async check => {
      if (!custodyActions(state).prepareWithdraw) throw new Error('정확한 금액의 노트가 필요하다고 확인된 출금만 준비할 수 있습니다.');
      const intent = { ...state.withdrawalPreparation };
      const account = await client.getPublicAccount({ ...base, ...context() }); check();
      state.publicAccount = account;
      await authorize('transfer', intent.amountBaseUnits, { recipientShieldedAddress: account.protocol.shieldedAddress,
        disclosure: { policy: 'all-private', mode: 'none' }, selfViewEnabled: true }, check);
      state.withdrawalPreparation = { ...intent, transferOperationId: state.operation.operationId };
    }),
    resumeWithdraw: () => run(async check => {
      if (!custodyActions(state).resumeWithdraw) throw new Error('노트 준비 전송 전체가 확인된 뒤 출금을 다시 승인하세요.');
      const intent = { ...state.withdrawalPreparation };
      await authorize('withdraw', intent.amountBaseUnits, { recipientAddress: intent.recipientAddress }, check);
    }),
    disclosure: ({ transactionHash, plane = 'self_view', delivery = 'page', requestedFields = ['amount'] }) => run(async check => {
      if (!custodyActions(state).disclosure) throw new Error('기존 작업과 공개 요청 권한을 확인하세요.');
      const normalizedHash = normalizeDisclosureHash(transactionHash, profile.transport);
      if (!normalizedHash || !['user', 'self_view'].includes(plane) || !['page', 'trusted-wallet'].includes(delivery)) throw new Error('거래 해시·공개 영역·전달 대상을 확인하세요.');
      const params = validateWalletParams('clairveil_requestDisclosure', { ...base, ...context(), idempotencyKey: handle(),
        requestedFields, delivery, protocol: { transactionHash: normalizedHash, plane } });
      state.uncertain = true;
      const result = await client.requestDisclosure(params);
      check(); accepted(result, 'disclosure');
    }),
    inspectRecovery: operationId => run(async check => {
      if (!state.connection?.recoveryAccess?.operationIds.includes(operationId)) throw new Error('새로 승인한 복구 범위의 작업 ID만 조회할 수 있습니다.');
      const value = await client.getOperation({ ...base, ...context(), operationId }); check();
      state.operation = applySnapshot(value, operationId); state.activeOperation = null; state.submissionAttempted = true;
    }),
    deposit: amount => run(async check => {
      amountCheck(amount);
      if (!custodyActions(state).deposit) throw new Error('기존 작업을 먼저 확인하세요.');
      state.balances = null;
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
      await checkActor(check); state.submissionAttempted = true; submitted.add(selected().operationId);
      return client.submit({ operation: selected(), actor: state.actor, context: context(), idempotencyKey: handle(),
        networkProfileDigest: profile.profileDigest, chainActorAccountId: accountId() });
    }),
    balances: () => run(async check => {
      if (!state.connection?.permissions.includes('balance.read')) throw new Error('잔액 조회 권한을 먼저 승인하세요.');
      state.balances = null; notify();
      const result = await client.getBalances({ ...base, ...context(), protocol: { assets: [profile.denom] } });
      check(); state.balances = result;
    }),
    reconcile: () => run(async () => {
      if (!custodyActions(state).reconcile) throw new Error('제출 상태를 먼저 조회하세요.');
      return client.reconcile({ ...base, ...context(), operationId: selected().operationId, idempotencyKey: handle() });
    }),
    cancel: () => run(async check => {
      if (!custodyActions(state).cancel) throw new Error('승인 전 입금 요청만 여기서 취소할 수 있습니다.');
      const result = await client.cancelOperation({ ...base, ...context(), operationId: state.operation.operationId, idempotencyKey: handle() });
      check(); state.operation = result.operation;
    }),
    disconnect: async () => {
      if (!canResetCustodySession(state)) throw new Error('미확정 커스터디 작업을 먼저 확인하세요. 작업 ID와 제출 상태를 유지합니다.');
      if (state.invalidated || !state.connection) { provider.invalidate(); return; }
      return run(() => client.disconnect({ ...base, sessionHandle: state.connection.sessionHandle }), { disconnecting: true });
    },
    invalidate() { provider.invalidate(); },
    dispose() { disposed = true; revision++; unsubscribe(); }
  };
}
