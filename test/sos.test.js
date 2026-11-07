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
const officer = {
  id: 'officer-1',
  name: 'Thabo M',
  callSign: 'UNIT-1',
  group: 'Alpha',
  shiftId: 'shift-1',
  siteId: null,
  status: 'on-site',
  online: true,
  tracking: true,
  stunned: false,
  lastSeen: new Date().toISOString(),
  lat: -26.1,
  lng: 28.05,
  accuracy: 12,
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

test('a retried SOS press never raises a second alarm', async (t) => {
  const state = {
    version: 2,
    locationEventIds: [],
    settings: { timezone: 'Africa/Johannesburg' },
    sites: [],
    officers: [officer],
    alerts: [],
    messages: [],
    calls: [],
    recordings: [],
    traffic: [],
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
  const post = async (body) => {
    const response = await fetch(`${baseUrl}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `action ${body.type} failed`);
    return response.json().catch(() => ({}));
  };
  const sosAlerts = async () => {
    const response = await fetch(`${baseUrl}/api/state`, { headers: { cookie } });
    const snapshot = await response.json();
    return snapshot.alerts.filter((a) => a.type === 'sos');
  };

  const pressedAt = new Date().toISOString();
  await post({
    type: 'sos',
    officerId: officer.id,
    raisedAt: pressedAt,
    offline: false,
    location: { lat: -26.1, lng: 28.05, accuracy: 10, locationAt: pressedAt, battery: 80 },
  });
  let alerts = await sosAlerts();
  assert.equal(alerts.length, 1, 'the press raises exactly one alert');

  const note = 'Checked by control';
  await post({ type: 'alert-status', id: alerts[0].id, status: 'handled', note });
  alerts = await sosAlerts();
  assert.equal(alerts[0].status, 'handled');

  // The phone (or its offline queue) resends the same press after control resolved it.
  await post({
    type: 'sos',
    officerId: officer.id,
    raisedAt: pressedAt,
    offline: false,
    location: { lat: -26.1, lng: 28.05, accuracy: 10, locationAt: pressedAt, battery: 80 },
  });
  alerts = await sosAlerts();
  assert.equal(alerts.length, 1, 'a retried press does not raise a second alarm');
  assert.equal(alerts[0].status, 'handled', 'a retried press cannot un-resolve a handled alert');

  // A genuinely new press must still alert.
  await post({
    type: 'sos',
    officerId: officer.id,
    raisedAt: new Date(Date.now() + 1000).toISOString(),
    offline: false,
    location: { lat: -26.1, lng: 28.05, accuracy: 10, locationAt: pressedAt, battery: 79 },
  });
  alerts = await sosAlerts();
  assert.equal(alerts.length, 2, 'a new press raises a new alert');
  assert.equal(alerts.filter((a) => a.status === 'raised').length, 1);
});
