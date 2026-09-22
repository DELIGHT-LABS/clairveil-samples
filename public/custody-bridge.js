// CC-004 uses the extension-v1 raw JSON transport. No CC-002 probe or fallback.
export const REQUEST_CHANNEL = 'clairveil:extension-v1:request';
export const RESPONSE_CHANNEL = 'clairveil:extension-v1:response';
export function createLocalCustodyBridge(page, { timeoutMs = 35000 } = {}) {
  const pending = new Map(), listeners = new Set();
  let closed = false;
  function rejectPending() {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Custody connection lost')); }
    pending.clear();
  }
  function receive(event) {
    if (closed || event.source !== page || event.origin !== page.location.origin) return;
    const data = event.data;
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
    exchange(request) {
      if (closed) return Promise.reject(new Error('Reload after opening the custody workbench'));
      if (page.location.origin !== 'http://127.0.0.1:4320') return Promise.reject(new Error('Use http://127.0.0.1:4320/custody'));
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
    close() { if (closed) return; closed = true; page.removeEventListener('message', receive); rejectPending(); for (const listener of listeners) listener(); listeners.clear(); }
  };
}
