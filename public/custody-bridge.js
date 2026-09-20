// This is the explicit CC-002 local transport, not an installed production provider.
export function createLocalCustodyBridge(page, { timeoutMs = 12000, probeTimeoutMs = 2500 } = {}) {
  const pending = new Map(), probes = new Map(), listeners = new Set();
  let closed = false;
  function rejectPending() {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Custody connection lost')); }
    pending.clear();
    for (const entry of probes.values()) { clearTimeout(entry.timer); entry.resolve({ workbench: 'unavailable' }); }
    probes.clear();
  }
  function receive(event) {
    if (closed || event.source !== page || event.origin !== page.location.origin) return;
    if (event.data?.source === 'cc002-preview' && event.data.type === 'status') {
      const probe = probes.get(event.data.nonce);
      if (!probe || !['closed', 'setup_required', 'preparing', 'ready', 'failed', 'unavailable'].includes(event.data.workbench)) return;
      probes.delete(event.data.nonce); clearTimeout(probe.timer); probe.resolve({ workbench: event.data.workbench }); return;
    }
    if (event.data?.source !== 'cc002-host') return;
    if (event.data.invalidated) {
      closed = true; rejectPending();
      for (const listener of listeners) listener();
      return;
    }
    const response = event.data.response, entry = pending.get(response?.id);
    if (!entry) return;
    pending.delete(response.id); clearTimeout(entry.timer); entry.resolve(response);
  }
  page.addEventListener('message', receive);
  return {
    probe() {
      if (closed) return Promise.resolve({ workbench: 'unavailable' });
      if (page.location.origin !== 'http://127.0.0.1:4320') return Promise.resolve({ workbench: 'wrong_origin' });
      if (probes.size) return Promise.reject(new Error('이미 확장 연결을 확인 중입니다.'));
      const nonce = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { probes.delete(nonce); resolve({ workbench: 'missing' }); }, probeTimeoutMs);
        probes.set(nonce, { resolve, timer });
        try { page.postMessage({ source: 'cc002-preview', type: 'probe', nonce }, page.location.origin); }
        catch (error) { probes.delete(nonce); clearTimeout(timer); reject(error); }
      });
    },
    exchange(request) {
      if (closed) return Promise.reject(new Error('Reload after opening the custody workbench'));
      if (page.location.origin !== 'http://127.0.0.1:4320') return Promise.reject(new Error('Use http://127.0.0.1:4320/custody.html'));
      if (pending.size >= 18 || pending.has(request.id)) return Promise.reject(new Error('Custody request limit'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(request.id); reject(new Error('Custody did not respond. Check the extension and workbench.')); }, timeoutMs);
        pending.set(request.id, { resolve, reject, timer });
        try { page.postMessage({ source: 'cc002-dapp', request }, page.location.origin); }
        catch (error) { pending.delete(request.id); clearTimeout(timer); reject(error); }
      });
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { closed = true; page.removeEventListener('message', receive); rejectPending(); listeners.clear(); }
  };
}
