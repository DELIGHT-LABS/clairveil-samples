// CC-004 uses the extension-v1 raw JSON transport. No CC-002 probe or fallback.
export const REQUEST_CHANNEL = 'clairveil:extension-v1:request';
export const RESPONSE_CHANNEL = 'clairveil:extension-v1:response';
export const PRESENT_CHANNEL = 'clairveil:extension-v1:present';
export const PRESENTED_CHANNEL = 'clairveil:extension-v1:presented';
export const REGISTER_NETWORK_CHANNEL = 'clairveil:extension-v1:register-network';
export const NETWORK_REGISTERED_CHANNEL = 'clairveil:extension-v1:network-registered';
export const CANCEL_NETWORK_CHANNEL = 'clairveil:extension-v1:cancel-network';
export function createLocalCustodyBridge(page, { timeoutMs = 35000, presentationTimeoutMs = 12000, registrationTimeoutMs = 310000 } = {}) {
  const pending = new Map(), listeners = new Set();
  let closed = false;
  let presentation;
  let registration;
  function finishRegistration(error, cancel = false) {
    if (!registration) return;
    const current = registration; registration = undefined; clearTimeout(current.timer);
    if (cancel) try { page.postMessage({ channel: CANCEL_NETWORK_CHANNEL, id: current.id }, page.location.origin); } catch { /* Detached page. */ }
    if (error) current.reject(error); else current.resolve();
  }
  function finishPresentation(error) {
    if (!presentation) return;
    const current = presentation; presentation = undefined; clearTimeout(current.timer);
    if (error) current.reject(error); else current.resolve();
  }
  function rejectPending() {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Custody connection lost')); }
    pending.clear();
  }
  function receive(event) {
    if (closed || event.source !== page || event.origin !== page.location.origin) return;
    const data = event.data;
    if (data && Object.keys(data).sort().join(',') === 'channel,id,status' && data.channel === NETWORK_REGISTERED_CHANNEL
      && data.id === registration?.id && ['registered', 'rejected', 'invalid', 'conflict', 'unavailable'].includes(data.status)) {
      const messages = {
        rejected: '네트워크 등록을 거절했습니다. 연결하려면 다시 요청하세요.',
        invalid: '네트워크 정보가 올바르지 않거나 지원하지 않는 설정입니다.',
        conflict: '같은 네트워크 ID에 다른 설정이 등록되어 있습니다. 사이트의 체인 정보를 확인하세요.',
        unavailable: '네트워크 등록을 완료하지 못했습니다. 커스터디 확장과 잠금 상태를 확인하고 다시 요청하세요.'
      };
      finishRegistration(data.status === 'registered' ? undefined : new Error(messages[data.status])); return;
    }
    if (data && Object.keys(data).sort().join(',') === 'channel,id,opened' && data.channel === PRESENTED_CHANNEL
      && data.id === presentation?.id && typeof data.opened === 'boolean') {
      finishPresentation(data.opened ? undefined : new Error('커스터디 창을 열지 못했습니다. 같은 브라우저의 확장 상태를 확인하고 버튼을 다시 누르세요.')); return;
    }
    if (!data || Object.keys(data).sort().join(',') !== 'channel,payload' || data.channel !== RESPONSE_CHANNEL
      || typeof data.payload !== 'string' || data.payload.length > 524288 || new TextEncoder().encode(data.payload).length > 524288) return;
    let response;
    try { response = JSON.parse(data.payload); } catch { return; }
    const entry = pending.get(response?.id);
    if (!entry) return;
    pending.delete(response.id); clearTimeout(entry.timer);
    // Pass the original bytes: SDK parsing still rejects duplicate members and
    // validates the full response before it can authorize any wallet invocation.
    entry.resolve(data.payload);
  }
  page.addEventListener('message', receive);
  return {
    registerNetwork(descriptor) {
      if (closed) return Promise.reject(new Error('Custody connection lost'));
      if (page.location.origin !== 'http://127.0.0.1:4320') return Promise.reject(new Error('Use http://127.0.0.1:4320/'));
      let payload;
      try { payload = JSON.stringify(descriptor); } catch { return Promise.reject(new Error('Invalid network registration')); }
      if (typeof payload !== 'string' || new TextEncoder().encode(payload).length > 16384) return Promise.reject(new Error('Invalid network registration'));
      if (registration) return registration.payload === payload ? registration.promise : Promise.reject(new Error('Network registration already pending'));
      const id = crypto.randomUUID();
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => finishRegistration(new Error('네트워크 등록 시간이 만료되었습니다. 버튼을 눌러 다시 요청하세요.'), true), registrationTimeoutMs);
        registration = { id, payload, resolve, reject, timer };
      });
      registration.promise = promise;
      try { page.postMessage({ channel: REGISTER_NETWORK_CHANNEL, id, payload }, page.location.origin); }
      catch (error) { finishRegistration(error, true); }
      return promise;
    },
    present() {
      if (closed) return Promise.reject(new Error('Custody connection lost'));
      if (page.location.origin !== 'http://127.0.0.1:4320') return Promise.reject(new Error('Use http://127.0.0.1:4320/'));
      if (presentation) return presentation.promise;
      const id = crypto.randomUUID();
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => finishPresentation(new Error('커스터디 확장이 응답하지 않습니다. 이 브라우저에 최신 확장을 설치·활성화한 뒤 페이지를 새로고침하세요.')), presentationTimeoutMs);
        presentation = { id, resolve, reject, timer };
      });
      presentation.promise = promise;
      try { page.postMessage({ channel: PRESENT_CHANNEL, id }, page.location.origin); }
      catch (error) { finishPresentation(error); }
      return promise;
    },
    exchange(request) {
      if (closed) return Promise.reject(new Error('Reload after opening the custody workbench'));
      if (page.location.origin !== 'http://127.0.0.1:4320') return Promise.reject(new Error('Use http://127.0.0.1:4320/'));
      const payload = JSON.stringify(request);
      if (new TextEncoder().encode(payload).length > 32768) return Promise.reject(new Error('Custody request too large'));
      if (pending.size >= 14 || pending.has(request.id)) return Promise.reject(new Error('Custody request limit'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(request.id); reject(new Error('CC-004 확장 응답이 없습니다. 같은 브라우저 프로필에 최신 확장을 로드하고 작업창을 연 뒤 웹 탭을 새로고침하세요.')); }, timeoutMs);
        pending.set(request.id, { resolve, reject, timer });
        try { page.postMessage({ channel: REQUEST_CHANNEL, payload }, page.location.origin); }
        catch (error) { pending.delete(request.id); clearTimeout(timer); reject(error); }
      });
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { if (closed) return; closed = true; page.removeEventListener('message', receive); finishRegistration(new Error('Custody connection lost'), true); finishPresentation(new Error('Custody connection lost')); rejectPending(); for (const listener of listeners) listener(); listeners.clear(); }
  };
}
