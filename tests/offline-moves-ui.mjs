import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { Library } from '../server/library.mjs';
import { reconcileRoot } from '../server/reconcile.mjs';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-offline-ui-')));
const dataDir = path.join(temp, 'data');
const rootPath = path.join(temp, 'music');
await fs.mkdir(rootPath);
const original = path.join(rootPath, 'offline-fixture.wav');
await fs.writeFile(original, 'disposable audio fixture');
const lib = await new Library(dataDir, { directoryClassification: true }).init();
lib.enqueue = () => {};
const root = await lib.addRoot(rootPath, 'music');
await reconcileRoot(lib, root, { tagFiles: false, hashBudgetFiles: 0, hashBudgetBytes: 0 });
const asset = lib.list().items[0];
const movedPath = path.join(temp, 'moved-fixture.wav');
await fs.rename(original, movedPath);
lib.db.prepare("UPDATE assets SET online=0,file_status='unknown' WHERE id=?").run(asset.id);
lib.db.close();
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: project, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', MEDIA_DATA_DIR: dataDir, MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1',
    MEDIA_NO_WATCH: '1', MEDIA_READONLY_FILES: '1', SHIGUANG_AUDIO_ANALYSIS: '0',
    SHIGUANG_CLOUD_RELEASE_CONFIG: path.join(temp, 'no-release.json'), PORT: String(port) },
});
let log = '', browser;
child.stdout.on('data', value => { log += value; });
child.stderr.on('data', value => { log += value; });
try {
  for (let i = 0; i < 450 && !log.includes('拾光素材库 http://'); i++) {
    if (child.exitCode !== null) throw Error(log);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const url = log.match(/拾光素材库 (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  if (!url) throw Error('Isolated server startup timed out: ' + log);
  browser = await chromium.launch({ headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByRole('button', { name: /离线素材/ }).click();
  const single = page.getByRole('button', { name: '核对并清理库内记录：offline-fixture.wav', exact: true });
  await expect(single).toBeVisible();
  await single.click();
  const dialog = page.getByRole('dialog', { name: '确认清理失效记录' });
  await expect(dialog.getByText('offline-fixture.wav', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/不删除原文件/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: '确认清理关联记录', exact: true })).toBeEnabled();
  await page.screenshot({ path: path.join(temp, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(temp, 'mobile.png') });
  await dialog.getByRole('button', { name: '确认清理关联记录', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('已清理 1 条，保留 0 条。');
  expect(await fs.readFile(movedPath, 'utf8')).toBe('disposable audio fixture');
  expect((await fs.readdir(path.join(dataDir, 'missing-file-backups'))).length).toBe(1);
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks: ['offline entry', 'live route preview',
    'explicit confirmation', 'index-only cleanup', 'backup exists', 'moved bytes retained', 'no page errors'], evidence: temp }));
} finally {
  await browser?.close();
  if (child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(force);
  }
}
