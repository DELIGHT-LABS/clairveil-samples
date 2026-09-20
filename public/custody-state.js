const settledStates = new Set(['completed', 'confirmed', 'cancelled']);
const terminalStates = new Set([...settledStates, 'failed', 'expired']);
const submittedStates = new Set(['submitted', 'submission_unknown']);

// Operation prerequisites shared by the UI and session commands.
// The session runner separately fences busy, disposed and invalidated sessions.
export function custodyActions({ actor, connection, operation, uncertain, submissionAttempted }) {
  return {
    connect: Boolean(actor && !operation && !uncertain),
    deposit: Boolean(connection && !uncertain && (!operation || settledStates.has(operation.state))),
    submit: operation?.state === 'awaiting_chain_signature' && !submissionAttempted,
    cancel: operation?.kind === 'deposit' && operation.state === 'awaiting_approval',
    reconcile: submittedStates.has(operation?.state),
    poll: Boolean(operation && !terminalStates.has(operation.state))
  };
}
