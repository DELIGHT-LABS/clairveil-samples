import React from 'react';
import { createRoot } from 'react-dom/client';
import { CustodyApp } from './custody-view.jsx';
import { createCustodyRuntime } from './custody-app.js';

createRoot(document.getElementById('root')).render(<CustodyApp createRuntime={createCustodyRuntime} />);
