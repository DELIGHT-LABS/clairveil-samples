import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { DappView } from './dapp-view.jsx';

// This document-lifetime controller must see committed DOM before it subscribes
// to wallets. Never restart it as a render effect or on a client-side route change.
flushSync(() => createRoot(document.getElementById('root')).render(<DappView custody />));
const { startSampleCustody } = await import('./sample-custody-app.js');
const { createCustodyRuntime } = await import('./custody-runtime.js');
startSampleCustody({ createRuntime: createCustodyRuntime });
