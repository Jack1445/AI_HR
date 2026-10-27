import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

// Real cold Chrome launch in an isolated, logged-out profile. Never touches
// the user's BOSS browser or closes their browser on the normal CDP port.
const root = fileURLToPath(new URL('..', import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), 'ai-hr-detach-test-'));
const server = net.createServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
let child;
let timer;
let runError;
let browserAliveAfterDetach = false;
const start = performance.now();
try {
  const code = `
    const { ensureBrowserSession, detachBrowserSession } = await import('./dist/browser/browser_session.js');
    await ensureBrowserSession();
    await detachBrowserSession();
    console.log('DETACHED');
  `;
  child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root, windowsHide: true,
    env: { ...process.env, BOSS_BROWSER_USER_DATA_DIR: profile, BOSS_BROWSER_REMOTE_DEBUGGING_PORT: String(port), BOSS_BROWSER_HEADLESS: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const closed = once(child, 'close');
  const done = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Chrome launch did not finish in 15 seconds')), 15000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('DETACHED') && !stdout.includes('HANDLED')) {
        stdout += 'HANDLED';
        clearTimeout(timer);
        // The command has finished; its process should exit without waiting
        // for Chrome. A 2 second bound catches leaked pipe handles quickly.
        timer = setTimeout(() => reject(new Error('CLI still alive 2 seconds after detach (pipe handles leaked)')), 2000);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    closed.then(([exitCode]) => {
      clearTimeout(timer);
      if (exitCode !== 0) reject(new Error(`CLI exit ${exitCode}: ${stderr}`));
      else resolve();
    }, reject);
  });
  await done;
  assert.match(stdout, /DETACHED/);
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.ok, true, 'Chrome must remain running after CLI exits');
  browserAliveAfterDetach = true;
  console.log(JSON.stringify({ status: 'passed', elapsed_seconds: (performance.now() - start) / 1000, browserAliveAfterDetach }));
} catch (error) {
  runError = error;
  throw error;
} finally {
  clearTimeout(timer);
  // Only the browser created with this test's private profile and port.
  try {
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    await browser.close();
  } catch (error) {
    if (!runError) throw error;
    console.error(`Test-browser cleanup: ${error.message}`);
  } finally {
    if (child && child.exitCode === null) child.kill();
  }
}
