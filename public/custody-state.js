const settledStates = new Set(['completed', 'confirmed', 'cancelled']);
const terminalStates = new Set([...settledStates, 'failed', 'expired']);
const submittedStates = new Set(['submitted', 'submission_unknown']);
// Connect and disclosure never create chain signing authority. A known terminal
// outcome can be left behind; an unknown reply must still retain its fence.
const settledConsentOperation = (operation, submissionAttempted) => ['connect', 'disclosure'].includes(operation?.kind)
  && terminalStates.has(operation.state) && !operation.publicArtifact && !operation.submissionAttempt && !submissionAttempted;

// The host returns 4202 before reserving inputs or exporting an authorization.
// Other failed/expired operations can still carry outstanding authority.
export const exactWithdrawNoteRequired = operation => operation?.kind === 'withdraw' && operation.state === 'failed'
  && operation.failure?.code === 4202 && !operation.publicArtifact && !operation.submissionAttempt;
export const canResetCustodySession = state => !state.busy && !state.uncertain
  && (!state.operation || settledStates.has(state.operation.state)
    || settledConsentOperation(state.operation, state.submissionAttempted)
    || (exactWithdrawNoteRequired(state.operation) && !state.submissionAttempted));

// Operation prerequisites shared by the UI and session commands.
// The session runner separately fences busy, disposed and invalidated sessions.
export function custodyActions({ actor, connection, operation, activeOperation, uncertain, submissionAttempted, publicAccount, withdrawalPreparation }) {
  const selected = activeOperation || operation;
  const exactNoteMissing = exactWithdrawNoteRequired(operation) && !submissionAttempted;
  const consentSettled = settledConsentOperation(operation, submissionAttempted);
  const idle = Boolean(connection && !connection.recoveryAccess && !uncertain && (!operation || settledStates.has(operation.state) || consentSettled || exactNoteMissing));
  return {
    connect: Boolean(actor && !connection && !uncertain && (!operation || operation.kind === 'connect' && consentSettled)),
    deposit: idle && connection.permissions.includes('deposit.request'),
    transfer: idle && connection.permissions.includes('transfer.request') && Boolean(publicAccount?.protocol?.shieldedAddress),
    withdraw: idle && connection.permissions.includes('withdraw.request'),
    disclosure: idle && connection.permissions.includes('disclosure.request'),
    prepareWithdraw: idle && exactNoteMissing && withdrawalPreparation?.withdrawOperationId === operation.operationId
      && ['account.read', 'transfer.request', 'withdraw.request'].every(permission => connection.permissions.includes(permission)),
    resumeWithdraw: idle && operation?.kind === 'transfer' && operation.state === 'confirmed'
      && withdrawalPreparation?.transferOperationId === operation.operationId && connection.permissions.includes('withdraw.request'),
    submit: selected?.state === 'awaiting_chain_signature' && selected.accessMode !== 'recovery-only' && !connection?.recoveryAccess && !submissionAttempted,
    cancel: ['deposit', 'transfer', 'withdraw', 'disclosure'].includes(operation?.kind) && operation.state === 'awaiting_approval',
    reconcile: submittedStates.has(selected?.state) || selected?.state === 'reconciliation_required',
    poll: Boolean(operation && !terminalStates.has(operation.state))
  };
}
