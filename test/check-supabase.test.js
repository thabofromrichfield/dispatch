const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const { createSupabaseStub } = require('./supabase-stub');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts/check-supabase.js');

// Async spawn: the stub server runs in this process, so a blocking spawn would deadlock it.
function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('check:supabase reports a healthy project', async (t) => {
  const stub = createSupabaseStub({
    users: [{ id: 'u1', email: 'op@example.com', app_metadata: {} }],
    state: { officers: [], updatedAt: new Date().toISOString() },
  });
  const port = await stub.listen();
  t.after(() => stub.close());

  const result = await run({
    SUPABASE_URL: `http://127.0.0.1:${port}`,
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /All checks passed/);
  assert.doesNotMatch(result.stdout, /FAIL/);
});

test('check:supabase names the missing credentials layer', async () => {
  const result = await run({});
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL {2}Credentials/);
  assert.match(result.stdout, /\.env/);
});

test('check:supabase flags an unreachable project', async () => {
  const result = await run({
    SUPABASE_URL: 'http://127.0.0.1:1',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL {2}Auth API reachable/);
  assert.match(result.stdout, /paused/);
});
