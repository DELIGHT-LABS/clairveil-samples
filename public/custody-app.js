import { createCustodyProvider, createDirectBridgeTransport } from 'clairveiljs/custody-provider';
import { createClairveilDappClient, createArtifactVerifier } from 'clairveiljs/dapp';
import { createLocalCustodyBridge } from './custody-bridge.js';
import { createCustodySession } from './custody-session.js';
import { custodyActions } from './custody-state.js';
import { createCustodyWallet, watchCustodyWallet, broadcastCustodyCosmos } from './custody-wallet.js';
import { fetchBoundedJson } from './bounded-json-fetch.js';

const $ = id => document.getElementById(id);
const labels = { created: '요청 접수', awaiting_approval: '커스터디 승인 대기', preparing: '증명 준비 중',
  awaiting_chain_signature: '일반 지갑 서명 대기', submission_unknown: '제출 결과 확인 필요', submitted: '체인 확인 대기',
  confirmed: '입금 확인 완료', completed: '연결 승인 완료', cancelled: '취소됨', failed: '실패 — 작업창 확인 필요' };
let profiles, session, provider, bridge, cleanWalletEvents = () => {}, pollAt = 0;
const selection = () => profiles[$('network').value];
function render(state = session?.state) {
  if (!state) return;
  const disabled = state.busy || state.invalidated;
  const actions = custodyActions(state);
  $('network').disabled = state.busy || Boolean(state.actor);
  $('wallet').disabled = disabled || Boolean(state.actor);
  $('copyActor').disabled = !state.actor;
  $('connect').disabled = disabled || !actions.connect;
  $('disconnect').disabled = disabled || !state.connection;
  $('deposit').disabled = disabled || !actions.deposit;
  $('submit').disabled = disabled || !actions.submit;
  $('cancel').disabled = disabled || !actions.cancel;
  $('reconcile').disabled = disabled || !actions.reconcile;
  $('walletAddress').textContent = state.actor?.address ?? '아직 연결하지 않았습니다';
  $('actorJson').value = state.actor ? JSON.stringify(state.actor) : '';
  $('custodyStatus').textContent = state.invalidated ? '연결 무효화됨' : state.connection ? '승인됨 · 입금 권한' : state.capabilities ? '승인 대기' : '미연결';
  $('operationState').textContent = labels[state.operation?.state] ?? '입금 요청 전';
  $('operationId').textContent = state.operation?.operationId ?? '—';
  $('confirmed').hidden = state.operation?.state !== 'confirmed';
  $('error').textContent = state.error || (state.uncertain ? '요청 결과가 불명확합니다. 같은 요청을 다시 보내지 말고 커스터디 작업창을 확인하세요.' : '');
  $('error').hidden = !$('error').textContent;
  const phase = state.operation?.kind === 'deposit' ? state.operation.state : '';
  for (const [id, states] of Object.entries({ stepApproval: ['preparing', 'awaiting_chain_signature', 'submission_unknown', 'submitted', 'confirmed'],
    stepWallet: ['submitted', 'confirmed'], stepChain: ['confirmed'] })) $(id).classList.toggle('done', states.includes(phase));
}
function showError(message) { $('error').textContent = message; $('error').hidden = false; }
function invoke(action) { return Promise.resolve().then(action).catch(error => showError(session?.state.error || error.message)); }

function setupSession() {
  cleanWalletEvents(); session?.dispose(); provider?.dispose(); bridge?.close();
  const profile = selection();
  $('denom').textContent = profile.denom; $('chain').textContent = profile.caip;
  $('wallet').textContent = profile.transport === 'cosmos' ? 'Keplr 연결' : 'MetaMask 연결';
  bridge = createLocalCustodyBridge(window);
  provider = createCustodyProvider({ transport: createDirectBridgeTransport({ exchange: bridge.exchange }), subscribeInvalidation: bridge.subscribe, timeoutMs: 12000 });
  const wallet = createCustodyWallet(profile);
  const client = createClairveilDappClient({ custodyProvider: provider, chainWallet: wallet,
    validateArtifact: createArtifactVerifier({ profileDigest: profile.profileDigest, chainId: profile.caip, assetDenom: profile.denom,
      ...(profile.contract ? { contractAddress: profile.contract, protocolChainId: profile.chainId } : {}) }),
    broadcastCosmos: broadcastCustodyCosmos
  });
  session = createCustodySession({ client, provider, wallet, profile, checkAvailability: bridge.probe, onChange: render }); render();
}

$('wallet').onclick = () => invoke(async () => {
  await session.connectWallet();
  cleanWalletEvents = watchCustodyWallet(window, () => session.invalidate());
});
$('copyActor').onclick = () => invoke(async () => { await navigator.clipboard.writeText($('actorJson').value); $('copyActor').textContent = '복사됨'; });
$('connect').onclick = () => invoke(() => session.connectCustody());
$('disconnect').onclick = () => invoke(() => session.disconnect());
$('deposit').onclick = () => invoke(() => session.deposit($('amount').value));
$('submit').onclick = () => invoke(() => session.submit());
$('cancel').onclick = () => invoke(() => session.cancel());
$('reconcile').onclick = () => invoke(() => session.reconcile());
$('network').onchange = setupSession;

try {
  if (location.origin !== 'http://127.0.0.1:4320') throw new Error('로컬 커스터디 미리보기는 http://127.0.0.1:4320/custody.html 에서 실행하세요.');
  profiles = await fetchBoundedJson('/custody-profiles.json', { maxBytes: 16384, timeoutMs: 5000 });
  setupSession();
} catch { showError('미리보기 설정을 읽지 못했습니다. npm run start:custody로 실행하고 http://127.0.0.1:4320/custody.html 을 여세요.'); }

setInterval(() => {
  const state = session?.state;
  if (!state || state.busy || state.invalidated || !custodyActions(state).poll || Date.now() - pollAt < 1500) return;
  pollAt = Date.now(); void invoke(() => session.refresh());
}, 1700);
window.addEventListener('pagehide', () => { cleanWalletEvents(); session?.dispose(); provider?.dispose(); bridge?.close(); });
