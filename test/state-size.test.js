const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { once } = require('node:events');
const path = require('node:path');
const test = require('node:test');

const { createSupabaseStub } = require('./supabase-stub');

const root = path.resolve(__dirname, '..');
const operator = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'operator@example.com',
  password: 'operator-password-123',
  app_metadata: { dispatch_role: 'operator' },
};

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

test('the persisted state stays bounded when history is huge', async (t) => {
  const traffic = Array.from({ length: 25000 }, (_, i) => ({
    id: `traffic-${String(i).padStart(6, '0')}`,
    siteId: 'site-1',
    at: new Date(Date.now() - (25000 - i) * 60000).toISOString(),
    currentSpeed: 40,
    freeFlowSpeed: 60,
    ratio: 0.67,
    level: 'moderate',
    provider: 'TomTom',
  }));
  const alerts = [
    {
      id: 'alert-1',
      type: 'sos',
      status: 'raised',
      raisedAt: new Date().toISOString(),
      locationHistory: Array.from({ length: 500 }, (_, i) => ({ lat: -26.1, lng: 28.05, i })),
    },
  ];
  const state = {
    version: 2,
    locationEventIds: [],
    settings: { timezone: 'Africa/Johannesburg', backupFrequency: 'hourly' },
    sites: [],
    officers: [],
    alerts,
    messages: [],
    calls: [],
    recordings: [],
    traffic,
    audit: [],
    groups: [],
    relays: [],
    regions: [],
    scheduledMessages: [],
    callPatches: [],
    emails: [],
    updatedAt: new Date().toISOString(),
  };

  const stub = createSupabaseStub({ users: [operator], unitSchemaReady: true, state });
  const stubPort = await stub.listen();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      VERCEL: '',
      NODE_ENV: 'test',
      SUPABASE_URL: `http://127.0.0.1:${stubPort}`,
      SUPABASE_ANON_KEY: 'test-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      DISPATCH_COOKIE_SECURE: 'false',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await stub.close();
  });
  await waitForServer(`${baseUrl}/api/auth/status`, child);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: operator.email, password: operator.password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const acted = await fetch(`${baseUrl}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ type: 'audit', action: 'size-check' }),
  });
  assert.equal(acted.status, 200);

  const saves = stub.requests.filter((request) => request.path.includes('dispatch_save_snapshot'));
  assert.ok(saves.length > 0, 'a snapshot save should reach Supabase');
  const payload = saves.at(-1).body.p_payload;
  assert.ok(Array.isArray(payload.traffic));
  assert.ok(payload.traffic.length <= 20000, `traffic kept ${payload.traffic.length} rows`);
  assert.equal(payload.traffic.at(-1).id, 'traffic-024999', 'the newest readings are kept');
  assert.ok(payload.alerts[0].locationHistory.length <= 200, 'SOS location history is bounded');

  const bytes = JSON.stringify(payload).length;
  t.diagnostic(`persisted snapshot: ${(bytes / 1048576).toFixed(2)} MB (was ~19 MB uncapped)`);
  assert.ok(bytes < 5 * 1024 * 1024, `snapshot is ${(bytes / 1048576).toFixed(1)} MB, expected under 5 MB`);
});
