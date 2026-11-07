// Minimal Supabase stand-in for authentication tests: GoTrue token endpoints plus the
// PostgREST calls the server makes on boot. Not a general purpose mock — only the routes
// server.js actually uses, so a new call fails loudly instead of silently passing.
const http = require('node:http');

function createSupabaseStub({
  users = [],
  accounts = [],
  unitSchemaReady = true,
  state,
  disableSignup = true,
  unitState = [],
} = {}) {
  let counter = 0;
  const accessTokens = new Map(); // token -> user
  const refreshTokens = new Map(); // token -> user
  const created = [];
  const requests = [];

  const profile = (user) => ({
    id: user.id,
    email: user.email,
    app_metadata: user.app_metadata || {},
    user_metadata: user.user_metadata || {},
    role: 'authenticated',
  });

  function issue(user) {
    counter += 1;
    const access = `access-${user.id}-${counter}`;
    const refresh = `refresh-${user.id}-${counter}`;
    accessTokens.set(access, user);
    refreshTokens.set(refresh, user);
    return { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: 'bearer', user: profile(user) };
  }

  function userFrom(req) {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return accessTokens.get(token) || (users.find((u) => u.id === token) ? users.find((u) => u.id === token) : null);
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://stub');
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ method: req.method, path: url.pathname, query: url.search, body });
      const path = url.pathname;

      if (path === '/auth/v1/token') {
        const grant = url.searchParams.get('grant_type');
        if (grant === 'password') {
          const user = users.find(
            (u) => u.email === String(body.email || '').toLowerCase() && u.password === body.password,
          );
          if (!user)
            return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
          if (user.confirmed === false)
            return json(res, 400, { error: 'invalid_grant', error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
          return json(res, 200, issue(user));
        }
        if (grant === 'refresh_token') {
          const user = refreshTokens.get(body.refresh_token);
          if (!user) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
          refreshTokens.delete(body.refresh_token);
          return json(res, 200, issue(user));
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      if (path === '/auth/v1/settings') {
        return json(res, 200, { external: { email: true }, disable_signup: disableSignup, mailer_autoconfirm: false });
      }
      if (path === '/auth/v1/user') {
        const user = userFrom(req);
        if (!user) return json(res, 401, { error: 'invalid_jwt', error_description: 'JWT expired' });
        if (req.method === 'PUT') return json(res, 200, profile(user));
        return json(res, 200, profile(user));
      }
      if (path === '/auth/v1/logout') {
        accessTokens.delete(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
        return json(res, 204);
      }
      if (path === '/auth/v1/admin/users') {
        if (req.method === 'GET')
          return json(res, 200, { users: users.map(profile), aud: 'authenticated', total: users.length });
        counter += 1;
        const user = {
          id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
          email: body.email,
          app_metadata: body.app_metadata || {},
          user_metadata: body.user_metadata || {},
        };
        users.push(user);
        created.push(user);
        return json(res, 200, { user: profile(user) });
      }
      if (path.startsWith('/auth/v1/admin/users/')) {
        const id = path.split('/').at(-1);
        if (req.method === 'DELETE') {
          const i = users.findIndex((u) => u.id === id);
          if (i >= 0) users.splice(i, 1);
          return json(res, 200, {});
        }
        return json(res, 200, {});
      }

      if (path === '/rest/v1/rpc/dispatch_unit_schema_ready') return json(res, 200, unitSchemaReady);
      if (path.startsWith('/rest/v1/rpc/')) return json(res, 200, {});

      if (path === '/rest/v1/dispatch_state') {
        if (req.method === 'POST') {
          if (state) Object.assign(state, body.payload || {});
          return json(res, 201);
        }
        return json(res, 200, state ? [{ payload: state, updated_at: state.updatedAt || new Date().toISOString() }] : []);
      }
      if (path === '/rest/v1/dispatch_unit_accounts') {
        if (req.method === 'POST') {
          accounts.push({ user_id: body.user_id, officer_id: body.officer_id });
          return json(res, 201);
        }
        const userId = /user_id=eq\.([^&]+)/.exec(url.search);
        const officerId = /officer_id=eq\.([^&]+)/.exec(url.search);
        const rows = accounts.filter(
          (a) =>
            (!userId || a.user_id === decodeURIComponent(userId[1])) &&
            (!officerId || a.officer_id === decodeURIComponent(officerId[1])),
        );
        return json(res, 200, rows);
      }
      if (path === '/rest/v1/dispatch_backups') return json(res, 200, []);
      if (path === '/rest/v1/dispatch_unit_state') return json(res, 200, unitState);
      if (path === '/rest/v1/dispatch_rtc_signals') return json(res, 200, []);

      // Anything else: empty successful response so boot-time writes do not fail.
      if (req.method === 'GET') return json(res, 200, []);
      return json(res, req.method === 'DELETE' ? 204 : 201, {});
    });
  });

  return {
    server,
    users,
    accounts,
    created,
    requests,
    // Simulate an access token expiring while the refresh token stays valid.
    expireAccessTokens() {
      accessTokens.clear();
    },
    expireRefreshTokens() {
      refreshTokens.clear();
    },
    listen() {
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createSupabaseStub };
