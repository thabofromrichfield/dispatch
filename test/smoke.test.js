const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createServer } = require('node:net');
const { once } = require('node:events');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
let child;
let baseUrl;

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForHttpServer(url, process) {
  const deadline = Date.now() + 10000;
  let lastError;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Dispatch exited before becoming ready (code ${process.exitCode})`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
      lastError = new Error(`Startup probe returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Dispatch did not start: ${lastError?.message || 'startup timeout'}`);
}

test('server boot and unauthenticated API contract', async t => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      VERCEL: '',
      NODE_ENV: 'test',
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      DISPATCH_COOKIE_SECURE: 'false',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  await waitForHttpServer(`${baseUrl}/`, child);

  const home = await fetch(`${baseUrl}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/i);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  const html = await home.text();
  assert.match(html, /Live unit locations/);
  assert.doesNotMatch(html, /Sandton, ZA|Sandton, Johannesburg/);

  const auth = await fetch(`${baseUrl}/api/auth/status`);
  assert.equal(auth.status, 200);
  const authStatus = await auth.json();
  assert.equal(authStatus.configured, false);
  assert.equal(authStatus.ready, false);

  const state = await fetch(`${baseUrl}/api/state`);
  assert.equal(state.status, 503);
  assert.match((await state.json()).error, /Supabase server configuration is required/i);

  const missingAsset = await fetch(`${baseUrl}/missing-client-asset.js`);
  assert.equal(missingAsset.status, 404);
});

test('maintained JavaScript sources parse cleanly', () => {
  for (const file of ['server.js', 'server-diagnostics.js', 'public/app.js', 'public/sw.js', 'android/field-app/field.js', 'android/native-bridge.js']) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr || result.stdout}`);
  }
});

test('Android WebView assets match the maintained field-app sources', async () => {
  const pairs = [
    ['android/field-app/index.html', 'android/app/src/main/assets/index.html'],
    ['android/field-app/field.css', 'android/app/src/main/assets/field.css'],
    ['android/field-app/field.js', 'android/app/src/main/assets/field.js'],
    ['android/native-bridge.js', 'android/app/src/main/assets/native-bridge.js'],
  ];
  for (const [source, packaged] of pairs) {
    assert.equal(
      await readFile(path.join(root, source), 'utf8'),
      await readFile(path.join(root, packaged), 'utf8'),
      `${packaged} is stale; run ./scripts/sync-android-assets.sh`,
    );
  }
});
