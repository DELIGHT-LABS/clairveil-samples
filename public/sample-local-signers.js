import { fetchBoundedJson } from './bounded-json-fetch.js';

function hasLocalAccounts(configuration) {
  return configuration?.localTestMode === true && configuration.serverFeatures?.localSigners === true
    && configuration.serverFeatures.localSignerAdmin === true;
}

function matchesProfile(configuration, profile) {
  if (!hasLocalAccounts(configuration) || !profile || configuration.transport !== profile.transport
    || configuration.chainId !== profile.chainId || configuration.denom !== profile.denom) return false;
  if (profile.transport !== 'evm') return profile.transport === 'cosmos';
  try { return BigInt(configuration.evmChainId) === BigInt(profile.evmChainId); } catch { return false; }
}

// Local test helpers expose public addresses and bank balances only. They never
// select the connected wallet actor or import the legacy privacy controller.
export function createLocalSignerPanel({ document, fetchJson = fetchBoundedJson }) {
  const $ = id => document.getElementById(id);
  const panel = $('localSignerPanel'), select = $('accountSelect'), refreshButton = $('refreshAll');
  let profile, configuration, accounts = [], revision = 0, controller, disposed = false;
  const text = (id, value) => { $(id).textContent = value; };
  const status = message => { text('localSignerStatus', message); $('localSignerStatus').hidden = !message; };
  const clearValues = () => {
    for (const id of ['transparentAddress', 'shieldedAddress', 'balanceValue']) text(id, '—');
  };
  const clearAccounts = () => { accounts = []; select.replaceChildren(); select.disabled = true; clearValues(); };
  const begin = () => {
    controller?.abort(); controller = new AbortController();
    return { revision: ++revision, profile, signal: controller.signal };
  };
  const current = task => !disposed && task.revision === revision && task.profile === profile && !task.signal.aborted;
  const options = task => ({ signal: task.signal, timeoutMs: 10000, maxBytes: 65536 });

  async function readSelected(task) {
    const account = accounts.find(value => value.name === select.value);
    if (!account || !current(task)) return;
    clearValues(); text('transparentAddress', account.transparentAddress);
    text('shieldedAddress', 'Loading…'); text('balanceValue', 'Loading…');
    refreshButton.disabled = true; status('Loading test account…');
    const route = profile.transport === 'evm' ? '/evm-rest' : '/cosmos-rest';
    const [address, balance] = await Promise.allSettled([
      fetchJson(`/api/wallet/${encodeURIComponent(account.name)}/show-address`, options(task)).then(value => {
        if (typeof value?.address !== 'string' || !value.address || value.address.length > 4096) throw new Error('Invalid public address');
        return value.address;
      }),
      fetchJson(`${route}/cosmos/bank/v1beta1/balances/${encodeURIComponent(account.transparentAddress)}/by_denom?denom=${encodeURIComponent(profile.denom)}`, options(task)).then(value => {
        if (value?.balance?.denom !== task.profile.denom || typeof value.balance.amount !== 'string'
          || !/^\d{1,78}$/.test(value.balance.amount)) throw new Error('Invalid public balance');
        return `${value.balance.amount} ${task.profile.denom}`;
      })
    ]);
    if (!current(task)) return;
    text('shieldedAddress', address.status === 'fulfilled' ? address.value : 'Unavailable');
    text('balanceValue', balance.status === 'fulfilled' ? balance.value : 'Unknown');
    status(address.status === 'rejected' || balance.status === 'rejected'
      ? 'Unable to load some test account details. Refresh to retry.' : '');
    refreshButton.disabled = false;
  }

  async function refresh() {
    if (disposed || !matchesProfile(configuration, profile)) return;
    const task = begin(), previous = select.value;
    clearAccounts(); refreshButton.disabled = true; status('Loading test accounts…');
    try {
      const result = await fetchJson('/api/health', options(task));
      if (!current(task)) return;
      // Health carries the current server configuration: do not reuse an old
      // local-admin permission or show accounts from a changed server chain.
      if (!matchesProfile(result.config, profile)) {
        configuration = result.config;
        panel.hidden = !hasLocalAccounts(configuration);
        status('Local test accounts are unavailable for the selected network.');
        return;
      }
      if (!Array.isArray(result.accounts) || result.accounts.length > 100) throw new Error('Invalid account list');
      const seen = new Set();
      accounts = result.accounts.map(account => {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(account?.name) || seen.has(account.name)
          || typeof account.transparentAddress !== 'string' || !/^\S{1,256}$/.test(account.transparentAddress)) throw new Error('Invalid test account');
        seen.add(account.name);
        return { name: account.name, transparentAddress: account.transparentAddress };
      });
      for (const account of accounts) {
        const option = document.createElement('option'); option.value = account.name; option.textContent = account.name; select.append(option);
      }
      select.disabled = accounts.length === 0;
      select.value = accounts.some(account => account.name === previous) ? previous : accounts[0]?.name || '';
      if (!accounts.length) {
        status('No local test accounts found in this server’s keyring.'); refreshButton.disabled = false; return;
      }
      await readSelected(task);
    } catch {
      if (!current(task)) return;
      clearAccounts(); status('Unable to load test accounts. Refresh to retry.'); refreshButton.disabled = false;
    }
  }
  const selectAccount = () => { if (!disposed && matchesProfile(configuration, profile)) void readSelected(begin()); };
  const refreshAccounts = () => { void refresh(); };
  select.addEventListener('change', selectAccount); refreshButton.addEventListener('click', refreshAccounts);
  return {
    setProfile(nextProfile, nextConfiguration) {
      controller?.abort(); revision++; profile = nextProfile; configuration = nextConfiguration;
      clearAccounts(); panel.hidden = !hasLocalAccounts(configuration); refreshButton.disabled = true;
      status(panel.hidden ? '' : 'Local test accounts are unavailable for the selected network.');
      return refresh();
    },
    dispose() {
      disposed = true; revision++; controller?.abort();
      select.removeEventListener('change', selectAccount); refreshButton.removeEventListener('click', refreshAccounts);
    }
  };
}
