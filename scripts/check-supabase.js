#!/usr/bin/env node
// Supabase readiness check. Run with the same environment as the server:
//   npm run check:supabase
// It prints each layer sign-in depends on and what to do when one fails.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadEnv() {
  try {
    for (const raw of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(String.fromCharCode(10))) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      if (process.env[key] === undefined) process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
}

async function probe(url, headers, options = {}) {
  try {
    const response = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 0, error };
  }
}

async function main() {
  loadEnv();
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const anon = process.env.SUPABASE_ANON_KEY || '';
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const results = [];
  const record = (name, ok, detail, fix) => results.push({ name, ok, detail, fix });

  if (!url || !anon || !service) {
    record(
      'Credentials',
      false,
      'SUPABASE_URL, SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY is missing',
      'Set all three in .env (local) or Vercel → Settings → Environment Variables, then redeploy.',
    );
    return report(results);
  }
  let validUrl = false;
  try {
    const parsed = new URL(url);
    validUrl = ['https:', 'http:'].includes(parsed.protocol);
    record('Project URL', validUrl, url, validUrl ? '' : 'The URL must start with https://');
    if (!validUrl) return report(results);
  } catch {
    record('Project URL', false, url || '(empty)', 'SUPABASE_URL is not a valid URL. Copy it from Supabase → Settings → API.');
    return report(results);
  }

  const [settings, stateRow, schema, users] = await Promise.all([
    probe(`${url}/auth/v1/settings`, { apikey: anon }),
    probe(`${url}/rest/v1/dispatch_state?select=id&id=eq.1`, {
      apikey: service,
      Authorization: `Bearer ${service}`,
    }),
    probe(`${url}/rest/v1/rpc/dispatch_unit_schema_ready`, {
      apikey: service,
      Authorization: `Bearer ${service}`,
      'Content-Type': 'application/json',
    }, { method: 'POST', body: '{}' }),
    probe(`${url}/auth/v1/admin/users?page=1&per_page=1`, {
      apikey: service,
      Authorization: `Bearer ${service}`,
    }),
  ]);

  record(
    'Auth API reachable',
    settings.ok,
    settings.ok ? 'reachable' : `HTTP ${settings.status}`,
    'Check the project URL and that the Supabase project is not paused (free projects pause after a week idle).',
  );
  record(
    'Anon key',
    settings.ok,
    settings.ok ? 'accepted' : `HTTP ${settings.status}`,
    'Copy the anon/public key from Supabase → Settings → API. Do not use the service-role key here.',
  );
  record(
    'Database reachable',
    stateRow.ok,
    stateRow.ok ? 'reachable' : `HTTP ${stateRow.status}`,
    'Check the service-role key. It bypasses RLS and must be the secret key, not the anon key.',
  );
  if (stateRow.ok)
    record(
      'dispatch_state row',
      Array.isArray(stateRow.data) && stateRow.data.length > 0,
      Array.isArray(stateRow.data) && stateRow.data.length ? 'present' : 'missing',
      'Run the full supabase/schema.sql in the Supabase SQL editor. The server creates this row on first successful boot.',
    );
  record(
    'Unit tables (schema.sql)',
    schema.ok && schema.data === true,
    schema.ok ? String(schema.data) : `HTTP ${schema.status}`,
    'Run the current supabase/schema.sql in the Supabase SQL editor, then reload the console.',
  );
  record(
    'Service-role key',
    users.ok,
    users.ok ? 'admin API accepted' : `HTTP ${users.status}`,
    'Use the service_role secret key. The anon key cannot list or create users.',
  );
  if (settings.ok)
    record(
      'Public sign-up disabled',
      settings.data?.disable_signup !== false,
      settings.data?.disable_signup === false ? 'ENABLED — anyone can create an account' : 'disabled',
      'Supabase → Authentication → Providers → Email → turn off "Allow new users to sign up".',
    );
  if (users.ok)
    record(
      'At least one account',
      Number(users.data?.total ?? (users.data?.users || []).length) > 0,
      `${Number(users.data?.total ?? (users.data?.users || []).length)} account(s)`,
      'Create the first operator in Supabase → Authentication → Users → Add user, and confirm the email.',
    );

  return report(results);
}

function report(results) {
  const width = Math.max(...results.map((r) => r.name.length));
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name.padEnd(width)}  ${result.detail}`);
    if (!result.ok && result.fix) console.log(`${' '.repeat(6)}→ ${result.fix}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    failed
      ? `\n${failed} check(s) failed. Fix the first FAIL above; later failures are usually consequences of it.`
      : '\nAll checks passed. Sign-in should work.',
  );
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error('Check could not run:', error.message);
  process.exitCode = 1;
});
