import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Actual samples React bundle + actual CC-004 bridge/vault. Synthetic chain
// wallets expose public actors only; any signature or broadcast fails this run.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const custody = path.resolve(root, process.env.CLAIRVEIL_CUSTODY_DIR || '../clairveil-custody');
const requireCustody = createRequire(path.join(custody, 'package.json'));
const { chromium, expect } = requireCustody('@playwright/test');
const { fixtureActor } = await import(pathToFileURL(path.join(custody, '.spike-build/cc003-vault/unit/deposit-fixture.js')));
const profiles = JSON.parse(await readFile(path.join(root, 'public/custody-profiles.json')));
const extension = path.join(custody, '.spike-build/cc004-host/extension');
const evidence = JSON.parse(await readFile(path.join(root, 'public/custody-build.json')));
if (evidence.host !== 'CC-004') throw new Error('CC004_BUILD_REQUIRED');
for (const [directory, files] of [[path.join(root, 'public'), evidence.files], [path.join(custody, '.spike-build/cc004-host'), evidence.sourceBuild]]) {
  for (const [name, expected] of Object.entries(files)) {
    if (createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex') !== expected) throw new Error('CUSTODY_BUILD_BYTES_CHANGED');
  }
}
const temp = await mkdtemp(path.join(tmpdir(), 'cc004-samples-'));
let context;
try {
  context = await chromium.launchPersistentContext(temp, { channel: 'chromium', headless: true,
    args: ['--headless=new', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  // Serve exact built samples assets in this disposable context only. This also
  // works when no preview server is running, without replacing a user's server.
  const assets = { '/custody': 'custody.html', '/custody.bundle.js': 'custody.bundle.js', '/custody.css': 'custody.css', '/custody-profiles.json': 'custody-profiles.json' };
  await context.route('http://127.0.0.1:4320/**', async route => {
    const asset = assets[new URL(route.request().url()).pathname];
    if (!asset) throw new Error('UNEXPECTED_SAMPLE_NETWORK_REQUEST');
    await route.fulfill({ path: path.join(root, 'public', asset) });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const host = await context.newPage(); await host.goto(`chrome-extension://${new URL(worker.url()).host}/workbench.html`);
  await expect(host.locator('#create')).toBeEnabled();
  await host.locator('#password').fill('Disposable sample integration test'); await host.locator('#confirm').fill('Disposable sample integration test'); await host.locator('#create').click();
  await expect(host.locator('#state')).toHaveAttribute('data-state', 'unlocked', { timeout: 30000 });
  await host.locator('#export').click(); await expect(host.locator('#download')).toBeEnabled();
  let code = await host.locator('#export-code').inputValue();
  const download = host.waitForEvent('download'); await host.locator('#download').click();
  await host.locator('#backup-file').setInputFiles(await (await download).path());
  await host.locator('#recovery-code').fill(code); code = ''; await host.locator('#verify').click();
  await expect(host.locator('#backup-state')).toHaveAttribute('data-verified', 'true', { timeout: 30000 });
  for (const transport of ['cosmos', 'evm']) {
    const profile = profiles[transport], actor = fixtureActor(transport);
    await host.locator(`[data-activate="${profile.id}"]`).click();
    await expect(host.locator(`[data-activate="${profile.id}"]`)).toBeDisabled();
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ profile, actor }) => {
      window.signatureCalls = 0;
      const forbidden = () => { window.signatureCalls++; throw new Error('SIGNING_NOT_ALLOWED_IN_THIS_TEST'); };
      window.keplr = { experimentalSuggestChain: async () => {}, enable: async () => {}, signDirect: forbidden,
        getKey: async () => ({ bech32Address: actor.address, pubKey: new Uint8Array((actor.pubKeyHex?.match(/../g) ?? []).map(byte => parseInt(byte, 16))) }) };
      window.ethereum = { on() {}, removeListener() {}, request: async ({ method }) => {
        if (method === 'eth_chainId') return profile.evmChainId;
        if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [actor.address];
        if (['wallet_addEthereumChain', 'wallet_switchEthereumChain'].includes(method)) return null;
        return forbidden();
      } };
    }, { profile, actor });
    await page.goto('http://127.0.0.1:4320/custody');
    await expect(page.locator('#network')).toBeEnabled(); await page.locator('#network').selectOption(transport);
    await page.locator('#wallet').click(); await expect(page.locator('#connect')).toBeEnabled();
    await page.locator('#readBalances').check(); await page.locator('#connect').click();
    await expect(page.locator('#operationId')).not.toHaveText('—');
    const connectionId = await page.locator('#operationId').textContent();
    await host.locator(`[data-approval="true"][data-operation="${connectionId}"]`).click();
    await expect(page.locator('#deposit')).toBeEnabled({ timeout: 15000 });
    await page.locator('#balances').click(); await expect(page.locator('#balanceStatus')).toContainText('동기화 상태:');
    await host.locator(`[data-refresh-balances="${profile.id}"]`).click();
    await expect(host.locator(`[data-refresh-balances="${profile.id}"]`)).toBeEnabled({ timeout: 60000 });
    await page.locator('#balances').click(); await expect(page.locator('#balanceRows')).toContainText('사용 가능 0 / 예약 0', { timeout: 15000 });
    await page.locator('#deposit').click(); await expect(page.locator('#cancel')).toBeEnabled();
    await expect(page.locator('#submit')).toBeDisabled(); await page.locator('#cancel').click();
    await expect(page.locator('#operationState')).toHaveText('취소됨');
    if (await page.evaluate(() => window.signatureCalls) !== 0 || errors.length) throw new Error('SAMPLE_BROWSER_FAILURE');
    await page.locator('#disconnect').click(); await expect(page.locator('#submit')).toBeDisabled();
    console.log(JSON.stringify({ transport, connection: 'approved', balances: 'verified-zero', deposit: 'cancelled-before-export', signatures: 0, broadcasts: 0, pageErrors: 0 }));
    await page.close();
  }
  await host.locator('#lock').click();
} finally { await context?.close(); await rm(temp, { recursive: true, force: true }); }
