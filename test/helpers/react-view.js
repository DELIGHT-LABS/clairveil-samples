import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Keep real React imports shared with the test renderer; bundle only local JSX.
export async function importView(name) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const directory = await mkdtemp(path.join(root, '.react-test-'));
  try {
    const outfile = path.join(directory, 'view.mjs');
    await build({ absWorkingDir: root, entryPoints: [`public/${name}.jsx`], outfile,
      bundle: true, packages: 'external', format: 'esm', platform: 'node', logLevel: 'silent' });
    return await import(pathToFileURL(outfile));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function renderDappMarkup() {
  const { DappView } = await importView('dapp-view');
  // Normalize equivalent HTML boolean syntax for the existing markup assertions.
  return renderToStaticMarkup(React.createElement(DappView)).replace(/\b(disabled|hidden|checked|readonly)=""/g, '$1').replaceAll('&#x27;', "'");
}
