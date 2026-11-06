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
const fieldUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'unit12@example.com',
  password: 'field-password-123456',
  app_metadata: { dispatch_role: 'field' },
};
const unassignedFieldUser = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'unit07@example.com',
  password: 'field-password-123456',
  app_metadata: { dispatch_role: 'field' },
};
const unconfirmedUser = {
  id: '44444444-4444-4444-8444-444444444444',
  email: 'new@example.com',
  password: 'unconfirmed-password-1',
  confirmed: false,
  app_metadata: { dispatch_role: 'operator' },
};

function seedState() {
  const at = new Date().toISOString();
  return {
    version: 2,
    locationEventIds: [],
    lastAutoBackup: null,
    settings: { timezone: 'Africa/Johannesburg', backupFrequency: 'hourly' },
    sites: [],
    officers: [
      {
        id: 'officer-01',
        name: 'Amara Dlamini',
        callSign: 'Unit 12',
        group: 'Central',
        status: 'off-duty',
        shiftId: null,
        online: false,
      },
    ],
    alerts: [],
    messages: [],
    calls: [],
    recordings: [],
    traffic: [],
    audit: [],
    groups: ['Central'],
    relays: [],
    regions: [],
    scheduledMessages: [],
    callPatches: [],
    emails: [],
    updatedAt: at,
  };
}

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

function jarFrom(response) {
  const jar = {};
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    jar[pair.slice(0, index)] = decodeURIComponent(pair.slice(index + 1));
  }
  return jar;
}

const cookieHeader = (jar) =>
  Object.entries(jar)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');

test('authentication against a Supabase stub', async (t) => {
  const stub = createSupabaseStub({
    users: [operator, fieldUser, unassignedFieldUser, unconfirmedUser],
    accounts: [{ user_id: fieldUser.id, officer_id: 'officer-01' }],
    unitSchemaReady: true,
    state: seedState(),
    unitState: [
      {
        officer_id: 'officer-01',
        payload: { officer: { id: 'officer-01', callSign: 'Unit 12' }, messages: [], alerts: [] },
        updated_at: new Date().toISOString(),
      },
    ],
  });
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

  const status = await (await fetch(`${baseUrl}/api/auth/status`)).json();
  assert.equal(status.configured, true);
  assert.equal(status.ready, true);
  assert.equal(status.unitSchemaReady, true);
  assert.deepEqual(status.checks, {
    auth: true,
    database: true,
    serviceRole: true,
    stateRow: true,
    unitSchema: true,
    signupDisabled: true,
  });
  assert.equal(status.message, null);

  const login = (email, password) =>
    fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

  await t.test('wrong password is rejected with a sign-in error, not a server error', async () => {
    const response = await login(operator.email, 'not-the-password');
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'Email or password is incorrect.');
  });

  await t.test('an unconfirmed email gets an actionable message', async () => {
    const response = await login(unconfirmedUser.email, unconfirmedUser.password);
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /not confirmed/i);
  });

  await t.test('operator signs in and receives session cookies', async () => {
    const response = await login(operator.email, operator.password);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.role, 'operator');
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.ok(cookies.every((line) => /HttpOnly/i.test(line)), 'cookies must be HttpOnly');
    assert.ok(cookies.every((line) => /SameSite=Strict/i.test(line)), 'cookies must be SameSite=Strict');
    t.diagnostic(`cookies: ${cookies.map((line) => line.split(';')[0]).join(' ')}`);
  });

  await t.test('session cookie opens the operator API and survives expiry via refresh', async () => {
    const jar = jarFrom(await login(operator.email, operator.password));
    assert.ok(jar.dispatch_access && jar.dispatch_refresh);

    const state = await fetch(`${baseUrl}/api/state`, { headers: { cookie: cookieHeader(jar) } });
    assert.equal(state.status, 200);
    assert.ok(Array.isArray((await state.json()).officers));

    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: cookieHeader(jar) } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.email, operator.email);

    // Fresh session: its access token is not in the server's 30s success cache.
    const jar2 = jarFrom(await login(operator.email, operator.password));

    // Access token expires; the refresh token must transparently renew the session.
    stub.expireAccessTokens();
    const renewed2 = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: cookieHeader(jar2) } });
    assert.equal(renewed2.status, 200, 'expired access token should refresh, not sign the user out');
    const rotated2 = jarFrom(renewed2);
    assert.ok(rotated2.dispatch_access && rotated2.dispatch_access !== jar2.dispatch_access, 'access cookie rotates');
    const afterRefresh = await fetch(`${baseUrl}/api/state`, { headers: { cookie: cookieHeader(rotated2) } });
    assert.equal(afterRefresh.status, 200);
  });

  await t.test('field account is limited to its own unit', async () => {
    const jar = jarFrom(await login(fieldUser.email, fieldUser.password));
    const fieldState = await fetch(`${baseUrl}/api/field/state?scope=unit&officerId=officer-01`, {
      headers: { cookie: cookieHeader(jar) },
    });
    assert.equal(fieldState.status, 200);

    const operatorState = await fetch(`${baseUrl}/api/state`, { headers: { cookie: cookieHeader(jar) } });
    assert.equal(operatorState.status, 403);

    const takeover = await fetch(`${baseUrl}/api/field/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieHeader(jar) },
      body: JSON.stringify({ type: 'clock-in', officerId: 'officer-99' }),
    });
    assert.equal(takeover.status, 403, 'a field account cannot act for another unit');
  });

  await t.test('field account without a unit mapping is refused at sign-in', async () => {
    const response = await login(unassignedFieldUser.email, unassignedFieldUser.password);
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /no active unit assignment/i);
  });

  await t.test('sign-out clears the session', async () => {
    const jar = jarFrom(await login(operator.email, operator.password));
    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookieHeader(jar) },
    });
    assert.equal(logout.status, 200);
    const cleared = jarFrom(logout);
    assert.equal(cleared.dispatch_access, '');

    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: cookieHeader(cleared) } });
    assert.equal(me.status, 401);
  });

  await t.test('repeated failures are rate limited, and a spoofed forwarded IP does not reset it', async () => {
    let last;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      last = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.0.0.${attempt}` },
        body: JSON.stringify({ email: operator.email, password: 'wrong-password' }),
      });
    }
    assert.equal(last.status, 429);
  });
});
