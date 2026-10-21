import { custodyActions, canResetCustodySession, exactWithdrawNoteRequired } from './custody-state.js';
import { fetchBoundedJson } from './bounded-json-fetch.js';
import { normalizeDisclosureHash, resolveDisclosureTransactionHash } from './sample-event-disclosure.js';
import { faucetMatchesProfile, requestSampleFaucet } from './sample-faucet.js';

const statusLabels = { awaiting_approval: 'Custody approval pending', preparing: 'Preparing proof in custody',
  awaiting_chain_signature: 'Ready for explicit chain-wallet signature', submitted: 'Submitted; chain confirmation pending',
  submission_unknown: 'Submission unknown; inspect and reconcile', reconciliation_required: 'Chain reconciliation required',
  confirmed: 'Chain effects confirmed by custody', completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed; inspect custody', expired: 'Expired; inspect reservations' };

export function startSampleCustody({ createRuntime, browser = window, document = browser.document,
  loadProfiles = () => fetchBoundedJson('/custody-profiles.json', { maxBytes: 16384, timeoutMs: 5000 }),
  loadServerConfig = () => fetchBoundedJson('/api/config', { maxBytes: 65536, timeoutMs: 5000 }), requestFaucet = requestSampleFaucet,
  chainActions, fetchJson = fetchBoundedJson, pollMs = 1700 } = {}) {
  const $ = id => document.getElementById(id);
  const listeners = [];
  let profiles, profile, runtime, generation = 0, alive = true, timer, localError = '', publicBusy = false;
  let sendRecord = null, publicController;
  let serverConfig = null, faucetRecord = null;
  let custodyOpening = false;
  let networkRegistered = false;
  let disclosureRevision = 0, disclosureRequest = null, disclosureLookup = null;
  let eventsPage = 0, eventsHasMore = false, eventsController = null;
  const text = (id, value) => { if ($(id)) $(id).textContent = value ?? '—'; };
  const enable = (id, value) => { if ($(id)) $(id).disabled = !value; };
  const on = (id, event, callback) => {
    if (!$(id)) return;
    $(id).addEventListener(event, callback); listeners.push(() => $(id)?.removeEventListener(event, callback));
  };
  const sendKey = actor => `clairveil:public-send:${profile.caip}:${actor.address}`;
  const faucetKey = actor => `clairveil:faucet:${profile.caip}:${actor.address}`;
  const error = message => { localError = message; render(); };
  const disclosureFieldInputs = [['amount', 'custodyDisclosureAmount'], ['from', 'custodyDisclosureFrom'], ['to', 'custodyDisclosureTo']];
  const disclosureSelection = () => ({ transactionHash: normalizeDisclosureHash($('disclosureSourceTxHash').value.trim(), profile?.transport),
    plane: $('disclosureSourcePlane').value === 'self-view' ? 'self_view' : 'user', delivery: $('custodyDisclosureDelivery').value,
    requestedFields: disclosureFieldInputs.filter(([, id]) => $(id).checked).map(([field]) => field) });
  const matchesSelection = request => {
    const selection = disclosureSelection();
    return request && request.revision === disclosureRevision && request.generation === generation
      && ['transactionHash', 'plane', 'delivery'].every(key => request[key] === selection[key])
      && JSON.stringify(request.requestedFields) === JSON.stringify(selection.requestedFields);
  };
  function resetDisclosure({ clearTransaction = false, clearEvent = false } = {}) {
    disclosureRevision++; disclosureRequest = null; disclosureLookup?.abort(); disclosureLookup = null;
    if (clearTransaction) $('disclosureSourceTxHash').value = '';
    if (clearEvent) for (const id of ['eventDetailType', 'eventDetailHeight', 'eventDetailTx']) text(id, '—');
  }
  function resetEvents() {
    eventsController?.abort(); eventsController = null; eventsPage = 0; eventsHasMore = false;
    $('eventsList').replaceChildren();
  }
  function readPendingRecord(key) {
    try {
      const value = JSON.parse(browser.localStorage.getItem(key));
      if (value === null) return null;
      if (['submitted', 'unknown'].includes(value?.status) && /^(?:0x)?[a-fA-F0-9]{64}$/.test(value.hash)) return value;
      return { status: 'unknown' };
    } catch { return { status: 'unknown' }; }
  }
  const readSendRecord = (actor = runtime?.session.state.actor) => actor ? readPendingRecord(sendKey(actor)) : null;
  async function withSubmissionLock(r, action, { allowPending = false } = {}) {
    const actor = r.session.state.actor, stamp = generation;
    if (!actor || typeof browser.navigator.locks?.request !== 'function') throw new Error('Browser Web Locks are required for safe submissions.');
    return browser.navigator.locks.request(sendKey(actor), { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Another tab is using this chain account. Wait and inspect its transaction before trying again.');
      if (!alive || stamp !== generation || r !== runtime || r.session.state.invalidated) throw new Error('Connection changed; submission stopped.');
      sendRecord = readSendRecord(actor); render();
      if (!allowPending && sendRecord) throw new Error('Public send pending; reconcile before another submission.');
      return action(r);
    });
  }
  const invokeCustody = action => invoke(action, { present: true });
  const invokeSubmission = action => invokeCustody(r => withSubmissionLock(r, action));
  const syncSendRecord = event => {
    const actor = runtime?.session.state.actor;
    if (!alive || !actor || (event?.type === 'storage' && event.key !== null && ![sendKey(actor), faucetKey(actor)].includes(event.key))) return;
    sendRecord = readSendRecord(actor); faucetRecord = readPendingRecord(faucetKey(actor)); render();
  };
  browser.addEventListener('storage', syncSendRecord);
  browser.addEventListener('focus', syncSendRecord);
  listeners.push(() => browser.removeEventListener('storage', syncSendRecord), () => browser.removeEventListener('focus', syncSendRecord));
  function render() {
    if (!alive) return;
    const state = runtime?.session.state || {}, actions = custodyActions(state);
    const ready = Boolean(runtime && !state.busy && !state.invalidated && !publicBusy && !custodyOpening);
    text('modeBadge', 'Custody privacy · local test');
    text('walletStatus', state.actor ? 'Chain wallet connected' : 'Wallet Offline');
    text('sessionWallet', state.actor ? profile.transport === 'cosmos' ? 'Keplr' : 'MetaMask' : 'Not connected');
    text('walletAccount', state.actor?.address || 'Not connected'); text('walletChain', state.actor?.chainId);
    text('keplrPubkey', state.actor?.pubKeyHex || 'Not applicable');
    text('walletSignatureHash', state.invalidated ? 'Invalidated — disconnect when settled and obtain fresh consent' : state.connection ? state.connection.recoveryAccess ? 'Approved · recovery only' : 'Approved by custody' : 'Not approved');
    text('keplrShieldedAddress', state.publicAccount?.protocol?.shieldedAddress || 'Request approved address');
    text('chainId', profile?.caip); text('dappChainHint', profile ? `${profile.chainId} · ${profile.denom}` : 'Loading custody network profiles');
    enable('connectWallet', ready && !state.actor && profile.transport === 'evm');
    enable('connectKeplr', ready && !state.actor && profile.transport === 'cosmos');
    enable('disconnectWallet', Boolean(runtime && state.actor && !publicBusy && !custodyOpening && canResetCustodySession(state)));
    if ($('disconnectWallet')) $('disconnectWallet').title = canResetCustodySession(state) ? '' : 'Inspect or finish the outstanding custody operation before disconnecting; its ID and submission state are retained.';
    if ($('disconnectWallet')) $('disconnectWallet').hidden = !state.actor;
    const custodySetup = !state.actor && !state.connection && !state.operation && !state.uncertain && !networkRegistered;
    enable('signSession', ready && (actions.connect || custodySetup));
    text('signSession', state.actor ? 'Request custody connection' : networkRegistered ? 'Network registered' : 'Register network in custody');
    text('custodyConnectionHelp', state.actor
      ? state.operation?.kind === 'connect' && state.operation.state === 'awaiting_approval' ? 'Approve the pending site connection in the custody window. Deposit becomes available after connection approval; verify your saved backup before funding.'
        : 'Request connection to send this network to custody. Approve network registration, then approve the site connection. Verify your backup before funding.'
      : networkRegistered
        ? `Network registered. Connect ${profile?.transport === 'evm' ? 'MetaMask' : 'Keplr'} here, then request custody connection to approve this site.`
        : `Send the selected network to custody for registration approval. Then connect ${profile?.transport === 'evm' ? 'MetaMask' : 'Keplr'} here and request custody connection.`);
    enable('setupKeplrPrivacy', ready && state.connection?.permissions.includes('account.read'));
    enable('refreshKeplrBalance', ready && Boolean(state.actor));
    enable('copyWalletAccount', Boolean(state.actor)); enable('copyKeplrShieldedAddress', Boolean(state.publicAccount));
    enable('dappChainSelect', Boolean(profiles) && !publicBusy && !custodyOpening && !state.busy && !state.actor && !state.uncertain);
    enable('custodyFullFlow', ready && (!state.operation || actions.connect) && !state.connection);
    enable('custodyRecoveryIds', ready && (!state.operation || actions.connect) && !state.connection);
    enable('depositFromKeplr', ready && actions.deposit && !sendRecord);
    enable('transferFromVeiled', ready && actions.transfer && !sendRecord);
    enable('withdrawFromVeiled', ready && actions.withdraw && !sendRecord);
    const preparation = state.withdrawalPreparation;
    const needsNote = actions.prepareWithdraw, preparingNote = Boolean(preparation?.transferOperationId && preparation.transferOperationId === state.operation?.operationId);
    enable('prepareWithdrawNote', ready && needsNote && !sendRecord);
    enable('resumeWithdraw', ready && actions.resumeWithdraw && !sendRecord);
    $('prepareWithdrawNote').hidden = !needsNote; $('resumeWithdraw').hidden = !actions.resumeWithdraw;
    text('withdrawPreparationState', needsNote
      ? `No exact note for ${preparation.amountBaseUnits} ${profile.denom}. Request a private transfer to your own approved address, then resume withdrawal to ${preparation.recipientAddress}. Each step needs separate approval and signing.`
      : preparingNote ? `Preparing ${preparation.amountBaseUnits} ${profile.denom} for withdrawal to ${preparation.recipientAddress}. ${actions.resumeWithdraw ? 'Preparation confirmed. Resume withdrawal approval.' : 'Finish every preparation step in custody before resuming.'}` : '');
    enable('custodySubmit', ready && actions.submit && !sendRecord);
    enable('custodyRefresh', ready && Boolean(state.operation)); enable('custodyCancel', ready && actions.cancel);
    enable('cancelDepositProof', ready && actions.cancel);
    if ($('cancelDepositProof')) { $('cancelDepositProof').hidden = !actions.cancel; $('cancelDepositProof').textContent = 'Cancel before approval'; }
    enable('reconcileKeplrDeposit', ready && actions.reconcile);
    enable('scanKeplrNotes', ready && state.connection?.permissions.includes('balance.read'));
    for (const id of ['decodeEventDisclosure', 'decodeSelfViewDisclosure', 'decodeDisclosureSource']) enable(id, ready && actions.disclosure && !disclosureLookup && Boolean(disclosureSelection().transactionHash) && disclosureSelection().requestedFields.length > 0);
    enable('refreshEvents', ready && !eventsController);
    enable('previousEventsPage', ready && !eventsController && eventsPage > 1);
    enable('nextEventsPage', ready && !eventsController && eventsHasMore);
    text('eventsPageState', eventsController ? 'Loading events…' : eventsPage ? `Page ${eventsPage} · Oldest first` : 'Events not loaded');
    const selected = state.activeOperation || state.operation;
    text('custodyOperationState', statusLabels[state.operation?.state] || state.operation?.state || 'No request');
    text('custodyOperationId', state.operation?.operationId);
    text('custodyActiveStep', selected ? `${selected.kind || 'operation'} · ${statusLabels[selected.state] || selected.state} · ${selected.operationId}` : 'No active step');
    if ($('custodyRecoveryState')) $('custodyRecoveryState').hidden = !state.recoveryRequired;
    const steps = $('custodyOperationSteps');
    if (steps) {
      steps.replaceChildren();
      for (const step of state.operation?.steps || []) {
        const row = document.createElement('li'); row.textContent = `${step.stepKind} · ${statusLabels[step.state] || step.state}`; steps.append(row);
      }
    }
    const recovery = $('custodyRecoveryOperations');
    if (recovery) {
      recovery.replaceChildren();
      for (const id of state.connection?.recoveryAccess?.operationIds || []) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = `Inspect ${id.slice(0, 8)}…`; button.disabled = !ready;
        button.addEventListener('click', () => invokeCustody(r => r.session.inspectRecovery(id))); recovery.append(button);
      }
    }
    const balances = state.balances;
    const row = balances?.rows.find(item => item.assetDenom === profile.denom);
    const verified = balances?.syncStatus === 'current' && row?.verificationState === 'verified';
    text('myKeplrSpendable', verified ? `${row.spendableBaseUnits} ${profile.denom} · verified response snapshot` : 'Unknown — request a verified custody balance');
    text('noteSyncState', balances ? `${balances.syncStatus} · as-of height ${balances.asOfHeight || 'unknown'} · refresh trusted scan in extension before reading` : 'Scan in custody, then read the granted balance here');
    text('myKeplrNotesList', 'Private notes and note selection stay in custody. This page receives granted aggregate balances only.');
    const result = state.operation?.kind === 'disclosure' && state.operation.state === 'completed' ? state.operation.disclosureResult : null;
    const disclosure = matchesSelection(disclosureRequest) && state.operation?.operationId === disclosureRequest.operationId
      && result?.delivery === disclosureRequest.delivery && (result.delivery === 'trusted-wallet'
        || (normalizeDisclosureHash(result.transactionHash, profile.transport) === disclosureRequest.transactionHash && result.plane === disclosureRequest.plane
          && JSON.stringify(result.disclosedFields) === JSON.stringify(disclosureRequest.requestedFields))) ? result : null;
    const pageDisclosure = disclosure?.delivery === 'page' && disclosure.verificationStatus === 'verified' ? disclosure : null;
    const disclosedFields = pageDisclosure?.fields;
    text('eventDisclosureAmount', disclosedFields?.amount ? `${disclosedFields.amount.amountBaseUnits} ${disclosedFields.amount.assetDenom}` : '—');
    text('eventDisclosureFrom', disclosedFields?.from || '—'); text('eventDisclosureTo', disclosedFields?.to || '—');
    for (const [id, value] of [
      ['eventDetailUserMode', pageDisclosure?.mode], ['eventDisclosurePlane', pageDisclosure?.plane],
      ['eventDisclosurePolicy', pageDisclosure?.policy], ['eventDisclosureFields', pageDisclosure?.disclosedFields.join(', ')],
      ['eventDisclosureOutputIndex', pageDisclosure?.target?.outputIndex], ['eventDisclosureCommitment', pageDisclosure?.target?.commitmentHex],
      ['eventDisclosureDigest', pageDisclosure?.target?.digestHex], ['eventDisclosureVerified', pageDisclosure ? 'Verified by custody' : null]
    ]) text(id, value);
    text('eventDisclosureState', disclosure ? disclosure.delivery === 'trusted-wallet' ? 'View the released result in custody' : pageDisclosure ? 'Approved disclosure fields verified' : 'Disclosure unverified' : 'Request disclosure and approve its release in custody');
    const message = custodyOpening ? 'Opening custody… Unlock or review the request in the extension.' : localError || state.error || (state.uncertain ? 'Request result unknown. Inspect custody; do not repeat the request.'
      : exactWithdrawNoteRequired(state.operation) ? 'An exact-value note is required. Use the withdrawal preparation action or correct the withdrawal amount.' : '');
    text('custodyError', message); if ($('custodyError')) $('custodyError').hidden = !message;
    text('keplrTxState', publicBusy ? 'Chain wallet request pending' : sendRecord ? 'Public send pending; reconcile before another submission' : statusLabels[selected?.state] || 'Ready');
    if (sendRecord?.hash) text('keplrSendHash', sendRecord.hash);
    enable('sendFromKeplr', ready && Boolean(state.actor) && !sendRecord && canResetCustodySession(state));
    enable('reconcileKeplrSend', ready && Boolean(sendRecord?.hash));
    const faucetAvailable = faucetMatchesProfile(serverConfig, profile);
    enable('fundKeplr', ready && Boolean(state.actor) && faucetAvailable && !faucetRecord && !sendRecord);
    enable('reconcileFaucet', ready && Boolean(faucetRecord?.hash));
    text('faucetDisplayDenom', faucetAvailable ? serverConfig.displayDenom || profile.denom : 'display units');
    text('faucetHelpText', faucetRecord ? 'Faucet request pending; inspect before requesting again.' : faucetAvailable
      ? `From the configured local faucet · ${serverConfig.coinDecimals} decimal places` : 'Enable the local server faucet for this same chain to fund a test wallet.');
    if (faucetRecord) {
      text('keplrFaucetHash', faucetRecord.hash || 'Unknown — inspect the local signer');
      text('keplrFaucetSent', 'Pending confirmation'); text('keplrFaucetRecipient', state.actor?.address);
    }
  }
  async function invoke(action, { present = false, registerNetwork = false } = {}) {
    if (!alive || !runtime || publicBusy || custodyOpening || (present && runtime.session.state.busy)) return;
    const current = runtime, stamp = generation; localError = '';
    try {
      if (present) {
        custodyOpening = true; render();
        if (registerNetwork) await current.registerNetwork();
        else await current.present();
        if (!alive || stamp !== generation || current !== runtime || current.session.state.invalidated) return;
        if (registerNetwork) networkRegistered = true;
      }
      await action(current);
    }
    catch (cause) { if (alive && stamp === generation) localError = current.session.state.error || cause.message; }
    finally { if (present && stamp === generation) custodyOpening = false; }
    if (alive && stamp === generation) render();
  }
  function selectProfile(id) {
    runtime?.dispose(); clearInterval(timer); generation++;
    resetDisclosure({ clearTransaction: true, clearEvent: true }); resetEvents();
    runtime = null; profile = profiles[id]; localError = ''; sendRecord = null; faucetRecord = null; custodyOpening = false; networkRegistered = false;
    for (const field of ['veiledTransferRecipient', 'veiledWithdrawRecipient']) $(field).value = '';
    for (const field of ['keplrSendHash', 'keplrDepositHash', 'keplrTransferHash', 'keplrWithdrawHash', 'keplrFaucetHash', 'keplrFaucetSent', 'keplrFaucetRecipient']) text(field, '—');
    text('myClairBalance', 'Unknown'); text('keplrBalance', 'Unknown');
    if (!profile) { error('Missing custody network profile'); return; }
    const stamp = generation;
    try {
      runtime = createRuntime({ profile, browser, onChange: state => {
        if (!alive || stamp !== generation) return;
        if (state.invalidated) { publicController?.abort(); resetDisclosure({ clearTransaction: true, clearEvent: true }); resetEvents(); text('myClairBalance', 'Unknown'); text('keplrBalance', 'Unknown'); }
        if (state.operation?.kind === 'deposit') {
          text('keplrDepositStage', statusLabels[state.operation.state] || state.operation.state);
          text('keplrDepositHash', state.operation.transactionHash);
          text('keplrDepositRecovery', state.operation.state === 'confirmed' ? 'Effects confirmed; read custody balance separately' : 'Not confirmed');
        }
        if (state.operation?.kind === 'transfer') text('keplrTransferHash', state.activeOperation?.transactionHash || state.operation.transactionHash);
        if (state.operation?.kind === 'withdraw') {
          text('keplrWithdrawHash', state.operation.transactionHash);
          text('keplrWithdrawReceive', state.operation.state === 'confirmed' ? 'Effects confirmed by custody' : 'Not confirmed');
        }
        render();
      } });
      timer = setInterval(() => {
        if (alive && stamp === generation && !publicBusy && !runtime.session.state.busy && !runtime.session.state.invalidated && custodyActions(runtime.session.state).poll) invoke(r => r.session.refresh());
      }, pollMs);
    } catch (cause) { error(cause.message); }
    text('depositProverPrivacyNotice', 'Review amount, destination and remote prover witness disclosure in custody. The page receives no private witness.');
    if ($('depositProverPrivacyNotice')) $('depositProverPrivacyNotice').hidden = false;
    text('localHome', 'Privacy vault and backup in extension'); text('keplrSignerCheck', 'Ordinary signing is separate from custody approval');
    document.querySelectorAll('.denom').forEach(node => { node.textContent = profile.denom; });
    render();
  }
  async function connectWallet(r) {
    await r.connectWallet();
    const actor = r.session.state.actor;
    sendRecord = readSendRecord(actor);
    faucetRecord = readPendingRecord(faucetKey(actor));
    if ($('veiledWithdrawRecipient')) $('veiledWithdrawRecipient').value = actor.address;
    render();
  }
  async function readBalance(r) {
    const stamp = generation, actor = r.session.state.actor;
    const module = chainActions || await import('./sample-chain-actions.js');
    const value = await module.readTransparentBalance(profile, actor, browser);
    if (!alive || stamp !== generation || r.session.state.invalidated) return;
    text('myClairBalance', `${value} ${profile.denom}`); text('keplrBalance', `${value} ${profile.denom}`);
  }
  on('connectKeplr', 'click', () => invoke(connectWallet)); on('connectWallet', 'click', () => invoke(connectWallet));
  on('signSession', 'click', () => {
    return invoke(async r => {
      // Public network registration is available before chain-wallet connection.
      // It must not negotiate capabilities or request site authority without an actor.
      if (!r.session.state.actor) return;
      return r.session.connectCustody({ fullFlow: $('custodyFullFlow').checked,
        recoveryOperationIds: $('custodyRecoveryIds').value.trim().split(/[,\s]+/).filter(Boolean) });
    }, { present: true, registerNetwork: true });
  });
  on('disconnectWallet', 'click', () => {
    const r = runtime, stamp = generation;
    if (!alive || !r || publicBusy || !canResetCustodySession(r.session.state)) return;
    return invoke(async () => {
      await r.session.disconnect(); if (alive && stamp === generation && r === runtime) selectProfile($('dappChainSelect').value);
    }, { present: Boolean(r.session.state.connection) && !r.session.state.invalidated });
  });
  on('setupKeplrPrivacy', 'click', () => invokeCustody(async r => {
    await r.session.publicAccount();
    if ($('veiledTransferRecipient') && !$('veiledTransferRecipient').value) $('veiledTransferRecipient').value = r.session.state.publicAccount?.protocol.shieldedAddress || '';
  }));
  on('depositFromKeplr', 'click', () => invokeSubmission(r => r.session.deposit($('keplrDepositAmount').value.trim())));
  on('transferFromVeiled', 'click', () => invokeSubmission(r => r.session.transfer($('veiledTransferAmount').value.trim(), {
    recipientShieldedAddress: $('veiledTransferRecipient').value.trim(), disclosure: transferDisclosure(), selfViewEnabled: $('includeSelfViewDisclosure').checked
  })));
  function transferDisclosure() {
    if (!$('veiledDisclosureAdvanced').checked) return { policy: 'all-private', mode: 'none' };
    const mode = $('veiledDisclosureMode').value;
    if (mode === 'none') return { policy: 'all-private', mode };
    const policy = [['amount', 'veiledDisclosureAmount'], ['from', 'veiledDisclosureFrom'], ['to', 'veiledDisclosureTo']]
      .filter(([, id]) => $(id).checked).map(([field]) => field).join('-');
    if (!policy) throw new Error('Select at least one disclosure field.');
    return { policy, mode, ...(mode === 'recipient-encrypted' ? { recipientDisclosurePublicKey: $('veiledDisclosurePubKey').value.trim().replace(/^0x/, '').toLowerCase() } : {}) };
  }
  on('withdrawFromVeiled', 'click', () => invokeSubmission(r => r.session.withdraw($('veiledWithdrawAmount').value.trim(), { recipientAddress: $('veiledWithdrawRecipient').value.trim() })));
  on('prepareWithdrawNote', 'click', () => invokeSubmission(r => r.session.prepareWithdrawNote()));
  on('resumeWithdraw', 'click', () => invokeSubmission(r => r.session.resumeWithdraw()));
  on('custodySubmit', 'click', () => invokeSubmission(r => r.session.submit()));
  on('custodyRefresh', 'click', () => invokeCustody(r => r.session.refresh()));
  on('custodyCancel', 'click', () => invokeCustody(r => r.session.cancel()));
  on('cancelDepositProof', 'click', () => invokeCustody(r => r.session.cancel()));
  on('reconcileKeplrDeposit', 'click', () => invokeCustody(r => r.session.reconcile()));
  on('scanKeplrNotes', 'click', () => invokeCustody(r => r.session.balances()));
  on('refreshKeplrBalance', 'click', () => invoke(readBalance));
  function disclosure(plane) {
    if (disclosureLookup) return;
    if (plane) $('disclosureSourcePlane').value = plane === 'self_view' ? 'self-view' : 'user';
    resetDisclosure();
    const selection = disclosureSelection(), request = { ...selection, revision: disclosureRevision, generation };
    return invokeCustody(async r => {
      await r.session.disclosure(selection);
      if (alive && r === runtime && !r.session.state.invalidated && matchesSelection(request)) {
        disclosureRequest = { ...request, operationId: r.session.state.operation.operationId };
      }
    });
  }
  on('disclosureSourceTxHash', 'input', () => { resetDisclosure({ clearEvent: true }); render(); });
  for (const id of ['disclosureSourcePlane', 'custodyDisclosureDelivery', ...disclosureFieldInputs.map(([, id]) => id)]) on(id, 'change', () => { resetDisclosure(); render(); });
  on('decodeEventDisclosure', 'click', () => disclosure('user')); on('decodeSelfViewDisclosure', 'click', () => disclosure('self_view'));
  on('decodeDisclosureSource', 'click', () => disclosure());
  function loadEvents(page) {
    if (eventsController || !Number.isSafeInteger(page) || page < 1) return;
    return invoke(async r => {
      const stamp = generation, selectedProfile = profile, controller = new AbortController();
      const route = selectedProfile.transport === 'evm' ? '/evm-rest' : '/cosmos-rest';
      eventsController = controller; render();
      const current = () => alive && stamp === generation && r === runtime && eventsController === controller && !r.session.state.invalidated;
      try {
        const [events, status] = await Promise.all([
          fetchJson(`${route}/clairveil/privacy/v1/events?limit=30&page=${page}`, { maxBytes: 2097152, timeoutMs: 10000, signal: controller.signal }),
          fetchJson(selectedProfile.transport === 'evm' ? '/evm-rpc/status' : '/cosmos-rpc/status', { maxBytes: 16384, timeoutMs: 10000, signal: controller.signal })
        ]);
        if (!current()) return;
        if (status.result?.node_info?.network !== selectedProfile.chainId || !Array.isArray(events.events) || events.events.length > 30
          || String(events.page) !== String(page) || String(events.limit) !== '30'
          || (events.has_more !== undefined && typeof events.has_more !== 'boolean')) throw new Error('Public event chain/response mismatch.');
        const list = document.createDocumentFragment();
        for (const event of events.events) {
          const hash = event.tx_hash_hex || event.tx_hash || '';
          const button = document.createElement('button'); button.type = 'button';
          button.textContent = `${event.event_type || 'Privacy event'} · ${event.height || 'unknown height'} · ${hash}`;
          button.disabled = !/^(?:0x)?[0-9a-fA-F]{64}$/.test(hash);
          button.addEventListener('click', async () => {
            if (!alive || stamp !== generation || r !== runtime || r.session.state.invalidated) return;
            resetDisclosure({ clearTransaction: true }); localError = '';
            const revision = disclosureRevision, lookup = new AbortController(); disclosureLookup = lookup;
            text('eventDetailType', event.event_type); text('eventDetailHeight', event.height); text('eventDetailTx', hash);
            render();
            const selected = () => alive && stamp === generation && r === runtime && revision === disclosureRevision && !r.session.state.invalidated;
            try {
              const transactionHash = await resolveDisclosureTransactionHash({ profile: selectedProfile, event, fetchJson, signal: lookup.signal });
              if (selected()) { $('disclosureSourceTxHash').value = transactionHash; text('eventDetailTx', transactionHash); }
            } catch (cause) { if (selected()) localError = cause.message; }
            finally { if (selected()) { disclosureLookup = null; render(); } }
          }); list.append(button);
        }
        $('eventsList').replaceChildren(list);
        if (!events.events.length) text('eventsList', 'No public privacy events on this page.');
        eventsPage = page; eventsHasMore = events.has_more === true;
        text('blockHeight', status.result.sync_info?.latest_block_height); text('restState', 'Public query verified against selected chain');
      } catch (cause) { if (current()) throw cause; }
      finally { controller.abort(); if (eventsController === controller) { eventsController = null; render(); } }
    });
  }
  on('refreshEvents', 'click', () => loadEvents(eventsPage || 1));
  on('previousEventsPage', 'click', () => loadEvents(eventsPage - 1));
  on('nextEventsPage', 'click', () => { if (eventsHasMore) return loadEvents(eventsPage + 1); });
  on('veiledDisclosureAdvanced', 'change', () => { $('veiledDisclosureOptions').hidden = !$('veiledDisclosureAdvanced').checked; });
  on('includeSelfViewDisclosure', 'change', () => { $('selfViewWarning').hidden = $('includeSelfViewDisclosure').checked; });
  on('dappChainSelect', 'change', () => { if (runtime?.session.state.actor || runtime?.session.state.busy || publicBusy) return; selectProfile($('dappChainSelect').value); });
  for (const [button, source] of [['copyWalletAccount', 'walletAccount'], ['copyKeplrShieldedAddress', 'keplrShieldedAddress']]) {
    on(button, 'click', () => invoke(() => browser.navigator.clipboard.writeText($(source).textContent)));
  }
  on('fundKeplr', 'click', () => invoke(async r => {
    if ($('fundKeplr').disabled) return;
    const stamp = generation, actor = r.session.state.actor, selectedProfile = profile, key = faucetKey(actor);
    publicBusy = true; publicController = new AbortController(); render();
    const current = () => alive && stamp === generation && r === runtime && !r.session.state.invalidated;
    try {
      await withSubmissionLock(r, async () => {
        faucetRecord = readPendingRecord(key);
        if (faucetRecord) throw new Error('Faucet request pending; inspect the previous transaction first.');
        const configuration = await loadServerConfig();
        if (!current()) return;
        serverConfig = configuration;
        if (!faucetMatchesProfile(configuration, selectedProfile)) throw new Error('Faucet is unavailable for the selected chain.');
        let result;
        try {
          result = await requestFaucet({ configuration, profile: selectedProfile, actor,
            amount: $('keplrFaucetAmount').value.trim(), signal: publicController.signal,
            beforeDispatch: () => {
              if (!current()) throw new Error('Connection changed; faucet request stopped.');
              browser.localStorage.setItem(key, JSON.stringify({ status: 'unknown' })); faucetRecord = { status: 'unknown' }; render();
            } });
        } catch (cause) {
          if (cause?.faucetRejected === true) browser.localStorage.removeItem(key);
          else if (/^[a-f0-9]{64}$/.test(cause?.hash)) {
            browser.localStorage.setItem(key, JSON.stringify({ status: 'unknown', hash: cause.hash, amount: cause.amount }));
          }
          if (current()) {
            faucetRecord = readPendingRecord(key);
            if (cause?.faucetRejected === true) {
              text('keplrFaucetHash', cause.hash); text('keplrFaucetSent', 'Rejected by chain');
            }
          }
          throw cause;
        }
        if (result.confirmed) browser.localStorage.removeItem(key);
        else browser.localStorage.setItem(key, JSON.stringify({ status: 'submitted', hash: result.hash, amount: result.amount }));
        if (!current()) return;
        faucetRecord = readPendingRecord(key);
        text('keplrFaucetHash', result.hash); text('keplrFaucetSent', result.confirmed ? result.amount : 'Pending confirmation'); text('keplrFaucetRecipient', actor.address);
        if (result.confirmed) await readBalance(r);
      });
    } finally { publicBusy = false; if (alive && stamp === generation) render(); }
  }));
  on('reconcileFaucet', 'click', () => invoke(r => withSubmissionLock(r, async () => {
    const actor = r.session.state.actor, stamp = generation, key = faucetKey(actor);
    faucetRecord = readPendingRecord(key);
    if (!faucetRecord?.hash) return;
    const record = faucetRecord;
    let settled = false, successful = false;
    if (profile.transport === 'evm') {
      const receipt = await browser.ethereum.request({ method: 'eth_getTransactionReceipt', params: [record.hash] });
      settled = receipt?.transactionHash?.toLowerCase() === record.hash.toLowerCase() && ['0x0', '0x1'].includes(receipt.status);
      successful = receipt?.status === '0x1';
    } else {
      const response = await fetchJson(`/cosmos-rest/cosmos/tx/v1beta1/txs/${encodeURIComponent(record.hash)}`, { maxBytes: 2097152, timeoutMs: 10000 });
      const tx = response.tx_response;
      settled = tx?.txhash?.toLowerCase() === record.hash.toLowerCase() && /^[1-9][0-9]*$/.test(String(tx.height)) && /^\d+$/.test(String(tx.code));
      successful = Number(tx?.code) === 0;
    }
    if (!alive || stamp !== generation || r.session.state.invalidated) return;
    if (!settled) throw new Error('Faucet transaction is still unconfirmed.');
    browser.localStorage.removeItem(key); faucetRecord = null;
    text('keplrFaucetHash', record.hash); text('keplrFaucetSent', successful ? record.amount || 'Confirmed' : 'Transaction failed');
    await readBalance(r);
  }, { allowPending: true })));
  on('sendFromKeplr', 'click', async () => {
    const r = runtime, state = r?.session.state;
    if (!alive || !r || publicBusy || state.busy || state.invalidated || sendRecord || $('sendFromKeplr').disabled) return;
    const stamp = generation; publicController = new AbortController(); publicBusy = true; localError = ''; render();
    try {
      await withSubmissionLock(r, async () => {
        const module = chainActions || await import('./sample-chain-actions.js');
        const amount = $('keplrSendAmount').value.trim(), recipient = $('keplrSendRecipient').value.trim();
        if (!/^[1-9][0-9]*$/.test(amount) || !recipient) throw new Error('Enter a positive base-unit amount and recipient.');
        const key = sendKey(state.actor);
        let attempted = false;
        try {
          const hash = await module.sendTransparent({ profile, actor: state.actor, amount, recipient, browser, signal: publicController.signal,
            isCurrent: () => alive && stamp === generation && !r.session.state.invalidated,
            beforeBroadcast: hash => {
              if (!alive || stamp !== generation || r.session.state.invalidated) throw new Error('Connection changed; submission stopped.');
              const record = { status: 'unknown', ...(hash ? { hash } : {}) };
              browser.localStorage.setItem(key, JSON.stringify(record));
              attempted = true; sendRecord = record; render();
              if (hash) text('keplrSendHash', hash);
            } });
          if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(hash)) throw new Error('Wallet returned no valid transaction hash; inspect wallet activity.');
          browser.localStorage.setItem(key, JSON.stringify({ status: 'submitted', hash }));
          sendRecord = { status: 'submitted', hash };
          if (alive && stamp === generation) text('keplrSendHash', hash);
        } catch (cause) {
          if (attempted && cause?.publicSendRejected === true) { browser.localStorage.removeItem(key); sendRecord = null; }
          throw cause;
        }
      });
    } catch (cause) { if (alive && stamp === generation) localError = `${cause.message}${sendRecord ? ' Inspect wallet activity; no automatic retry.' : ''}`; }
    finally { publicBusy = false; if (alive && stamp === generation) render(); }
  });
  on('reconcileKeplrSend', 'click', () => invoke(r => withSubmissionLock(r, async () => {
    const record = sendRecord, actor = r.session.state.actor, stamp = generation;
    if (!record?.hash) return;
    let settled;
    if (profile.transport === 'evm') {
      const receipt = await browser.ethereum.request({ method: 'eth_getTransactionReceipt', params: [record.hash] });
      settled = receipt && ['0x0', '0x1'].includes(receipt.status);
    } else {
      const result = await fetchJson(`/cosmos-rest/cosmos/tx/v1beta1/txs/${encodeURIComponent(record.hash)}`, { maxBytes: 2097152, timeoutMs: 10000 });
      settled = result.tx_response?.txhash?.toLowerCase() === record.hash.toLowerCase() && /^\d+$/.test(String(result.tx_response.height)) && BigInt(result.tx_response.height) > 0n;
    }
    if (!alive || stamp !== generation || r.session.state.invalidated) return;
    if (!settled) throw new Error('Public send still unconfirmed; inspect wallet activity.');
    browser.localStorage.removeItem(sendKey(actor)); sendRecord = null; await readBalance(r);
  }, { allowPending: true })));
  const stop = () => {
    if (!alive) return;
    alive = false; generation++; publicController?.abort(); disclosureLookup?.abort(); eventsController?.abort(); clearInterval(timer); runtime?.dispose(); listeners.forEach(remove => remove());
    browser.removeEventListener('pagehide', stop);
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  };
  browser.addEventListener('pagehide', stop);
  render();
  const ready = Promise.all([Promise.resolve().then(loadProfiles), Promise.resolve().then(loadServerConfig).catch(() => null)]).then(([value, configuration]) => {
    if (!alive) return;
    if (!value?.cosmos || !value?.evm) throw new Error('Both pinned network profiles are required.');
    profiles = value; serverConfig = configuration; $('dappChainSelect').replaceChildren();
    for (const [id, item] of Object.entries(profiles)) {
      const option = document.createElement('option'); option.value = id; option.textContent = `${item.transport === 'cosmos' ? 'Cosmos · Keplr' : 'EVM · MetaMask'} · ${item.chainId}`; $('dappChainSelect').append(option);
    }
    selectProfile('cosmos');
  }).catch(() => { if (alive) error('Cannot load the custody profiles. Build the sample with the prepared sibling custody host.'); });
  return { ready, dispose: stop, get runtime() { return runtime; } };
}
