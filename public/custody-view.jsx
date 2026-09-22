import React, { useEffect, useRef, useState } from 'react';
import { custodyActions } from './custody-state.js';
import { fetchBoundedJson } from './bounded-json-fetch.js';

const labels = { created: '요청 접수', awaiting_approval: '커스터디 승인 대기', preparing: '증명 준비 중',
  awaiting_chain_signature: '일반 지갑 서명 대기', submission_unknown: '제출 결과 확인 필요', submitted: '체인 확인 대기',
  confirmed: '입금 확인 완료', completed: '연결 승인 완료', cancelled: '취소됨', failed: '실패 — 작업창 확인 필요' };
const empty = { actor: null, connection: null, operation: null, busy: false, invalidated: false };
const configError = '미리보기 설정을 읽지 못했습니다. npm run start:custody로 실행하고 http://127.0.0.1:4320/custody 을 여세요.';

export async function loadCustodyProfiles() {
  if (location.origin !== 'http://127.0.0.1:4320') throw new Error(configError);
  return fetchBoundedJson('/custody-profiles.json', { maxBytes: 16384, timeoutMs: 5000 });
}

export function CustodyApp({ createRuntime, loadProfiles = loadCustodyProfiles }) {
  const [profiles, setProfiles] = useState(null);
  const [network, setNetwork] = useState('cosmos');
  const [state, setState] = useState(empty);
  const [ready, setReady] = useState(false);
  const [amount, setAmount] = useState('7');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const runtimeRef = useRef(null);
  const profile = profiles?.[network];

  useEffect(() => {
    let active = true;
    Promise.resolve().then(loadProfiles).then(value => { if (active) setProfiles(value); })
      .catch(() => { if (active) setError(configError); });
    return () => { active = false; };
  }, [loadProfiles]);

  useEffect(() => {
    if (!profile) return;
    let active = true, timer, runtime;
    setReady(false); setState(empty); setCopied(false); setError('');
    try {
      runtime = createRuntime({ profile, onChange: value => { if (active) { setState(value); setError(''); } } });
      runtimeRef.current = runtime;
      setState(runtime.session.state); setReady(true);
      timer = setInterval(() => {
        const current = runtime.session.state;
        if (!active || current.busy || current.invalidated || !custodyActions(current).poll) return;
        Promise.resolve().then(() => { if (active) return runtime.session.refresh(); })
          .catch(cause => { if (active) setError(runtime.session.state.error || cause.message); });
      }, 1700);
    } catch (cause) { setError(cause.message); }
    const stop = () => {
      if (!active) return;
      // A restored bfcache page must not retain authority or start a new request.
      setReady(false);
      active = false; clearInterval(timer); runtime?.dispose();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
    window.addEventListener('pagehide', stop);
    return () => { stop(); window.removeEventListener('pagehide', stop); };
  }, [profile, createRuntime]);

  async function invoke(action) {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setError('');
    try { await action(runtime); }
    catch (cause) {
      if (runtimeRef.current === runtime) setError(runtime.session.state.error || cause.message);
    }
  }
  const actions = custodyActions(state);
  const disabled = !ready || state.busy || state.invalidated;
  const actorJson = state.actor ? JSON.stringify(state.actor) : '';
  const message = error || state.error || (state.uncertain ? '요청 결과가 불명확합니다. 같은 요청을 다시 보내지 말고 커스터디 작업창을 확인하세요.' : '');
  const phase = state.operation?.kind === 'deposit' ? state.operation.state : '';
  const status = state.invalidated ? '연결 무효화됨' : state.connection ? '승인됨 · 입금 권한' : state.capabilities ? '승인 대기' : '미연결';
  return <main>
    <header><a className="brand" href="/custody">clairveil<span> / custody</span></a><span className="badge">로컬 개발 미리보기</span></header>
    <section className="intro"><p className="eyebrow">YOUR KEYS, IN CUSTODY</p><h1>Custody-Test-Web</h1>
      <p>Keplr·MetaMask는 체인 서명을, Clairveil Custody는 privacy 승인과 증명을 처리합니다.</p></section>
    <aside className="notice">현재는 로컬 테스트 체인의 <strong>입금</strong>만 지원합니다. 별도 테스트 브라우저 프로필과 잔액이 있는 테스트 지갑을 사용하세요. 실제 자산·개인 지갑용이 아닙니다.</aside>
    <div className="grid">
      <section className="card">
        <div className="heading"><span className="number">01</span><h2>지갑과 커스터디 연결</h2></div>
        <label htmlFor="network">로컬 네트워크</label>
        <select id="network" value={network} disabled={!ready || state.busy || Boolean(state.actor)} onChange={event => setNetwork(event.target.value)}>
          <option value="cosmos">Cosmos · Keplr</option><option value="evm">EVM · MetaMask</option>
        </select>
        <p className="meta" id="chain">{profile?.caip ?? '설정 대기'}</p>
        <button id="wallet" type="button" disabled={disabled || Boolean(state.actor)} onClick={() => invoke(runtime => runtime.connectWallet())}>
          {profile ? profile.transport === 'cosmos' ? 'Keplr 연결' : 'MetaMask 연결' : '일반 지갑 연결'}</button>
        <p className="address" id="walletAddress">{state.actor?.address ?? '아직 연결하지 않았습니다'}</p>
        <details><summary>확장 작업창에 전달할 공개 지갑 정보</summary>
          <textarea id="actorJson" readOnly aria-label="공개 지갑 정보" value={actorJson} />
          <button id="copyActor" className="secondary" type="button" disabled={!state.actor} onClick={() => invoke(async () => {
            await navigator.clipboard.writeText(actorJson); setCopied(true);
          })}>{copied ? '복사됨' : '공개 정보 복사'}</button>
        </details>
        <div className="divider" />
        <p className="instruction">확장 아이콘을 눌러 작업창을 열고, 위의 공개 지갑 정보를 붙여넣어 테스트 계정을 준비하세요.</p>
        <button id="connect" type="button" disabled={disabled || !actions.connect} onClick={() => invoke(runtime => runtime.session.connectCustody())}>커스터디 연결 요청</button>
        <button id="disconnect" className="text-button" type="button" disabled={disabled || !state.connection} onClick={() => invoke(runtime => runtime.session.disconnect())}>연결 해제</button>
        <p className="meta">커스터디 <strong id="custodyStatus">{status}</strong></p>
      </section>
      <section className="card">
        <div className="heading"><span className="number">02</span><h2>커스터디에 입금</h2></div>
        <label htmlFor="amount">입금 수량 <span className="meta">최소 단위 · 1~999</span></label>
        <div className="amount"><input id="amount" inputMode="numeric" pattern="[1-9][0-9]{0,2}" maxLength={3} value={amount}
          onChange={event => setAmount(event.target.value)} aria-describedby="amountHint" /><span id="denom">{profile?.denom ?? '—'}</span></div>
        <p className="meta" id="amountHint">커스터디 소유 privacy 계정에 입금합니다. 로컬 prover에 witness를 보내고, 일반 지갑 주소는 체인에 공개됩니다.</p>
        <button id="deposit" type="button" disabled={disabled || !actions.deposit} onClick={() => invoke(runtime => runtime.session.deposit(amount))}>입금 승인 요청</button>
        <button id="cancel" className="text-button" type="button" disabled={disabled || !actions.cancel} onClick={() => invoke(runtime => runtime.session.cancel())}>승인 전 취소</button>
        <ol className="steps">
          <DepositStep id="stepApproval" number="1" done={['preparing', 'awaiting_chain_signature', 'submission_unknown', 'submitted', 'confirmed'].includes(phase)} title="커스터디 승인" detail="작업창에서 금액·네트워크 확인, 증명 준비" />
          <DepositStep id="stepWallet" number="2" done={['submitted', 'confirmed'].includes(phase)} title="일반 지갑 서명" detail="아래 버튼으로 Keplr 또는 MetaMask 호출" />
          <DepositStep id="stepChain" number="3" done={phase === 'confirmed'} title="체인 확인" detail="커스터디가 실제 결과와 입금 노트 확인" />
        </ol>
        <div className="actions">
          <button id="submit" type="button" disabled={disabled || !actions.submit} onClick={() => invoke(runtime => runtime.session.submit())}>일반 지갑에서 서명</button>
          <button id="reconcile" className="secondary" type="button" disabled={disabled || !actions.reconcile} onClick={() => invoke(runtime => runtime.session.reconcile())}>체인 결과 확인</button>
        </div>
      </section>
    </div>
    <div id="error" className="error" role="alert" hidden={!message}>{message}</div>
    <section className="card status-card" aria-live="polite">
      <div><p className="eyebrow">CURRENT OPERATION</p><h2 id="operationState">{labels[state.operation?.state] ?? '입금 요청 전'}</h2>
        <p className="meta">작업 ID <span id="operationId">{state.operation?.operationId ?? '—'}</span></p></div>
      <p id="confirmed" className="success" hidden={state.operation?.state !== 'confirmed'}>체인 입금과 소유 노트 확인이 완료됐습니다.</p>
      <p className="meta">공개 privacy 주소·잔액 조회는 아직 지원하지 않습니다. 작업창을 닫거나 새로고침하면 연결이 무효화되며, 미확정 요청을 자동 재전송하지 않습니다.</p>
    </section>
    <section className="future">
      <FutureFeature title="비공개 전송" action="전송" /><FutureFeature title="출금" action="출금" /><FutureFeature title="선택적 공개" action="공개 요청" />
    </section>
    <footer>로컬 CC-002 SDK 미리보기 · privacy 키와 노트는 확장 안에 보관됩니다.</footer>
  </main>;
}

function DepositStep({ id, number, done, title, detail }) {
  return <li id={id} className={done ? 'done' : undefined}><span>{number}</span><div><strong>{title}</strong><small>{detail}</small></div></li>;
}
function FutureFeature({ title, action }) {
  return <div><h3>{title}</h3><p>host RPC 준비 중</p><button type="button" disabled>{action}</button></div>;
}
