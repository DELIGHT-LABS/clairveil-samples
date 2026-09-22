import React from "react";

// Mounted once: app.js owns the existing transaction controller and dynamic DOM regions.
export function DappView() {
  return (
    <>
<main className="shell">
      <DappHeader />

      <ChainSummary />

      <section className="workspace">
        <WalletSession />

        <ClairPanel />

        <VeiledPanel />

        <RelayWithdrawPanel />

        <PrivacyEvents />

        <LocalSigner />
      </section>

      <AuditorPanel />

      <EventBlocks />
    </main>

    <NoticeModal />

    <TransferFlowModal />
    </>
  );
}

function DappHeader() {
  return (
    <header className="topbar">
        <div>
          <h1>Clairveil DApp</h1>
          <p id="modeBadge" className="mode-badge">Local Note Test Web</p>
          <p><a href="http://127.0.0.1:4320/custody">Clairveil Custody 로컬 미리보기</a> <small>별도 실행: npm run start:custody</small></p>
          <label className="chain-picker">
            <span>DApp chain info</span>
            <select id="dappChainSelect"></select>
            <small id="dappChainHint">-</small>
          </label>
        </div>
        <div className="wallet-box">
          <span id="walletStatus" className="status-dot">Wallet Offline</span>
          <button id="connectWallet" type="button">Connect MetaMask</button>
          <button id="connectKeplr" type="button">Connect Keplr</button>
          <button id="disconnectWallet" type="button" hidden>Disconnect</button>
        </div>
      </header>
  );
}

function ChainSummary() {
  return (
    <section className="summary-strip" aria-label="Localnet summary">
        <article>
          <span>Block</span>
          <strong id="blockHeight">-</strong>
        </article>
        <article>
          <span>Leaves</span>
          <strong id="leafCount">-</strong>
        </article>
        <article>
          <span>Chain</span>
          <strong id="chainId">-</strong>
        </article>
        <article>
          <span>REST</span>
          <strong id="restState">-</strong>
        </article>
      </section>
  );
}

function WalletSession() {
  return (
    <div className="panel wallet-session-panel">
          <div className="panel-heading">
            <h2>Wallet Session</h2>
            <div className="session-actions">
              <button id="signSession" type="button" disabled>Sign Session</button>
            </div>
          </div>
          <dl className="facts wallet-session-facts">
            <div>
              <dt>Wallet</dt>
              <dd id="sessionWallet">Not connected</dd>
            </div>
            <div>
              <dt>Account</dt>
              <dd className="account-copy">
                <span id="walletAccount">Not connected</span>
                <button id="copyWalletAccount" type="button" disabled>Copy</button>
              </dd>
            </div>
            <div>
              <dt>Chain</dt>
              <dd id="walletChain">-</dd>
            </div>
            <div>
              <dt>Signature</dt>
              <dd id="walletSignatureHash">-</dd>
            </div>
            <div>
              <dt>Local home</dt>
              <dd id="localHome">-</dd>
            </div>
            <div>
              <dt>Wallet name</dt>
              <dd id="keplrName">-</dd>
            </div>
            <div>
              <dt>Public key</dt>
              <dd id="keplrPubkey">-</dd>
            </div>
            <div>
              <dt>Signer check</dt>
              <dd id="keplrSignerCheck">-</dd>
            </div>
            <div>
              <dt>Balance</dt>
              <dd id="keplrBalance">-</dd>
            </div>
            <div>
              <dt>Faucet tx</dt>
              <dd id="keplrFaucetHash">-</dd>
            </div>
            <div>
              <dt>Faucet sent</dt>
              <dd id="keplrFaucetSent">-</dd>
            </div>
            <div>
              <dt>Faucet recipient</dt>
              <dd id="keplrFaucetRecipient">-</dd>
            </div>
            <div>
              <dt>Clairveil shielded</dt>
              <dd className="account-copy">
                <span id="keplrShieldedAddress">Not set up</span>
                <button id="copyKeplrShieldedAddress" type="button" disabled>Copy</button>
              </dd>
            </div>
          </dl>
          <div className="split-actions">
            <button id="setupKeplrPrivacy" type="button" disabled>Setup Clairveil</button>
            <button id="refreshKeplrBalance" type="button" disabled>Refresh Balance</button>
          </div>
          <div className="copy-row">
            <div>
              <span>My disclosure pubkey</span>
              <code id="keplrDisclosurePubKey">Setup Clairveil first</code>
            </div>
            <button id="copyKeplrDisclosurePubKey" type="button" disabled>Copy</button>
          </div>
          <div className="faucet-row">
            <label className="field amount-field">
              <span>
                Faucet amount
                <small id="faucetHelpText">(CLAIR get from Alice's wallet)</small>
              </span>
              <div className="amount-control">
                <input id="keplrFaucetAmount" inputMode="decimal" defaultValue="10" />
                <span className="denom">CLAIR</span>
              </div>
            </label>
            <button id="fundKeplr" type="button" disabled>Faucet</button>
          </div>
        </div>
  );
}

function ClairPanel() {
  return (
    <div className="panel keplr-tx-panel">
          <div className="panel-heading">
            <h2>Clair</h2>
            <span id="keplrTxState" className="quiet">Ready</span>
          </div>
          <section className="balance-section" aria-labelledby="clairBalanceTitle">
            <h3 id="clairBalanceTitle">Balance</h3>
            <div className="note-summary">
              <span>Balance</span>
              <strong id="myClairBalance">-</strong>
            </div>
          </section>
          <section className="balance-section action-section" aria-labelledby="clairSendTitle">
            <h3 id="clairSendTitle">Send</h3>
            <div className="amount-row">
              <label className="field amount-field">
                <span>Send amount</span>
                <div className="amount-control">
                  <input id="keplrSendAmount" inputMode="numeric" defaultValue="1" />
                  <span className="denom">uclair</span>
                </div>
              </label>
              <button id="sendFromKeplr" type="button" disabled>Send</button>
            </div>
            <div className="field address-field">
              <label htmlFor="keplrSendRecipient"><span>Send recipient</span></label>
              <div className="address-input-wrap">
                <input id="keplrSendRecipient" placeholder="clair1..." autoComplete="off" aria-haspopup="listbox" aria-controls="keplrSendRecipientSuggestions" aria-expanded="false" />
                <div id="keplrSendRecipientSuggestions" className="address-suggestions" role="listbox" hidden></div>
              </div>
            </div>
          </section>
          <dl className="facts">
            <div>
              <dt>Send tx</dt>
              <dd id="keplrSendHash">-</dd>
            </div>
          </dl>
          <div className="notes-actions tx-reconcile-actions">
            <button id="reconcileKeplrSend" className="secondary-button" type="button" disabled>Reconcile send tx</button>
            <button id="clearPublicPendingState" className="secondary-button" type="button" hidden>Clear corrupt pending state</button>
            <button id="resetPrivatePendingState" className="secondary-button" type="button" hidden>Reviewed privacy reset</button>
          </div>
          <section className="balance-section action-section" aria-labelledby="depositVeiledTitle">
            <h3 id="depositVeiledTitle">Deposit (Move to Veiled)</h3>
            <p id="depositProverPrivacyNotice" className="inline-warning" role="note" hidden></p>
            <div className="amount-row">
              <label className="field amount-field">
                <span>Deposit amount</span>
                <div className="amount-control">
                  <input id="keplrDepositAmount" inputMode="numeric" defaultValue="1" />
                  <span className="denom">uclair</span>
                </div>
              </label>
              <div className="notes-actions">
                <button id="cancelDepositProof" className="secondary-button" type="button" hidden disabled>Cancel proof</button>
                <button id="depositFromKeplr" type="button" disabled>Deposit</button>
              </div>
            </div>
            <dl className="facts">
              <div>
                <dt>Deposit stage</dt>
                <dd id="keplrDepositStage" aria-live="polite">Not started · no broadcast</dd>
              </div>
              <div>
                <dt>Deposit tx</dt>
                <dd id="keplrDepositHash">-</dd>
              </div>
              <div>
                <dt>Deposit height</dt>
                <dd id="keplrDepositHeight">-</dd>
              </div>
              <div>
                <dt>Note recovery</dt>
                <dd id="keplrDepositRecovery">Not started</dd>
              </div>
              <div>
                <dt>Network fee</dt>
                <dd id="keplrDepositNetworkFee">Not estimated</dd>
              </div>
            </dl>
            <div className="notes-actions tx-reconcile-actions">
              <button id="reconcileKeplrDeposit" className="secondary-button" type="button" disabled>Reconcile deposit tx</button>
            </div>
          </section>
        </div>
  );
}

function VeiledPanel() {
  return (
    <div className="panel my-notes-panel">
          <div className="panel-heading">
            <h2>Veiled</h2>
          </div>
          <section className="balance-section" aria-labelledby="veiledBalanceTitle">
            <div className="balance-heading">
              <h3 id="veiledBalanceTitle">Veiled balance (Notes)</h3>
              <div className="notes-actions">
                <label className="toggle-control">
                  <input id="myKeplrSpendableOnly" type="checkbox" defaultChecked />
                  <span>Unspent only</span>
                </label>
                <label className="compact-field note-endpoint-field">
                  <span>Scan endpoint</span>
                  <select id="noteScanEndpoint" aria-label="Note scan REST endpoint"></select>
                </label>
                <button id="scanKeplrNotes" type="button" disabled>Scan</button>
                <button id="backupNoteCache" className="secondary-button" type="button" disabled>Backup cache</button>
                <button id="resetRescanNotes" className="secondary-button" type="button" disabled>Reset &amp; Rescan</button>
              </div>
            </div>
            <p id="noteSyncState" className="quiet note-sync-state">Not scanned</p>
            <div className="scan-recovery-row">
              <label className="field">
                <span>Rollback scan height</span>
                <input id="noteRollbackHeight" inputMode="numeric" placeholder="Block height to re-scan" />
              </label>
              <button id="rollbackRescanNotes" className="secondary-button" type="button" disabled>Rollback &amp; Scan</button>
            </div>
            <div className="reservation-status" role="status" aria-live="polite">
              <div>
                <span>Note reservations</span>
                <strong id="reservationState">No active note reservations</strong>
              </div>
              <button id="reconcileReservations" className="secondary-button" type="button" disabled>Reconcile</button>
            </div>
            <section id="reservationRecovery" className="reservation-recovery" aria-labelledby="reservationRecoveryTitle" hidden>
              <div className="reservation-recovery-heading">
                <div>
                  <h4 id="reservationRecoveryTitle">Reservation recovery</h4>
                  <p>Only preparations with no broadcast or relay handoff evidence can be discarded and replanned.</p>
                </div>
              </div>
              <div id="reservationRecoveryList" className="reservation-recovery-list"></div>
            </section>
            <div className="note-summary">
              <span>Available to plan</span>
              <strong id="myKeplrSpendable">-</strong>
            </div>
            <div id="myKeplrNotesList" className="notes-list"></div>
          </section>
          <section className="balance-section action-section" aria-labelledby="veiledTransferTitle">
            <div className="section-title-row">
              <h3 id="veiledTransferTitle">Transfer (Veiled Send)</h3>
              <label className="toggle-control">
                <input id="veiledDisclosureAdvanced" type="checkbox" />
                <span>Advanced</span>
              </label>
            </div>
            <div className="amount-row">
              <label className="field amount-field">
                <span>Transfer amount</span>
                <div className="amount-control">
                  <input id="veiledTransferAmount" inputMode="numeric" defaultValue="1" />
                  <span className="denom">uclair</span>
                </div>
              </label>
              <button id="transferFromVeiled" type="button" disabled>Transfer</button>
            </div>
            <div className="field address-field">
              <label htmlFor="veiledTransferRecipient"><span>Transfer recipient</span></label>
              <div className="address-input-wrap">
                <input id="veiledTransferRecipient" placeholder="clairs1..." autoComplete="off" aria-haspopup="listbox" aria-controls="veiledTransferRecipientSuggestions" aria-expanded="false" />
                <div id="veiledTransferRecipientSuggestions" className="address-suggestions" role="listbox" hidden></div>
              </div>
            </div>
            <div id="veiledDisclosureOptions" className="transfer-advanced" hidden>
              <label className="field">
                <span>Disclosure mode</span>
                <select id="veiledDisclosureMode">
                  <option value="none">None</option>
                  <option value="recipient-encrypted">Recipient encrypted</option>
                  <option value="public">Public</option>
                </select>
              </label>
              <label className="field">
                <span>Disclosure target</span>
                <input id="veiledDisclosurePubKey" placeholder="disclosure pubkey hex" />
              </label>
              <div className="disclosure-checks" aria-label="Disclosure fields">
                <label className="checkbox-control">
                  <input id="veiledDisclosureAmount" type="checkbox" defaultChecked />
                  <span>Amount + asset</span>
                </label>
                <label className="checkbox-control">
                  <input id="veiledDisclosureFrom" type="checkbox" />
                  <span>From shielded address</span>
                </label>
                <label className="checkbox-control">
                  <input id="veiledDisclosureTo" type="checkbox" />
                  <span>To shielded address</span>
                </label>
              </div>
            </div>
            <label className="checkbox-control self-view-control">
              <input id="includeSelfViewDisclosure" type="checkbox" defaultChecked />
              <span>Include encrypted self-view disclosure</span>
            </label>
            <p id="selfViewWarning" className="inline-warning" hidden>
              Self-view를 끄면 나중에 이 전송의 보낸 내역을 복구하지 못할 수 있습니다.
            </p>
            <p className="inline-warning">
              Audit disclosure는 모든 privacy transfer에 항상 포함되며, configured auditor가 amount·sender·recipient를 복호화할 수 있습니다.
            </p>
            <dl className="facts">
              <div>
                <dt>Transfer tx</dt>
                <dd id="keplrTransferHash">-</dd>
              </div>
            </dl>
          </section>
          <section className="balance-section action-section" aria-labelledby="veiledWithdrawTitle">
            <h3 id="veiledWithdrawTitle">Withdraw (Move to Clair)</h3>
            <div className="amount-row">
              <label className="field amount-field">
                <span>Withdraw amount</span>
                <div className="amount-control">
                  <input id="veiledWithdrawAmount" inputMode="numeric" defaultValue="1" />
                  <span className="denom">uclair</span>
                </div>
              </label>
              <button id="withdrawFromVeiled" type="button" disabled>Withdraw</button>
            </div>
            <div className="field address-field">
              <label htmlFor="veiledWithdrawRecipient"><span>Withdraw recipient</span></label>
              <div className="address-input-wrap">
                <input id="veiledWithdrawRecipient" placeholder="clair1..." autoComplete="off" aria-haspopup="listbox" aria-controls="veiledWithdrawRecipientSuggestions" aria-expanded="false" />
                <div id="veiledWithdrawRecipientSuggestions" className="address-suggestions" role="listbox" hidden></div>
              </div>
            </div>
            <dl className="facts">
              <div>
                <dt>Withdraw tx</dt>
                <dd id="keplrWithdrawHash">-</dd>
              </div>
              <div>
                <dt>Withdraw height</dt>
                <dd id="keplrWithdrawHeight">-</dd>
              </div>
              <div>
                <dt>Nullifier spent</dt>
                <dd id="keplrWithdrawNullifier">Not checked</dd>
              </div>
              <div>
                <dt>Transparent receive</dt>
                <dd id="keplrWithdrawReceive">Not checked</dd>
              </div>
            </dl>
          </section>
        </div>
  );
}

function RelayWithdrawPanel() {
  return (
    <div className="panel relayer-panel">
          <div className="panel-heading">
            <h2>Relay Withdraw</h2>
            <span id="relayWithdrawState" className="quiet">Ready for payload preparation</span>
          </div>
          <div className="local-signer-layout">
            <section className="local-signer-details relayer-prepare-pane" aria-labelledby="relayWithdrawPrepareTitle">
              <h3 id="relayWithdrawPrepareTitle">Prepare Payload</h3>
              <div className="amount-row">
                <label className="field amount-field">
                  <span>Withdraw amount</span>
                  <div className="amount-control">
                    <input id="relayWithdrawAmount" inputMode="numeric" defaultValue="1" />
                    <span className="denom">uclair</span>
                  </div>
                </label>
                <button id="relayWithdrawFromVeiled" type="button" disabled>Prepare</button>
              </div>
              <div className="field address-field">
                <label htmlFor="relayWithdrawRecipient"><span>Withdraw recipient</span></label>
                <div className="address-input-wrap">
                  <input id="relayWithdrawRecipient" placeholder="clair1..." autoComplete="off" aria-haspopup="listbox" aria-controls="relayWithdrawRecipientSuggestions" aria-expanded="false" />
                  <div id="relayWithdrawRecipientSuggestions" className="address-suggestions" role="listbox" hidden></div>
                </div>
              </div>
              <p className="quiet">
                Payload 준비까지만 수행하며 실제 broadcast와 수수료 지불은 relayer가 담당합니다.
              </p>
            </section>
            <section id="relayWithdrawPanel" className="local-signer-notes relay-withdraw-panel" aria-labelledby="relayWithdrawHandoffTitle">
              <h3 id="relayWithdrawHandoffTitle">Local Relayer</h3>
              <label id="relayWithdrawRecoveryChoiceField" className="field" hidden>
                <span>Pending relay recovery</span>
                <select id="relayWithdrawRecoveryChoice"></select>
              </label>
              <dl className="facts relayer-account-facts">
                <div><dt>Fee payer</dt><dd id="relayerTransparentAddress">-</dd></div>
                <div><dt>Balance</dt><dd id="relayerBalance">-</dd></div>
              </dl>
              <p className="inline-warning">
                Relayer가 자기 계정으로 수수료를 지불하고 broadcast합니다. 제출 직전에 payload에서 transaction을 다시 만들고 candidate transaction을 검증합니다.
              </p>
              <ul className="relay-warning-list">
                <li>Relayer는 user shielded secret을 알 필요가 없지만, payload/proof JSON에는 private note witness가 포함된 privacy-sensitive data가 있습니다.</li>
                <li>Recipient, chain, expiry는 변경할 수 없습니다. Creator는 fee payer relayer로 바뀔 수 있습니다.</li>
                <li>Handoff 이후 local cancel이나 reservation release는 payload를 무효화하지 않으며, relayer는 expiry 전까지 제출할 수 있습니다.</li>
                <li>Chain block time이 expiry 이상이면 payload는 만료되며 wallet이나 relayer가 연장할 수 없습니다.</li>
              </ul>
              <dl className="facts">
                <div><dt>Chain ID</dt><dd id="relayWithdrawChain">-</dd></div>
                <div><dt>Recipient</dt><dd id="relayWithdrawPreparedRecipient">-</dd></div>
                <div><dt>Expires</dt><dd id="relayWithdrawExpiry">-</dd></div>
                <div><dt>Payload hash</dt><dd id="relayWithdrawPayloadHash">-</dd></div>
              </dl>
              <label className="field">
                <span>Relayer handoff JSON</span>
                <textarea id="relayWithdrawJson" rows="10" readOnly></textarea>
              </label>
              <div className="notes-actions">
                <button id="copyRelayWithdraw" className="secondary-button" type="button" disabled>Copy JSON</button>
                <button id="downloadRelayWithdraw" className="secondary-button" type="button" disabled>Download JSON</button>
                <button id="relayPreparedWithdraw" type="button" disabled>Relay (pay fee &amp; broadcast)</button>
              </div>
              <dl className="facts relay-result-facts">
                <div><dt>Relayer tx</dt><dd id="relayWithdrawTxHashDisplay">-</dd></div>
                <div><dt>Submitted by</dt><dd id="relayWithdrawSubmittedBy">-</dd></div>
              </dl>
              <label className="field">
                <span>External relayer tx hash</span>
                <input id="relayWithdrawTxHash" placeholder="32-byte transaction hash" autoComplete="off" spellCheck="false" disabled />
              </label>
              <div className="notes-actions">
                <button id="reconcileRelayWithdraw" className="secondary-button" type="button" disabled>Reconcile relay result</button>
              </div>
              <p id="relayWithdrawResult" className="quiet" role="status">Not checked</p>
            </section>
          </div>
        </div>
  );
}

function PrivacyEvents() {
  return (
    <section className="events-section">
          <div className="section-heading">
            <h2>Privacy Events</h2>
            <button id="refreshEvents" type="button">Refresh Events</button>
          </div>
          <div className="events-layout">
            <div id="eventsList" className="events-list"></div>
            <div className="event-detail">
              <h3>Event Detail</h3>
              <dl className="facts event-facts">
                <div>
                  <dt>Event</dt>
                  <dd id="eventDetailType">-</dd>
                </div>
                <div>
                  <dt>Height</dt>
                  <dd id="eventDetailHeight">-</dd>
                </div>
                <div>
                  <dt>Tx</dt>
                  <dd id="eventDetailTx">-</dd>
                </div>
                <div>
                  <dt>User mode</dt>
                  <dd id="eventDetailUserMode">-</dd>
                </div>
                <div>
                  <dt>Plane</dt>
                  <dd id="eventDisclosurePlane">-</dd>
                </div>
                <div>
                  <dt>Policy</dt>
                  <dd id="eventDisclosurePolicy">-</dd>
                </div>
                <div>
                  <dt>Output index</dt>
                  <dd id="eventDisclosureOutputIndex">-</dd>
                </div>
                <div>
                  <dt>Commitment</dt>
                  <dd id="eventDisclosureCommitment">-</dd>
                </div>
                <div>
                  <dt>Digest</dt>
                  <dd id="eventDisclosureDigest">-</dd>
                </div>
                <div>
                  <dt>Verified</dt>
                  <dd id="eventDisclosureVerified">-</dd>
                </div>
                <div>
                  <dt>Disclosure target</dt>
                  <dd id="eventDetailTarget">-</dd>
                </div>
                <div>
                  <dt>Fields</dt>
                  <dd id="eventDisclosureFields">-</dd>
                </div>
                <div>
                  <dt>Amount</dt>
                  <dd id="eventDisclosureAmount">-</dd>
                </div>
                <div>
                  <dt>From</dt>
                  <dd id="eventDisclosureFrom">-</dd>
                </div>
                <div>
                  <dt>To</dt>
                  <dd id="eventDisclosureTo">-</dd>
                </div>
              </dl>
              <div className="split-actions">
                <button id="decodeEventDisclosure" type="button" disabled>User disclosure</button>
                <button id="decodeSelfViewDisclosure" type="button" disabled>Self-view</button>
              </div>
              <div className="disclosure-source">
                <label className="field">
                  <span>Disclosure plane</span>
                  <select id="disclosureSourcePlane">
                    <option value="user">User</option>
                    <option value="self-view">Self-view</option>
                    <option value="audit">Audit (local admin only)</option>
                  </select>
                </label>
                <label className="field">
                  <span>Arbitrary tx hash</span>
                  <input id="disclosureSourceTxHash" placeholder="Tx hash outside the current event page" autoComplete="off" />
                </label>
                <label className="field">
                  <span>Pasted disclosure event JSON</span>
                  <textarea id="disclosureSourceEventJson" rows="5" placeholder='{"event_type":"shielded_transfer", ...}'></textarea>
                </label>
                <button id="decodeDisclosureSource" type="button">Decode source</button>
                <p className="quiet">Paste an event JSON to decode it locally, or leave it empty and enter a tx hash.</p>
              </div>
              <p id="eventDisclosureState" className="quiet">Select an event.</p>
            </div>
          </div>
        </section>
  );
}

function LocalSigner() {
  return (
    <div className="panel account-panel local-signer-panel">
          <div className="panel-heading">
            <h2>Local Signer</h2>
            <button id="refreshAll" type="button">Refresh</button>
          </div>
          <div className="local-signer-layout">
            <div className="local-signer-details">
              <label className="field">
                <span>Test key</span>
                <select id="accountSelect"></select>
              </label>
              <dl className="facts">
                <div>
                  <dt>Transparent</dt>
                  <dd id="transparentAddress">-</dd>
                </div>
                <div>
                  <dt>Shielded</dt>
                  <dd id="shieldedAddress">-</dd>
                </div>
                <div>
                  <dt>Balance</dt>
                  <dd id="balanceValue">-</dd>
                </div>
              </dl>
            </div>
            <section className="local-signer-notes" aria-labelledby="localSignerNotesTitle">
              <div className="panel-heading">
                <h3 id="localSignerNotesTitle">Notes</h3>
                <button id="refreshNotes" type="button">Scan</button>
              </div>
              <div className="note-summary">
                <span>Spendable</span>
                <strong id="spendableTotal">-</strong>
              </div>
              <div id="notesList" className="notes-list"></div>
            </section>
          </div>
        </div>
  );
}

function AuditorPanel() {
  return (
    <section className="auditor-section">
        <div className="section-heading">
          <h2>Auditor</h2>
          <button id="refreshAuditorTransfers" type="button">Refresh</button>
        </div>
        <div className="auditor-layout">
          <div className="audit-pane">
            <h3>Audit Transfers</h3>
            <div id="auditorEventsList" className="audit-list"></div>
          </div>
          <div className="audit-pane audit-detail">
            <h3>Transfer Detail</h3>
            <div className="test-scalar-box">
              <span>Test Private disclosure scalar</span>
              <code id="auditorTestScalar">-</code>
              <button id="decodeAuditorTransfer" type="button" disabled>Decode</button>
            </div>
            <div className="admin-warning" role="note">
              <strong>DEV / ADMIN TEST ONLY</strong>
              <span>Decode with the local admin test scalar only in a trusted local or admin environment.</span>
              <span>Do not use this field in a public user-facing DApp.</span>
            </div>
            <dl className="facts audit-facts">
              <div>
                <dt>Tx</dt>
                <dd id="auditorTxHash">-</dd>
              </div>
              <div>
                <dt>Verified / height</dt>
                <dd id="auditorVerification">-</dd>
              </div>
              <div>
                <dt>Amount / target</dt>
                <dd id="auditorAmount">-</dd>
              </div>
              <div>
                <dt>Audit digest</dt>
                <dd id="auditorDigest">-</dd>
              </div>
              <div>
                <dt>Plane / policy</dt>
                <dd id="auditorPlanePolicy">-</dd>
              </div>
              <div>
                <dt>Output index</dt>
                <dd id="auditorOutputIndex">-</dd>
              </div>
              <div>
                <dt>Commitment</dt>
                <dd id="auditorCommitment">-</dd>
              </div>
              <div>
                <dt>From / payload</dt>
                <dd id="auditorFrom">-</dd>
              </div>
              <div>
                <dt>Visible data</dt>
                <dd id="auditorFields">-</dd>
              </div>
              <div>
                <dt>To / status</dt>
                <dd id="auditorTo">-</dd>
              </div>
            </dl>
            <p id="auditorDecodeState" className="quiet">Select a transfer.</p>
          </div>
        </div>
      </section>
  );
}

function EventBlocks() {
  return (
    <section className="event-block-section">
        <div className="event-block-heading">
          <h2>Event Block</h2>
          <span id="blockEventsState" className="quiet">Recent chain txs</span>
        </div>
        <div id="blockEventsList" className="block-events-list"></div>
      </section>
  );
}

function NoticeModal() {
  return (
    <div id="noticeModal" className="modal-backdrop" hidden>
      <section className="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="noticeTitle">
        <div className="modal-heading">
          <h2 id="noticeTitle">Clairveil</h2>
          <button id="closeNoticeModal" className="icon-button" type="button" aria-label="Close">X</button>
        </div>
        <p id="noticeMessage"></p>
      </section>
    </div>
  );
}

function TransferFlowModal() {
  return (
    <div id="transferFlowModal" className="modal-backdrop" hidden>
      <section className="modal-dialog transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="transferFlowTitle">
        <div className="modal-heading">
          <h2 id="transferFlowTitle">Privacy Transfer 확인</h2>
          <span id="transferModalState" className="modal-state">확인 필요</span>
        </div>
        <p id="transferModalLead" className="modal-copy">
          입력하신 금액을 보낼 수 있도록 note 구성을 먼저 확인합니다. 필요한 경우 self transaction 서명이 먼저 요청됩니다.
        </p>
        <p id="proverPrivacyWarning" className="inline-warning">
          Remote prover에는 선택된 private note witness가 전달됩니다. 설정된 동일 endpoint에서만 retry하며 자동 failover하지 않습니다.
        </p>
        <dl id="transferReviewFacts" className="review-facts">
          <div><dt>Chain ID</dt><dd id="reviewChain">-</dd></div>
          <div><dt>Recipient</dt><dd id="reviewRecipient">-</dd></div>
          <div><dt>Amount</dt><dd id="reviewAmount">-</dd></div>
          <div><dt>Disclosure</dt><dd id="reviewDisclosure">-</dd></div>
          <div><dt>Self-view</dt><dd id="reviewSelfView">-</dd></div>
          <div><dt>Change effect</dt><dd id="reviewChangeEffect">Pending payload preparation</dd></div>
          <div><dt>Expires</dt><dd id="reviewExpiry">-</dd></div>
        </dl>
        <ol id="transferSteps" className="transfer-steps" aria-label="Privacy transfer signing steps">
          <li id="transferStepZero" data-transfer-step="zero">
            <span className="step-index">1</span>
            <div>
              <strong id="transferStepZeroTitle">노트 준비</strong>
              <span id="transferStepZeroCopy">입력하신 금액의 노트를 만들기 위해 self transaction이 필요한지 확인합니다.</span>
              <dl id="transferPlannerFacts" className="transfer-planner-facts" hidden>
                <div>
                  <dt>요청 금액</dt>
                  <dd id="transferPlannerRequested">-</dd>
                </div>
                <div>
                  <dt>현재 바로 보낼 수 있는 가장 큰 금액</dt>
                  <dd id="transferPlannerCurrentMax">-</dd>
                </div>
                <div>
                  <dt>이번 self transaction</dt>
                  <dd id="transferPlannerAction">-</dd>
                </div>
              </dl>
            </div>
          </li>
          <li id="transferStepTransfer" data-transfer-step="transfer">
            <span className="step-index">2</span>
            <div>
              <strong id="transferStepTransferTitle">트랜스퍼 서명</strong>
              <span id="transferStepTransferCopy">준비된 note로 실제 privacy transfer를 요청합니다. Keplr에서 내용을 확인하고 서명합니다.</span>
            </div>
          </li>
        </ol>
        <div id="transferSuccessPanel" className="transfer-result" hidden>
          <strong id="transferSuccessTitle">트랜스퍼 요청이 성공하였습니다</strong>
          <span id="transferSuccessCopy">최신 notes를 다시 스캔한 상태입니다.</span>
        </div>
        <div id="transferFailurePanel" className="transfer-result transfer-result-error" hidden>
          <strong id="transferFailureTitle">트랜스퍼 요청이 실패했습니다</strong>
          <span id="transferFailureReason">-</span>
        </div>
        <div className="modal-actions">
          <button id="cancelTransferFlow" className="secondary-button" type="button">취소</button>
          <button id="retryTransferFlow" className="secondary-button" type="button" hidden>같은 prover로 재시도</button>
          <button id="confirmTransferFlow" type="button">시작</button>
        </div>
      </section>
    </div>
  );
}
