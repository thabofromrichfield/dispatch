const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pointInPolygon, pointNearPolygon } = require('./src/geo');
const { toCsv, csvCell } = require('./src/csv');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB = path.join(DATA_DIR, 'dispatch.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const IS_VERCEL = Boolean(process.env.VERCEL);
if (!IS_VERCEL) fs.mkdirSync(BACKUP_DIR, { recursive: true });
const { record: recordDiagnostic, exportEvents: exportDiagnosticEvents } = require('./server-diagnostics');
process.on('uncaughtExceptionMonitor', (error) =>
  recordDiagnostic(
    'process.uncaughtException',
    { name: error?.name || 'Error', message: error?.message || String(error), stack: error?.stack || '' },
    'error',
  ),
);
process.on('warning', (warning) =>
  recordDiagnostic(
    'process.warning',
    { name: warning?.name || 'Warning', message: warning?.message || String(warning), stack: warning?.stack || '' },
    'warning',
  ),
);
process.on('unhandledRejection', (reason) => {
  recordDiagnostic(
    'process.unhandledRejection',
    { name: reason?.name || 'Rejection', message: reason?.message || String(reason), stack: reason?.stack || '' },
    'error',
  );
  setImmediate(() => {
    throw reason instanceof Error ? reason : new Error(String(reason));
  });
});
// Load only non-tracked local configuration. Never embed Supabase secrets in browser assets.
try {
  for (const raw of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(String.fromCharCode(10))) {
    const line = raw.trim(),
      i = line.indexOf('=');
    if (i > 0) {
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      if (!Object.hasOwn(process.env, key)) process.env[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }
} catch {}
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TOMTOM_API_KEY = String(process.env.TOMTOM_API_KEY || '').trim();
const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY);
const supabaseBaseValid = (() => {
  try {
    const u = new URL(SUPABASE_URL);
    return (
      ['https:', 'http:'].includes(u.protocol) &&
      !(u.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(u.hostname))
    );
  } catch {
    return false;
  }
})();
const now = () => new Date().toISOString();
const id = (prefix = 'id') => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

function seed() {
  const date = now();
  return {
    version: 2,
    locationEventIds: [],
    lastAutoBackup: null,
    settings: {
      company: '',
      timezone: 'Africa/Johannesburg',
      absenceMinutes: 60,
      offlineMinutes: 5,
      geofenceReadings: 2,
      gpsAccuracy: 50,
      locationInterval: 15,
      retentionDays: 90,
      sosEscalationMinutes: 2,
      speedLimit: 90,
      trafficProvider: 'tomtom',
      trafficKey: '',
      trafficEnabled: false,
      mapProvider: 'Esri World Street Map',
      smtpHost: '',
      emailFrom: '',
      backupFrequency: 'hourly',
      backupRetention: 14,
      supervisor: '',
      soundEnabled: true,
    },
    sites: [],
    officers: [],
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
    updatedAt: date,
  };
}

let cloudReady = false,
  unitSchemaReady = false,
  cloudInitError = null,
  cloudWriteQueue = Promise.resolve(),
  cloudRecoveryTimer = null,
  cloudRecoveryDelay = 5000,
  volatileCallIds = new Set(),
  vercelRequestQueue = Promise.resolve(),
  cloudInitLastAttemptAt = 0,
  unitSchemaLastCheckAt = 0;
const pendingLocationRows = [];
function cloudHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}
async function cloudRequest(path, options = {}) {
  if (!supabaseConfigured || !supabaseBaseValid)
    throw Object.assign(new Error('Supabase server configuration is missing or invalid'), { status: 503 });
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(12000),
    headers: cloudHeaders(options.headers || {}),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok)
    throw Object.assign(new Error(`Supabase request failed (${response.status})`), {
      status: response.status,
      details: body,
    });
  return body;
}
// The whole state is one JSONB payload: it is read at the start of every Vercel request and
// written back on every save. Unbounded history here made each round trip ~19 MB, which is why
// requests arrived minutes late. Keep only what the console can use.
const STATE_LIMITS = { traffic: 20000, alertHistory: 200, recordingBytes: 8 * 1024 * 1024 };
function trimState(snapshot) {
  if (Array.isArray(snapshot.traffic) && snapshot.traffic.length > STATE_LIMITS.traffic)
    snapshot.traffic = snapshot.traffic.slice(-STATE_LIMITS.traffic);
  for (const alert of snapshot.alerts || [])
    if (Array.isArray(alert.locationHistory) && alert.locationHistory.length > STATE_LIMITS.alertHistory)
      alert.locationHistory = alert.locationHistory.slice(-STATE_LIMITS.alertHistory);
  return snapshot;
}
function compactCloudSnapshot(snapshot) {
  const compact = trimState(structuredClone(snapshot));
  compact.locationEventIds = (compact.locationEventIds || []).slice(-2000);
  compact.officers = (compact.officers || []).map((officer) => {
    const history = Array.isArray(officer.history) ? officer.history : [],
      tail = [...(Array.isArray(officer.historyTail) ? officer.historyTail : []), ...history].slice(-10),
      { history: _removed, historyTail: _oldTail, ...rest } = officer;
    return {
      ...rest,
      historyTail: tail,
      historyCount: Number(officer.historyCount ?? history.length),
      latestHistoryAt: officer.latestHistoryAt || history.at(-1)?.receivedAt || null,
    };
  });
  return compact;
}
async function cloudUserRequest(path, { accessToken, method = 'GET', body, headers = {} } = {}) {
  if (!supabaseConfigured || !supabaseBaseValid || !accessToken)
    throw Object.assign(new Error('Unit sign-in is required'), { status: 401 });
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  let result = null;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = text;
  }
  if (!response.ok)
    throw Object.assign(new Error(`Unit-scoped query failed (${response.status})`), {
      status: response.status,
      details: result,
    });
  return result;
}

// Traffic history is ~95% of the state payload and the console only reads it on the traffic,
// review and report pages. Keeping it in row 1 meant every poll, message and SOS re-read and
// rewrote megabytes. It now lives in its own dispatch_state row and is loaded on demand.
const TRAFFIC_ROW_ID = 2;
let trafficRowAvailable = true;
let trafficRowsLoaded = false;
let trafficDirty = false;

async function ensureTrafficRows({ fresh = false } = {}) {
  if (trafficRowsLoaded && !fresh) return Array.isArray(state.traffic) ? state.traffic : [];
  trafficRowsLoaded = true;
  state.traffic = Array.isArray(state.traffic) ? state.traffic : [];
  if (!trafficRowAvailable) return state.traffic;
  try {
    const rows = await cloudRequest(`/rest/v1/dispatch_state?select=payload&id=eq.${TRAFFIC_ROW_ID}`);
    const stored = rows?.[0]?.payload?.traffic;
    if (Array.isArray(stored) && stored.length) state.traffic = stored;
  } catch (error) {
    if ([400, 404, 406].includes(error.status)) trafficRowAvailable = false;
  }
  return state.traffic;
}

async function persistTrafficRows(traffic) {
  const rows = (Array.isArray(traffic) ? traffic : []).slice(-STATE_LIMITS.traffic);
  if (!rows.length) return;
  try {
    trafficDirty = false;
    await cloudRequest('/rest/v1/dispatch_state?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ id: TRAFFIC_ROW_ID, payload: { traffic: rows }, updated_at: now() }),
    });
  } catch (error) {
    // Deployments whose schema still constrains dispatch_state to a single row keep the old
    // behaviour: traffic stays inside the main payload instead of failing the write.
    if ([400, 409, 422].includes(error.status)) trafficRowAvailable = false;
    else throw error;
  }
}

async function persistCloudSnapshot(snapshot, locationRows = []) {
  let lastError;
  const trafficChanged = trafficDirty && trafficRowAvailable;
  if (trafficChanged) await persistTrafficRows(snapshot.traffic);
  const hot = { ...snapshot };
  if (trafficRowAvailable) delete hot.traffic;
  const payload = unitSchemaReady ? compactCloudSnapshot(hot) : structuredClone(hot);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (unitSchemaReady) {
        const locations = locationRows.map(({ officerId, point }) => ({
          event_id: String(point.eventId),
          officer_id: officerId,
          received_at: point.receivedAt,
          payload: point,
        }));
        await cloudRequest('/rest/v1/rpc/dispatch_save_snapshot', {
          method: 'POST',
          body: JSON.stringify({
            p_payload: payload,
            p_updated_at: payload.updatedAt || now(),
            p_locations: locations,
          }),
        });
      } else
        await cloudRequest('/rest/v1/dispatch_state?on_conflict=id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ id: 1, payload, updated_at: payload.updatedAt || now() }),
        });
      return;
    } catch (error) {
      lastError = error;
      const retryable = !error.status || error.status >= 500 || [408, 429].includes(error.status);
      if (!retryable || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function checkUnitSchema() {
  unitSchemaLastCheckAt = Date.now();
  try {
    unitSchemaReady =
      (await cloudRequest('/rest/v1/rpc/dispatch_unit_schema_ready', { method: 'POST', body: '{}' })) === true;
  } catch {
    unitSchemaReady = false;
  }
  return unitSchemaReady;
}

function historicalRowsForState(snapshot) {
  return (snapshot.officers || []).flatMap((officer) =>
    (officer.history || []).map((point) => {
      const receivedAt = point.receivedAt || point.phoneTime || snapshot.updatedAt || now();
      return {
        officerId: officer.id,
        point: {
          ...point,
          receivedAt,
          eventId:
            point.eventId ||
            `legacy-${crypto.createHash('sha256').update(`${officer.id}:${receivedAt}:${point.lat}:${point.lng}`).digest('hex').slice(0, 32)}`,
          source: point.source || 'live',
        },
      };
    }),
  );
}
async function initializeCloud() {
  cloudInitLastAttemptAt = Date.now();
  if (!supabaseConfigured || !supabaseBaseValid) {
    cloudInitError = 'Supabase server configuration is missing or invalid';
    return false;
  }
  try {
    const rows = await cloudRequest('/rest/v1/dispatch_state?select=payload,updated_at&id=eq.1');
    const pendingCalls = Array.isArray(state?.calls) ? state.calls.filter((call) => volatileCallIds.has(call.id)) : [];
    const firstInitialization = !(Array.isArray(rows) && rows.length);
    if (!firstInitialization) {
      const remote = rows[0].payload;
      state = pendingCalls.length
        ? {
            ...remote,
            calls: [...pendingCalls, ...(remote.calls || []).filter((call) => !volatileCallIds.has(call.id))],
          }
        : remote;
    }
    if (rows?.[0]?.updated_at) state.updatedAt = rows[0].updated_at;
    state.locationEventIds ||= [];
    state.locationEventIds = state.locationEventIds.slice(-2000);
    state.relays ||= [];
    state.settings ||= {};
    state.traffic = Array.isArray(state.traffic) ? state.traffic : [];
    trafficRowsLoaded = state.traffic.length > 0;
    if (trafficRowsLoaded) trafficDirty = true;
    trimState(state);
    locationEventSet.clear();
    for (const key of state.locationEventIds) locationEventSet.add(key);
    await checkUnitSchema();
    cloudReady = true;
    cloudInitError = null;
    if (pendingCalls.length) {
      await persistCloudSnapshot(state, firstInitialization ? historicalRowsForState(state) : []);
      for (const call of pendingCalls) volatileCallIds.delete(call.id);
    } else if (firstInitialization) await persistCloudSnapshot(state, historicalRowsForState(state));
    console.log('Supabase persistence initialized');
    return true;
  } catch (error) {
    cloudReady = false;
    cloudInitError = `Supabase initialization failed (${error.status || 'network'})`;
    console.error(cloudInitError);
    return false;
  }
}
async function refreshCloudState() {
  const rows = await cloudRequest('/rest/v1/dispatch_state?select=payload,updated_at&id=eq.1');
  if (!Array.isArray(rows) || !rows[0]?.payload)
    throw Object.assign(new Error('Dispatch state is not initialized in Supabase'), { status: 503 });
  state = rows[0].payload;
  if (rows[0].updated_at) state.updatedAt = rows[0].updated_at;
  state.locationEventIds ||= [];
  state.locationEventIds = state.locationEventIds.slice(-2000);
  state.relays ||= [];
  state.settings ||= {};
  state.traffic = Array.isArray(state.traffic) ? state.traffic : [];
  trafficRowsLoaded = state.traffic.length > 0;
  if (trafficRowsLoaded) trafficDirty = true;
  trimState(state);
  locationEventSet.clear();
  for (const key of state.locationEventIds) locationEventSet.add(key);
  cloudReady = true;
  cloudInitError = null;
  return structuredClone(state);
}
async function cloudStateUnchanged(since) {
  if (!since) return false;
  const rows = await cloudRequest('/rest/v1/dispatch_state?select=updated_at&id=eq.1');
  if (!Array.isArray(rows) || !rows[0]?.updated_at) return false;
  if (String(rows[0].updated_at) !== String(since)) return false;
  return true;
}
async function acquireCloudStateLock(ownerToken) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const locked = await cloudRequest('/rest/v1/rpc/dispatch_try_acquire_state_lock', {
      method: 'POST',
      body: JSON.stringify({ p_owner_token: ownerToken, p_lease_seconds: 60 }),
    });
    if (locked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw Object.assign(new Error('Dispatch is busy processing another update. Please retry.'), { status: 503 });
}
async function releaseCloudStateLock(ownerToken) {
  try {
    await cloudRequest('/rest/v1/rpc/dispatch_release_state_lock', {
      method: 'POST',
      body: JSON.stringify({ p_owner_token: ownerToken }),
    });
  } catch (error) {
    recordDiagnostic('state.lock.release-failed', { status: error.status || null, message: error.message }, 'error');
  }
}
function rtcPeerUrl(query = '') {
  return `/rest/v1/dispatch_rtc_peers?${query}`;
}
async function upsertRtcPeer(peer) {
  await cloudRequest(rtcPeerUrl('on_conflict=peer_id'), {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      peer_id: peer.peerId,
      role: peer.role,
      officer_id: peer.officerId,
      label: peer.label,
      last_seen: now(),
    }),
  });
}
async function liveRtcPeers() {
  const cutoff = new Date(Date.now() - RTC_PEER_TTL_MS).toISOString();
  const rows = await cloudRequest(
    rtcPeerUrl(`select=peer_id,role,officer_id,label,last_seen&last_seen=gte.${encodeURIComponent(cutoff)}`),
  );
  return (rows || []).map((peer) => ({
    peerId: peer.peer_id,
    role: peer.role,
    officerId: peer.officer_id,
    label: peer.label,
    lastSeen: Date.parse(peer.last_seen),
  }));
}
async function getLiveRtcPeer(peerId) {
  return (await liveRtcPeers()).find((peer) => peer.peerId === peerId) || null;
}
async function enqueueRtcSignal(signal) {
  await cloudRequest('/rest/v1/dispatch_rtc_signals', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      id: signal.id,
      recipient_peer_id: signal.toPeer,
      from_peer_id: signal.fromPeer,
      call_id: signal.callId,
      signal_type: signal.type,
      payload: signal.payload,
      created_at: signal.at,
    }),
  });
}
async function dequeueRtcSignals(peerId) {
  const rows = await cloudRequest(
    `/rest/v1/dispatch_rtc_signals?select=id,created_at,from_peer_id,call_id,signal_type,payload&recipient_peer_id=eq.${encodeURIComponent(peerId)}&order=created_at.asc&limit=100`,
  );
  if (!rows?.length) return [];
  const ids = rows.map((row) => row.id);
  await cloudRequest(`/rest/v1/dispatch_rtc_signals?id=in.${encodeURIComponent(`(${ids.join(',')})`)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
  return rows.map((row) => ({
    id: row.id,
    at: row.created_at,
    fromPeer: row.from_peer_id,
    callId: row.call_id,
    type: row.signal_type,
    payload: row.payload || {},
  }));
}
function scheduleCloudRecovery() {
  if (cloudReady || cloudRecoveryTimer || !supabaseConfigured || !supabaseBaseValid) return;
  cloudRecoveryTimer = setTimeout(async () => {
    cloudRecoveryTimer = null;
    if (cloudReady) return;
    const recovered = await initializeCloud();
    if (recovered) {
      cloudRecoveryDelay = 5000;
      console.log('Supabase persistence recovered');
      return;
    }
    cloudRecoveryDelay = Math.min(60000, cloudRecoveryDelay * 2);
    scheduleCloudRecovery();
  }, cloudRecoveryDelay);
  cloudRecoveryTimer.unref?.();
}
function save() {
  state.updatedAt = now();
  if (!supabaseConfigured || !cloudReady) return Promise.resolve();
  const snapshot = structuredClone(state),
    locationBatch = pendingLocationRows.splice(0);
  const write = cloudWriteQueue.then(async () => {
    if (!cloudReady) throw Object.assign(new Error('Supabase storage is unavailable'), { status: 503 });
    await persistCloudSnapshot(snapshot, locationBatch);
  });
  cloudWriteQueue = write.catch((error) => {
    if (locationBatch.length) pendingLocationRows.unshift(...locationBatch);
    if (cloudReady) {
      cloudReady = false;
      cloudInitError = `Supabase state persistence failed (${error.status || 'network'})`;
      console.error(cloudInitError);
    }
    scheduleCloudRecovery();
  });
  return write;
}
let state;
try {
  state = JSON.parse(fs.readFileSync(DB, 'utf8'));
} catch {
  state = seed();
  save();
}
state.locationEventIds ||= [];
state.settings ||= {};
const backupFrequencyMigrated = state.settings.backupFrequency !== 'hourly';
state.settings.backupFrequency = 'hourly';
if (backupFrequencyMigrated)
  save().catch((error) => console.error('Could not persist hourly backup schedule:', error.message));
state.relays ||= [];
let relayMigration = false;
for (const relay of state.relays)
  if (relay.status === 'online' && !relay.lastCheck) {
    relay.status = 'configured';
    relayMigration = true;
  }
if (relayMigration) save();
state.settings.mapProviderUserSet ||= false;
let mapSettingsMigrated = false;
if (Object.hasOwn(state.settings, 'mapTileUrl')) {
  delete state.settings.mapTileUrl;
  mapSettingsMigrated = true;
}
if (state.settings.mapProvider === 'Local tiles') {
  state.settings.mapProvider = 'Esri World Street Map';
  state.settings.mapProviderUserSet = true;
  mapSettingsMigrated = true;
}
if (!['Esri World Street Map', 'OpenStreetMap'].includes(state.settings.mapProvider)) {
  state.settings.mapProvider = 'Esri World Street Map';
  mapSettingsMigrated = true;
}
if (state.settings.mapProvider === 'OpenStreetMap' && !state.settings.mapProviderUserSet) {
  state.settings.mapProvider = 'Esri World Street Map';
  mapSettingsMigrated = true;
}
if (mapSettingsMigrated) save();
const locationEventSet = new Set(state.locationEventIds);
const RTC_PEER_TTL_MS = 15000,
  presencePersistedAt = new Map(),
  rtcPeers = new Map(),
  rtcInbox = new Map(),
  trafficTileCache = new Map(),
  trafficTileInFlight = new Map();

function audit(action, target = '', actor = 'Local console') {
  state.audit.unshift({ id: id('audit'), at: now(), actor, action, target });
  state.audit = state.audit.slice(0, 3000);
}
function safeOfficer(o) {
  const { history, historyTail, ...rest } = o;
  return {
    ...rest,
    historyCount: Number(o.historyCount ?? history?.length ?? 0),
    latestHistoryAt: o.latestHistoryAt || history?.at(-1)?.receivedAt || null,
  };
}
function trafficApiKey() {
  return TOMTOM_API_KEY || String(state.settings.trafficKey || '').trim();
}
function clientStateForAuthenticatedUser(source = state) {
  const { locationEventIds, ...rest } = source;
  const body = {
    ...rest,
    officers: source.officers.map(safeOfficer),
    recordings: source.recordings.map(({ data, ...recording }) => ({ ...recording, hasData: Boolean(data) })),
    traffic: (source.traffic || []).slice(-500),
  };
  body.settings = {
    ...source.settings,
    unitSchemaReady,
    trafficKey: '',
    trafficKeyConfigured: Boolean(TOMTOM_API_KEY || String(source.settings.trafficKey || '').trim()),
    tileToken: tileToken(),
  };
  return body;
}
function fieldStateForAuthenticatedUser(officerId, source = state) {
  const officer = source.officers.find((x) => x.id === officerId);
  if (!officer) return null;
  const selected = {
    id: officer.id,
    name: officer.name,
    callSign: officer.callSign,
    group: officer.group,
    shiftId: officer.shiftId,
    siteId: officer.siteId,
    status: officer.status,
    online: Boolean(officer.online),
    lastSeen: officer.lastSeen || null,
    battery: officer.battery ?? null,
    signal: officer.signal ?? null,
    lat: officer.lat ?? null,
    lng: officer.lng ?? null,
    accuracy: officer.accuracy ?? null,
    stunned: Boolean(officer.stunned),
    tracking: Boolean(officer.tracking),
    config: { locationInterval: officer.config?.locationInterval || source.settings.locationInterval || 15 },
  };
  const messages = source.messages
    .filter((m) => m.to === officer.id || (m.to === 'all' && (!m.group || m.group === officer.group)))
    .slice(0, 40)
    .map((m) => ({
      id: m.id,
      from: m.from,
      to: m.to,
      group: m.group,
      body: m.body,
      createdAt: m.createdAt,
      deliveredAt: m.deliveredAt,
      readAt: m.readAt,
      scheduledAt: m.scheduledAt || null,
    }));
  const alerts = source.alerts
    .filter((a) => a.type === 'sos' && a.officerId === officer.id && a.status !== 'handled')
    .slice(0, 3)
    .map((a) => ({ id: a.id, status: a.status, raisedAt: a.raisedAt, offline: Boolean(a.offline) }));
  return {
    officer: selected,
    officers: source.officers.map((x) => ({
      id: x.id,
      name: x.name,
      callSign: x.callSign,
      shiftId: x.shiftId,
      status: x.status,
    })),
    sites: source.sites.filter((x) => x.areaType === 'work').map((x) => ({ id: x.id, name: x.name })),
    messages,
    alerts,
    settings: { locationInterval: source.settings.locationInterval || 15 },
    updatedAt: source.updatedAt,
  };
}

function touchOfficerPresence(officerId) {
  const officer = state.officers.find((x) => x.id === officerId);
  if (!officer) return false;
  const atMs = Date.now(),
    lastSeenMs = Date.parse(officer.lastSeen || ''),
    wasOnline = Boolean(officer.online),
    stale = !Number.isFinite(lastSeenMs) || atMs - lastSeenMs >= RTC_PEER_TTL_MS;
  officer.online = true;
  if (!Number.isFinite(lastSeenMs) || atMs - lastSeenMs > 1000) officer.lastSeen = now();
  let deliveredQueuedMessage = false;
  for (const message of state.messages) {
    if (
      !message.deliveredAt &&
      !message.scheduledAt &&
      (message.to === officer.id || (message.to === 'all' && message.group === officer.group))
    ) {
      message.deliveredAt = now();
      deliveredQueuedMessage = true;
    }
  }
  const lastPersisted = presencePersistedAt.get(officer.id) || 0;
  if (!wasOnline || stale || deliveredQueuedMessage || atMs - lastPersisted >= RTC_PEER_TTL_MS) {
    presencePersistedAt.set(officer.id, atMs);
    save().catch((error) =>
      recordDiagnostic(
        'presence.persist.failed',
        { officerId: officer.id, status: error.status || null, message: error.message },
        'error',
      ),
    );
  }
  return true;
}

function processLocation(officer, point) {
  if (!officer.shiftId || !officer.tracking) return { ignored: true, reason: 'Location sharing is off duty' };
  const receivedAt = now();
  const key = point.eventId || `${officer.id}:${point.timestamp}:${point.lat}:${point.lng}`;
  if (locationEventSet.has(key)) return { duplicate: true };
  const accuracy =
      point.accuracy !== undefined && point.accuracy !== null && Number.isFinite(Number(point.accuracy))
        ? Number(point.accuracy)
        : null,
    speed =
      point.speed !== undefined && point.speed !== null && Number.isFinite(Number(point.speed))
        ? Number(point.speed)
        : null;
  const p = {
    eventId: key,
    lat: Number(point.lat),
    lng: Number(point.lng),
    accuracy,
    speed,
    phoneTime: point.timestamp || receivedAt,
    receivedAt,
    source: 'live',
  };
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180)
    throw new Error('Invalid coordinates');
  locationEventSet.add(key);
  state.locationEventIds.push(key);
  if (state.locationEventIds.length > 2000) {
    const expired = state.locationEventIds.splice(0, state.locationEventIds.length - 2000);
    expired.forEach((x) => locationEventSet.delete(x));
  }
  officer.history ||= Array.isArray(officer.historyTail) ? [...officer.historyTail] : [];
  officer.historyCount = Number(officer.historyCount || 0) + 1;
  officer.latestHistoryAt = p.receivedAt;
  pendingLocationRows.push({ officerId: officer.id, point: p });
  officer.lat = p.lat;
  officer.lng = p.lng;
  officer.accuracy = p.accuracy;
  officer.speed = p.speed;
  const battery = Number(point.battery);
  if (Number.isFinite(battery) && battery >= 0 && battery <= 100) officer.battery = battery;
  officer.lastSeen = receivedAt;
  officer.online = true;
  presencePersistedAt.set(officer.id, Date.now());
  if (officer.tracking && officer.shiftId) officer.history.push(p);
  if (officer.history.length > 50000) officer.history.splice(0, 1000);
  officer.historyTail = officer.history.slice(-10);
  updateActiveSosLocation(officer, p);
  if (officer.speed > Number(state.settings.speedLimit || 90))
    raiseAlert(
      'speed',
      'Speed limit exceeded',
      `${officer.callSign} · ${Math.round(officer.speed)} km/h`,
      officer,
      null,
      p,
    );
  const site = state.sites.find((s) => s.id === officer.siteId);
  if (site && officer.shiftId && p.accuracy !== null && p.accuracy <= Number(state.settings.gpsAccuracy || 50)) {
    const inside =
      pointInPolygon([p.lat, p.lng], site.coordinates) ||
      pointNearPolygon([p.lat, p.lng], site.coordinates, Number(site.tolerance || 0));
    const prev = officer.history.slice(-Number(state.settings.geofenceReadings || 2));
    const consecutive =
      prev.length >= Number(state.settings.geofenceReadings || 2) &&
      prev.every(
        (q) =>
          pointInPolygon([q.lat, q.lng], site.coordinates) === inside &&
          q.accuracy !== null &&
          q.accuracy <= Number(state.settings.gpsAccuracy || 50),
      );
    if (consecutive && inside && !['on-site', 'on-break'].includes(officer.status)) {
      officer.status = 'on-site';
      officer.onSiteSince = receivedAt;
      officer.leftSiteAt = null;
      audit('Officer arrived on site', `${officer.callSign} · ${site.name}`);
    }
    if (consecutive && !inside && officer.status === 'on-site') {
      officer.status = 'left-site';
      officer.leftSiteAt = receivedAt;
      raiseAlert('left-site', 'Officer left assigned site', `${officer.callSign} · ${site.name}`, officer, site, p);
    }
    if (
      consecutive &&
      !inside &&
      officer.status === 'en-route' &&
      Date.now() - Date.parse(officer.clockedInAt || receivedAt) > Number(state.settings.absenceMinutes || 60) * 60000
    )
      raiseAbsence(officer, site);
  }
  for (const region of [...state.regions, ...state.sites.filter((x) => x.areaType === 'restricted')])
    if (
      region.areaType === 'restricted' &&
      (!region.assigned?.length || region.assigned.includes(officer.id)) &&
      pointInPolygon([p.lat, p.lng], region.coordinates)
    )
      raiseAlert('geofence', 'Restricted zone entered', `${officer.callSign} · ${region.name}`, officer, region, p);
  return { point: p };
}
function raiseAlert(type, title, detail, officer, site, point = {}) {
  const duplicate = state.alerts.find(
    (a) =>
      a.type === type &&
      a.officerId === officer?.id &&
      (type === 'sos' ? a.status === 'raised' : a.status !== 'handled') &&
      Date.now() - Date.parse(a.raisedAt) < 120000,
  );
  if (duplicate) return duplicate;
  const at = now(),
    alert = {
      id: id('alert'),
      type,
      title,
      detail,
      officerId: officer?.id || null,
      siteId: site?.id || null,
      lat: point.lat ?? officer?.lat ?? null,
      lng: point.lng ?? officer?.lng ?? null,
      accuracy: point.accuracy ?? officer?.accuracy ?? null,
      raisedAt: at,
      status: 'raised',
      events: [{ status: 'raised', at, by: 'System' }],
    };
  state.alerts.unshift(alert);
  return alert;
}
function sosLocationRecord(o, p, source = 'live-gps') {
  return {
    lat: p?.lat ?? null,
    lng: p?.lng ?? null,
    accuracy: p?.accuracy ?? o.accuracy ?? null,
    speed: p?.speed ?? o.speed ?? null,
    locationAt: p?.phoneTime || o.lastSeen || null,
    receivedAt: p?.receivedAt || now(),
    source,
    battery: o.battery ?? null,
    signal: o.signal ?? null,
    online: Boolean(o.online),
    offline: !o.online,
    status: o.status,
    siteId: o.siteId || null,
    siteName: state.sites.find((s) => s.id === o.siteId)?.name || null,
  };
}
function updateActiveSosLocation(o, p) {
  for (const a of state.alerts.filter((x) => x.type === 'sos' && x.officerId === o.id && x.status !== 'handled')) {
    const record = sosLocationRecord(o, p, 'live-gps');
    a.lat = record.lat;
    a.lng = record.lng;
    a.accuracy = record.accuracy;
    a.locationAt = record.locationAt;
    a.locationReceivedAt = record.receivedAt;
    a.offline = !o.online;
    a.sosSnapshot = { ...(a.sosSnapshot || {}), ...record };
    a.locationHistory ||= [];
    a.locationHistory.push(record);
    if (a.locationHistory.length > 10000) a.locationHistory.shift();
  }
}
function raiseAbsence(o, s) {
  if (state.alerts.some((a) => a.type === 'absence' && a.officerId === o.id && a.shiftId === o.shiftId)) return;
  const a = raiseAlert('absence', 'Officer has not reached site', `${o.callSign} · ${s.name}`, o, s);
  a.shiftId = o.shiftId;
}

async function fetchTomTomFlow(site, key) {
  const lat = site.coordinates.reduce((n, p) => n + Number(p[0] || 0), 0) / site.coordinates.length,
    lng = site.coordinates.reduce((n, p) => n + Number(p[1] || 0), 0) / site.coordinates.length;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    throw Object.assign(new Error('Work site has invalid coordinates'), { status: 400 });
  const endpoint = new URL('https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json');
  endpoint.searchParams.set('point', `${lat},${lng}`);
  endpoint.searchParams.set('key', key);
  let response;
  try {
    response = await fetch(endpoint, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  } catch {
    throw Object.assign(new Error('Could not reach TomTom Traffic API from the Dispatch server'), { status: 502 });
  }
  if (!response.ok)
    throw Object.assign(
      new Error(
        `TomTom returned HTTP ${response.status}; check the Traffic Flow API permission, quota, and key restrictions`,
      ),
      { status: 502 },
    );
  let data;
  try {
    data = await response.json();
  } catch {
    throw Object.assign(new Error('TomTom returned an unreadable traffic response'), { status: 502 });
  }
  const flow = data?.flowSegmentData,
    currentSpeed = Number(flow?.currentSpeed),
    freeFlowSpeed = Number(flow?.freeFlowSpeed);
  if (!Number.isFinite(currentSpeed) || !Number.isFinite(freeFlowSpeed) || freeFlowSpeed <= 0)
    throw Object.assign(new Error('TomTom response has no valid flow segment for this site'), { status: 502 });
  const ratio = Math.max(0, Math.min(1, currentSpeed / freeFlowSpeed));
  return {
    id: id('traffic'),
    siteId: site.id,
    at: now(),
    currentSpeed,
    freeFlowSpeed,
    confidence: Number(flow.confidence || 0),
    roadClosure: Boolean(flow.roadClosure),
    ratio,
    level: flow.roadClosure
      ? 'stopped'
      : ratio < 0.25
        ? 'heavy'
        : ratio < 0.55
          ? 'slow'
          : ratio < 0.8
            ? 'moderate'
            : 'free',
    provider: 'TomTom',
  };
}
function latestSiteTraffic(siteId) {
  for (let i = (state.traffic || []).length - 1; i >= 0; i--)
    if (state.traffic[i].siteId === siteId) return state.traffic[i];
  return null;
}
async function sampleTomTomTraffic(siteId, { force = false } = {}) {
  const site = state.sites.find((x) => x.id === siteId && x.areaType === 'work');
  if (!site) throw Object.assign(new Error('Unknown work site'), { status: 400 });
  const key = trafficApiKey();
  if (!key)
    throw Object.assign(new Error('Configure TOMTOM_API_KEY in the server .env or set the key in Settings'), {
      status: 409,
    });
  await ensureTrafficRows();
  const previous = latestSiteTraffic(site.id);
  if (!force && previous && Date.now() - Date.parse(previous.at) < 5 * 60 * 1000)
    return { reading: previous, sampled: false };
  const reading = await fetchTomTomFlow(site, key);
  state.traffic.push(reading);
  if (state.traffic.length > STATE_LIMITS.traffic)
    state.traffic.splice(0, state.traffic.length - STATE_LIMITS.traffic);
  trafficDirty = true;
  await save();
  return { reading, sampled: true };
}
async function sampleTomTomTrafficBatch({ force = false } = {}) {
  const key = trafficApiKey();
  if (!key)
    throw Object.assign(new Error('Configure TOMTOM_API_KEY in the server .env or set the key in Settings'), {
      status: 409,
    });
  await ensureTrafficRows();
  const pending = state.sites
    .filter((site) => site.areaType === 'work')
    .filter((site) => {
      const latest = latestSiteTraffic(site.id);
      return force || !latest || Date.now() - Date.parse(latest.at) >= 5 * 60 * 1000;
    });
  if (!pending.length) return { sampled: false, sampledCount: 0, failedCount: 0, errors: [] };
  const readings = [],
    errors = [];
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const site = pending[next++];
      try {
        readings.push(await fetchTomTomFlow(site, key));
      } catch (error) {
        errors.push({ siteId: site.id, siteName: site.name, error: error.message || 'Traffic query failed' });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  if (readings.length) {
    state.traffic.push(...readings);
    if (state.traffic.length > STATE_LIMITS.traffic)
      state.traffic.splice(0, state.traffic.length - STATE_LIMITS.traffic);
    trafficDirty = true;
    await save();
  }
  if (!readings.length && errors.length) throw Object.assign(new Error(errors[0].error), { status: 502 });
  return { sampled: readings.length > 0, sampledCount: readings.length, failedCount: errors.length, errors };
}
async function fetchTomTomTrafficTile(key, cacheKey, z, x, y) {
  const cached = trafficTileCache.get(cacheKey);
  if (cached && cached.until > Date.now()) return cached;
  if (trafficTileInFlight.has(cacheKey)) return trafficTileInFlight.get(cacheKey);
  const upstream = new URL(`https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.png`);
  upstream.searchParams.set('key', key);
  upstream.searchParams.set('tileSize', '256');
  upstream.searchParams.set('thickness', '8');
  const pending = (async () => {
    const response = await fetch(upstream, { headers: { Accept: 'image/png' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok)
      throw Object.assign(new Error(`TomTom traffic tiles returned HTTP ${response.status}`), { status: 502 });
    const data = Buffer.from(await response.arrayBuffer()),
      type = response.headers.get('content-type') || 'image/png';
    if (data.length > 2 * 1024 * 1024)
      throw Object.assign(new Error('TomTom traffic tile exceeded the allowed size'), { status: 502 });
    if (trafficTileCache.size >= 300) trafficTileCache.delete(trafficTileCache.keys().next().value);
    const tile = { data, type, until: Date.now() + 45000 };
    trafficTileCache.set(cacheKey, tile);
    return tile;
  })();
  trafficTileInFlight.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    if (trafficTileInFlight.get(cacheKey) === pending) trafficTileInFlight.delete(cacheKey);
  }
}
// A map view needs ~20 tiles at once. Verifying each one against Supabase cost a round trip per
// tile, so the console receives a short-lived signed token with the state and the proxy trusts it.
const TILE_TOKEN_TTL_MS = 10 * 60 * 1000;
function tileTokenSecret() {
  return crypto
    .createHash('sha256')
    .update(`dispatch-tiles:${SUPABASE_SERVICE_ROLE_KEY || 'local-dispatch'}`)
    .digest();
}
function tileToken(expiresAt = Date.now() + TILE_TOKEN_TTL_MS) {
  const expiry = String(expiresAt),
    signature = crypto.createHmac('sha256', tileTokenSecret()).update(expiry).digest('hex').slice(0, 32);
  return `${expiry}.${signature}`;
}
function tileTokenValid(token) {
  const [expiry, signature] = String(token || '').split('.');
  if (!expiry || !signature || !/^\d{10,16}$/.test(expiry) || !/^[0-9a-f]{32}$/.test(signature)) return false;
  if (Number(expiry) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', tileTokenSecret()).update(expiry).digest('hex').slice(0, 32);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

async function serveTomTomTrafficTile(res, url) {
  const match = url.pathname.match(/^\/api\/traffic\/tiles\/flow\/relative\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (!match)
    return send(res, 404, JSON.stringify({ error: 'Unknown traffic tile' }), 'application/json; charset=utf-8');
  const z = Number(match[1]),
    x = Number(match[2]),
    y = Number(match[3]);
  if (
    !Number.isInteger(z) ||
    z < 0 ||
    z > 20 ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= 2 ** z ||
    y >= 2 ** z
  )
    return send(res, 400, JSON.stringify({ error: 'Invalid tile coordinates' }), 'application/json; charset=utf-8');
  const key = trafficApiKey();
  if (!key)
    return send(
      res,
      409,
      JSON.stringify({ error: 'TomTom Traffic is not configured' }),
      'application/json; charset=utf-8',
    );
  const keyFingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12),
    cacheKey = `${keyFingerprint}:${z}/${x}/${y}`;
  try {
    const tile = await fetchTomTomTrafficTile(key, cacheKey, z, x, y);
    res.writeHead(200, {
      'Content-Type': tile.type,
      'Cache-Control': 'private, max-age=60, stale-while-revalidate=60',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(tile.data);
  } catch (error) {
    return send(
      res,
      error.status || 502,
      JSON.stringify({ error: error.message || 'Could not reach TomTom traffic tiles from the Dispatch server' }),
      'application/json; charset=utf-8',
    );
  }
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};
function zonedMidnightIso(day, timezone) {
  const utc = new Date(`${day}T00:00:00.000Z`),
    name =
      new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' })
        .formatToParts(utc)
        .find((part) => part.type === 'timeZoneName')?.value || 'GMT+00:00',
    match = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/),
    minutes = match ? (Number(match[2]) * 60 + Number(match[3] || 0)) * (match[1] === '-' ? -1 : 1) : 0;
  return new Date(utc.getTime() - minutes * 60000).toISOString();
}
async function readLocationArchive({
  from = '',
  to = '',
  officerId = 'all',
  timezone = state.settings.timezone || 'UTC',
} = {}) {
  if (!unitSchemaReady) {
    const dayKey = (value) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(value));
    return state.officers
      .filter((o) => officerId === 'all' || o.id === officerId)
      .flatMap((o) =>
        (o.history || [])
          .filter((point) => {
            const day = dayKey(point.receivedAt);
            return (!from || day >= from) && (!to || day <= to);
          })
          .map((point) => ({
            eventId: point.eventId,
            lat: point.lat,
            lng: point.lng,
            accuracy: point.accuracy,
            speed: point.speed,
            phoneTime: point.phoneTime,
            receivedAt: point.receivedAt,
            source: point.source || 'live',
            officer: { id: o.id, callSign: o.callSign, name: o.name, color: o.color },
          })),
      )
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }
  let fromIso = null,
    toIso = null;
  if (from) fromIso = zonedMidnightIso(from, timezone);
  if (to) {
    const nextDay = new Date(`${to}T00:00:00.000Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    toIso = zonedMidnightIso(nextDay.toISOString().slice(0, 10), timezone);
  }
  const rows = await cloudRequest('/rest/v1/rpc/dispatch_read_locations', {
    method: 'POST',
    body: JSON.stringify({
      p_from: fromIso,
      p_to: toIso,
      p_officer_id: officerId === 'all' ? null : officerId,
      p_limit: 20001,
    }),
  });
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const o = state.officers.find((person) => person.id === row.officer_id),
        point = row.payload || {};
      return {
        eventId: row.event_id,
        lat: point.lat,
        lng: point.lng,
        accuracy: point.accuracy,
        speed: point.speed,
        phoneTime: point.phoneTime,
        receivedAt: row.received_at,
        source: point.source || 'live',
        officer: {
          id: row.officer_id,
          callSign: o?.callSign || 'Unit',
          name: o?.name || '',
          color: o?.color || '#648b73',
        },
      };
    })
    .reverse();
}
const requestListener = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const startedAt = Date.now();
    res.once('finish', () =>
      recordDiagnostic(
        'http.request',
        { method: req.method, path: url.pathname, status: res.statusCode, durationMs: Date.now() - startedAt },
        res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warning' : 'info',
      ),
    );
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(self)');
  if (requestIsHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (url.pathname.startsWith('/api/auth/')) {
    res.setHeader('Cache-Control', 'no-store');
    await handleAuthApi(req, res, url);
    if (!res.writableEnded) send(res, 404, JSON.stringify({ error: 'Not found' }), 'application/json; charset=utf-8');
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
    if (!supabaseConfigured || !supabaseBaseValid)
      return send(
        res,
        503,
        JSON.stringify({ error: 'Supabase server configuration is required.' }),
        'application/json; charset=utf-8',
      );
    const rtcRequest = url.pathname.startsWith('/api/rtc/'),
      actionRequest = req.method === 'POST' && ['/api/action', '/api/field/action'].includes(url.pathname),
      trafficTileRequest = req.method === 'GET' && url.pathname.startsWith('/api/traffic/tiles/flow/'),
      diagnosticsRequest = req.method === 'GET' && url.pathname === '/api/diagnostics/export';
    if (!cloudReady && !rtcRequest && !actionRequest && !trafficTileRequest && !diagnosticsRequest)
      return send(
        res,
        503,
        JSON.stringify({
          error: cloudInitError
            ? `Supabase storage unavailable: ${cloudInitError}. Check the database schema and connection.`
            : 'Supabase storage is not ready. Check the database schema and connection.',
        }),
        'application/json; charset=utf-8',
      );
    // Map tiles carry a short-lived token instead of a session lookup (see tileToken).
    if (trafficTileRequest && tileTokenValid(url.searchParams.get('t'))) return serveTomTomTrafficTile(res, url);
    const authUser = await currentUser(req, res);
    if (!authUser)
      return send(res, 401, JSON.stringify({ error: 'Sign in required' }), 'application/json; charset=utf-8');
    const fieldAllowed = new Set([
      '/api/field/state',
      '/api/field/action',
      '/api/ingest/location',
      '/api/rtc/register',
      '/api/rtc/peers',
      '/api/rtc/poll',
      '/api/rtc/signal',
    ]);
    if (authUser.role === 'field' && !fieldAllowed.has(url.pathname))
      return send(
        res,
        403,
        JSON.stringify({ error: 'Field accounts can access only their assigned unit' }),
        'application/json; charset=utf-8',
      );
    if (req.method === 'POST' && !originAllowed(req))
      return send(res, 403, JSON.stringify({ error: 'Request origin rejected' }), 'application/json; charset=utf-8');
    if (req.method === 'POST' && url.pathname === '/api/rtc/register') {
      try {
        const b = await readBody(req),
          peerId = String(b.peerId || ''),
          role = b.role === 'field' ? 'field' : 'control';
        if (!/^[a-zA-Z0-9_-]{12,80}$/.test(peerId)) throw Error('Invalid voice peer id');
        if (authUser.role === 'field' && (role !== 'field' || b.officerId !== authUser.officerId))
          throw Object.assign(Error('Field voice must use the assigned unit'), { status: 403 });
        if (role === 'field' && !state.officers.some((o) => o.id === b.officerId))
          throw Error('Choose a valid field terminal');
        const peer = {
          peerId,
          role,
          officerId: role === 'field' ? b.officerId : 'control',
          label: String(b.label || '').slice(0, 80),
          lastSeen: Date.now(),
        };
        if (IS_VERCEL) await upsertRtcPeer(peer);
        else rtcPeers.set(peerId, peer);
        if (role === 'field') touchOfficerPresence(b.officerId);
        return send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
      } catch (e) {
        return send(res, 400, JSON.stringify({ ok: false, error: e.message }), 'application/json; charset=utf-8');
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/rtc/peers') {
      const nowMs = Date.now();
      for (const [pid, p] of rtcPeers) if (nowMs - p.lastSeen > RTC_PEER_TTL_MS) rtcPeers.delete(pid);
      const officerId = authUser.role === 'field' ? authUser.officerId : url.searchParams.get('officerId'),
        role = authUser.role === 'field' ? 'control' : url.searchParams.get('role'),
        available = IS_VERCEL ? await liveRtcPeers() : [...rtcPeers.values()];
      const peers = available
        .filter(
          (p) =>
            p.peerId !== url.searchParams.get('exclude') &&
            // Control-room endpoints are not tied to a unit: a field phone must see them or the
            // app can never ring the control room.
            (!officerId || p.role === 'control' || p.officerId === officerId) &&
            (!role || p.role === role) &&
            (p.role !== 'field' || state.officers.some((o) => o.id === p.officerId && o.shiftId && !o.stunned)),
        )
        .map(({ peerId, role, officerId, label }) => ({ peerId, role, officerId, label }));
      return send(res, 200, JSON.stringify({ peers }), 'application/json; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/rtc/poll') {
      const peerId = url.searchParams.get('peer'),
        peer = IS_VERCEL ? await getLiveRtcPeer(peerId) : rtcPeers.get(peerId);
      if (authUser.role === 'field' && (!peer || peer.role !== 'field' || peer.officerId !== authUser.officerId))
        return send(
          res,
          403,
          JSON.stringify({ error: 'Voice session does not belong to this unit' }),
          'application/json; charset=utf-8',
        );
      if (
        !peer ||
        (IS_VERCEL ? peer.lastSeen < Date.now() - RTC_PEER_TTL_MS : Date.now() - peer.lastSeen > RTC_PEER_TTL_MS)
      )
        return send(
          res,
          404,
          JSON.stringify({ error: 'Voice client is not registered' }),
          'application/json; charset=utf-8',
        );
      const messages = IS_VERCEL ? await dequeueRtcSignals(peerId) : rtcInbox.get(peerId) || [];
      if (!IS_VERCEL) rtcInbox.delete(peerId);
      return send(res, 200, JSON.stringify({ messages }), 'application/json; charset=utf-8');
    }
    if (req.method === 'POST' && url.pathname === '/api/rtc/signal') {
      try {
        const b = await readBody(req),
          from = IS_VERCEL ? await getLiveRtcPeer(b.fromPeer) : rtcPeers.get(b.fromPeer),
          to = IS_VERCEL ? await getLiveRtcPeer(b.toPeer) : rtcPeers.get(b.toPeer);
        if (
          authUser.role === 'field' &&
          (!from || from.role !== 'field' || from.officerId !== authUser.officerId || !to || to.role !== 'control')
        )
          throw Object.assign(Error('Voice signaling is limited to this unit and a control console'), { status: 403 });
        if (!from) throw Error('Caller voice client expired');
        if (!to) throw Error('Target terminal has no live voice client');
        if (!['offer', 'answer', 'ice', 'hangup', 'reject'].includes(b.type)) throw Error('Invalid voice signal');
        const message = {
          id: id('rtc'),
          at: now(),
          fromPeer: b.fromPeer,
          toPeer: b.toPeer,
          callId: String(b.callId || ''),
          type: b.type,
          payload: b.payload || {},
        };
        if (IS_VERCEL) await enqueueRtcSignal(message);
        else {
          const queue = rtcInbox.get(b.toPeer) || [];
          if (queue.length > 100) throw Error('Voice signal queue is full');
          queue.push(message);
          rtcInbox.set(b.toPeer, queue);
        }
        return send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
      } catch (e) {
        return send(res, 409, JSON.stringify({ ok: false, error: e.message }), 'application/json; charset=utf-8');
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/diagnostics/export')
      return send(res, 200, JSON.stringify({ events: exportDiagnosticEvents() }), 'application/json; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/state') {
      if (authUser.role !== 'operator')
        return send(
          res,
          403,
          JSON.stringify({ error: 'Operator account required' }),
          'application/json; charset=utf-8',
        );
      const source = req.dispatchStateSnapshot || state,
        since = url.searchParams.get('since');
      if (req.dispatchStateUnchanged || (since && since === source.updatedAt)) return send(res, 304, '');
      const body = clientStateForAuthenticatedUser(source);
      return send(res, 200, JSON.stringify(body), 'application/json; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/field/state') {
      const since = url.searchParams.get('since');
      if (authUser.role === 'field') {
        const requested = url.searchParams.get('officerId');
        if (requested && requested !== authUser.officerId)
          return send(
            res,
            403,
            JSON.stringify({ error: 'You can access only your assigned unit' }),
            'application/json; charset=utf-8',
          );
        if (req.dispatchStateUnchanged) return send(res, 304, '');
        try {
          const rows = await cloudUserRequest(
              `/rest/v1/dispatch_unit_state?select=payload,updated_at&officer_id=eq.${encodeURIComponent(authUser.officerId)}&limit=1`,
              { accessToken: authUser.accessToken },
            ),
            row = rows?.[0];
          if (!row)
            return send(
              res,
              404,
              JSON.stringify({ error: 'Unit data is not yet available; ask an operator to sync the roster' }),
              'application/json; charset=utf-8',
            );
          if (since && since === row.updated_at) return send(res, 304, '');
          const body = { ...row.payload, updatedAt: row.updated_at };
          return send(res, 200, JSON.stringify(body), 'application/json; charset=utf-8');
        } catch (error) {
          return send(
            res,
            error.status || 503,
            JSON.stringify({
              error:
                error.status === 401
                  ? 'Unit session expired; sign in again'
                  : 'Unit-scoped data is unavailable. Run the current Supabase schema migration.',
            }),
            'application/json; charset=utf-8',
          );
        }
      }
      if (req.dispatchStateUnchanged) return send(res, 304, '');
      const source = req.dispatchStateSnapshot || state,
        officerId = String(url.searchParams.get('officerId') || source.officers[0]?.id || '');
      if (since && since === source.updatedAt) return send(res, 304, '');
      const body = fieldStateForAuthenticatedUser(officerId, source);
      return body
        ? send(res, 200, JSON.stringify(body), 'application/json; charset=utf-8')
        : send(res, 404, JSON.stringify({ error: 'Choose a valid field terminal' }), 'application/json; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/history') {
      const date = url.searchParams.get('date') || '',
        from = url.searchParams.get('from') || date,
        to = url.searchParams.get('to') || date,
        officerId = url.searchParams.get('officerId') || 'all';
      const validDay = (value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
      if (!validDay(from) || !validDay(to) || (from && to && from > to))
        return send(
          res,
          400,
          JSON.stringify({ error: 'Use a valid date or date range' }),
          'application/json; charset=utf-8',
        );
      try {
        const [points, trafficRows] = await Promise.all([
          readLocationArchive({ from, to, officerId }),
          Promise.resolve(
            (state.traffic || []).filter((t) => {
              const day = new Intl.DateTimeFormat('en-CA', {
                timeZone: state.settings.timezone || 'UTC',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
              }).format(new Date(t.at));
              return (!from || day >= from) && (!to || day <= to);
            }),
          ),
        ]);
        const limit = 20000,
          truncated = points.length > limit;
        const traffic = trafficRows.map((t) => ({
          id: t.id,
          siteId: t.siteId,
          at: t.at,
          currentSpeed: t.currentSpeed,
          freeFlowSpeed: t.freeFlowSpeed,
          confidence: t.confidence,
          roadClosure: t.roadClosure,
          ratio: t.ratio,
          level: t.level,
          provider: t.provider,
        }));
        return send(
          res,
          200,
          JSON.stringify({
            points: points.slice(-limit),
            traffic: traffic.slice(-limit),
            positionCount: points.length,
            trafficCount: traffic.length,
            truncated: truncated || traffic.length > limit,
          }),
          'application/json; charset=utf-8',
        );
      } catch (error) {
        return send(
          res,
          503,
          JSON.stringify({ error: 'GPS archive is not available. Run the current Supabase schema migration.' }),
          'application/json; charset=utf-8',
        );
      }
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/recordings/')) {
      const recordingId = url.pathname.split('/').at(-1),
        recording = state.recordings.find((item) => item.id === recordingId);
      if (!recording?.data)
        return send(res, 404, JSON.stringify({ error: 'Recording not found' }), 'application/json; charset=utf-8');
      let data = String(recording.data),
        bytes;
      if (data.startsWith('data:')) {
        const comma = data.indexOf(',');
        if (comma < 0)
          return send(
            res,
            422,
            JSON.stringify({ error: 'Recording data is invalid' }),
            'application/json; charset=utf-8',
          );
        bytes = data.slice(0, comma).includes(';base64')
          ? Buffer.from(data.slice(comma + 1), 'base64')
          : Buffer.from(decodeURIComponent(data.slice(comma + 1)));
      } else bytes = Buffer.from(data, 'base64');
      const filename = String(recording.name || 'dispatch-recording').replace(/[\r\n"]+/g, '_');
      res.writeHead(200, {
        'Content-Type': recording.mime || 'application/octet-stream',
        'Cache-Control': 'private, max-age=60',
        'Content-Disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(bytes);
    }
    if (req.method === 'GET' && url.pathname === '/api/export') {
      await ensureTrafficRows();
      const format = url.searchParams.get('format') || 'csv',
        type = url.searchParams.get('type') || 'officers';
      const rows =
        type === 'locations'
          ? (await readLocationArchive({ officerId: 'all' })).map((p) => ({
              officer: p.officer.callSign,
              lat: p.lat,
              lng: p.lng,
              accuracy: p.accuracy,
              phoneTime: p.phoneTime,
              receivedAt: p.receivedAt,
              source: p.source,
            }))
          : exportRows(type);
      if (format === 'json') return send(res, 200, JSON.stringify(rows, null, 2), 'application/json; charset=utf-8');
      return send(res, 200, toCsv(rows), 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="dispatch-${type}-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/traffic/sample') {
      try {
        const b = await readBody(req);
        const result = b.siteId
          ? await sampleTomTomTraffic(String(b.siteId), { force: Boolean(b.force) })
          : await sampleTomTomTrafficBatch({ force: Boolean(b.force) });
        return send(res, 200, JSON.stringify({ ok: true, ...result }), 'application/json; charset=utf-8');
      } catch (e) {
        return send(
          res,
          e.status || 502,
          JSON.stringify({ ok: false, error: e.message || 'Traffic sample failed' }),
          'application/json; charset=utf-8',
        );
      }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/traffic/tiles/flow/'))
      return serveTomTomTrafficTile(res, url);
    if (req.method === 'GET' && url.pathname === '/api/traffic') {
      const traffic = await ensureTrafficRows({ fresh: true });
      return send(res, 200, JSON.stringify({ traffic, updatedAt: state.updatedAt }), 'application/json; charset=utf-8');
    }
    if (req.method === 'POST' && url.pathname === '/api/traffic') {
      try {
        const b = await readBody(req),
          site = state.sites.find((x) => x.id === b.siteId);
        if (!site) throw Error('Unknown site');
        await ensureTrafficRows();
        const currentSpeed = Number(b.currentSpeed),
          freeFlowSpeed = Number(b.freeFlowSpeed);
        if (!Number.isFinite(currentSpeed) || !Number.isFinite(freeFlowSpeed) || freeFlowSpeed <= 0)
          throw Error('Invalid flow reading');
        const ratio = Math.max(0, Math.min(1, currentSpeed / freeFlowSpeed));
        const level = b.roadClosure
          ? 'stopped'
          : ratio < 0.25
            ? 'heavy'
            : ratio < 0.55
              ? 'slow'
              : ratio < 0.8
                ? 'moderate'
                : 'free';
        const reading = {
          id: id('traffic'),
          siteId: site.id,
          at: now(),
          currentSpeed,
          freeFlowSpeed,
          confidence: Number(b.confidence || 0),
          roadClosure: Boolean(b.roadClosure),
          ratio,
          level,
          provider: 'TomTom',
        };
        state.traffic.push(reading);
        if (state.traffic.length > STATE_LIMITS.traffic)
          state.traffic.splice(0, state.traffic.length - STATE_LIMITS.traffic);
        trafficDirty = true;
        await save();
        return send(res, 200, JSON.stringify({ ok: true, reading }), 'application/json; charset=utf-8');
      } catch (e) {
        return send(
          res,
          e.status ? 503 : 400,
          JSON.stringify({ ok: false, error: e.status ? 'Supabase persistence failed' : e.message }),
          'application/json; charset=utf-8',
        );
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      try {
        const body = await readBody(req),
          criticalAction = ['call-start', 'call-answer', 'call-fail', 'call-end', 'sos', 'sos-location'].includes(
            body.type,
          ),
          voiceCallAction = ['call-start', 'call-answer', 'call-fail', 'call-end'].includes(body.type);
        if (!cloudReady && !criticalAction)
          return send(
            res,
            503,
            JSON.stringify({
              ok: false,
              error: cloudInitError
                ? `Supabase storage unavailable: ${cloudInitError}`
                : 'Supabase storage is not ready',
            }),
            'application/json; charset=utf-8',
          );
        recordDiagnostic('system.action', { action: String(body.type || 'unknown').slice(0, 80) }, 'info');
        body.actor = authUser.email || 'Authenticated user';
        if (body.type === 'officer-delete' && unitSchemaReady) {
          const account = await cloudRequest(
            `/rest/v1/dispatch_unit_accounts?select=user_id&officer_id=eq.${encodeURIComponent(String(body.officerId || ''))}&limit=1`,
          );
          if (account?.length)
            throw Object.assign(Error('Remove this unit’s field login before deleting the unit'), { status: 409 });
        }
        const result = await action(body);
        let volatile = false;
        try {
          await save();
        } catch (error) {
          if (!criticalAction) throw error;
          volatile = true;
        }
        if (criticalAction && !cloudReady) {
          volatile = true;
          if (voiceCallAction) {
            const callId = result.call || body.id;
            if (callId) volatileCallIds.add(callId);
          }
        }
        return send(
          res,
          200,
          JSON.stringify({ ok: true, result, state: clientStateForAuthenticatedUser(), volatile }),
          'application/json; charset=utf-8',
        );
      } catch (e) {
        const status = [400, 403, 409].includes(e.status) ? e.status : e.status ? 503 : 400;
        return send(
          res,
          status,
          JSON.stringify({
            ok: false,
            error: [400, 403, 409].includes(e.status)
              ? e.message
              : e.status
                ? 'Supabase persistence failed'
                : e.message,
          }),
          'application/json; charset=utf-8',
        );
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/field/action') {
      try {
        const body = await readBody(req),
          allowed = [
            'clock-in',
            'clock-out',
            'field-presence',
            'sos',
            'message',
            'mark-read',
            'break',
            'call-start',
            'call-answer',
            'call-fail',
            'call-end',
          ];
        if (!allowed.includes(body.type)) throw Error('Unsupported field action');
        if (authUser.role === 'field') {
          if (body.officerId && body.officerId !== authUser.officerId)
            throw Object.assign(Error('You can update only your assigned unit'), { status: 403 });
          body.officerId = authUser.officerId;
          if (body.type === 'message') {
            const own = state.officers.find((x) => x.id === authUser.officerId);
            body.from = own?.callSign || 'Field unit';
            body.to = 'all';
            body.group = own?.group || null;
            delete body.scheduledAt;
          }
          if (body.type === 'clock-in') {
            const own = state.officers.find((x) => x.id === authUser.officerId),
              assignedSite =
                own?.siteId && state.sites.find((site) => site.id === own.siteId && site.areaType === 'work');
            if (!assignedSite)
              throw Object.assign(Error('Ask Control to assign this unit to an active work site before clocking in'), {
                status: 409,
              });
            if (body.siteId && body.siteId !== own.siteId)
              throw Object.assign(Error('You can clock in only at your assigned work site'), { status: 403 });
            body.siteId = own.siteId;
          }
          if (body.type === 'mark-read') {
            const m = state.messages.find((x) => x.id === body.id);
            const own = state.officers.find((x) => x.id === authUser.officerId);
            if (!m || !(m.to === authUser.officerId || (m.to === 'all' && (!m.group || m.group === own?.group))))
              throw Object.assign(Error('Message does not belong to this unit'), { status: 403 });
          }
        }
        const criticalAction = [
            'clock-out',
            'field-presence',
            'call-start',
            'call-answer',
            'call-fail',
            'call-end',
            'sos',
          ].includes(body.type),
          voiceCallAction = ['call-start', 'call-answer', 'call-fail', 'call-end'].includes(body.type);
        if (!cloudReady && !criticalAction)
          return send(
            res,
            503,
            JSON.stringify({
              ok: false,
              error: cloudInitError
                ? `Supabase storage unavailable: ${cloudInitError}`
                : 'Supabase storage is not ready',
            }),
            'application/json; charset=utf-8',
          );
        body.actor = authUser.email || 'Authenticated field user';
        const result = await action(body);
        let volatile = false;
        try {
          await save();
        } catch (error) {
          if (!criticalAction) throw error;
          volatile = true;
        }
        if (criticalAction && !cloudReady) {
          volatile = true;
          if (voiceCallAction) {
            const callId = result.call || body.id;
            if (callId) volatileCallIds.add(callId);
          }
        }
        let fieldState;
        if (authUser.role === 'field') {
          const rows = await cloudUserRequest(
            `/rest/v1/dispatch_unit_state?select=payload,updated_at&officer_id=eq.${encodeURIComponent(authUser.officerId)}&limit=1`,
            { accessToken: authUser.accessToken },
          );
          fieldState = rows?.[0] ? { ...rows[0].payload, updatedAt: rows[0].updated_at } : null;
        } else fieldState = fieldStateForAuthenticatedUser(String(body.officerId || ''));
        return send(
          res,
          200,
          JSON.stringify({ ok: true, result, state: fieldState, volatile }),
          'application/json; charset=utf-8',
        );
      } catch (e) {
        const status = [400, 403, 409].includes(e.status) ? e.status : e.status ? 503 : 400;
        return send(
          res,
          status,
          JSON.stringify({
            ok: false,
            error: [400, 403, 409].includes(e.status)
              ? e.message
              : e.status
                ? 'Supabase persistence failed'
                : e.message,
          }),
          'application/json; charset=utf-8',
        );
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/ingest/location') {
      try {
        const b = await readBody(req);
        if (authUser.role === 'field') {
          if (b.officerId && b.officerId !== authUser.officerId)
            throw Object.assign(Error('You can update only your assigned unit'), { status: 403 });
          b.officerId = authUser.officerId;
        }
        const o = state.officers.find((x) => x.id === b.officerId);
        if (!o) throw Error('Unknown officer');
        const r = processLocation(o, b);
        await save();
        return send(res, 200, JSON.stringify({ ok: true, ...r }), 'application/json; charset=utf-8');
      } catch (e) {
        return send(
          res,
          e.status === 403 ? 403 : e.status ? 503 : 400,
          JSON.stringify({
            ok: false,
            error: e.status === 403 ? e.message : e.status ? 'Supabase persistence failed' : e.message,
          }),
          'application/json; charset=utf-8',
        );
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/backup') {
      try {
        return send(res, 200, JSON.stringify(await makeBackup()), 'application/json; charset=utf-8');
      } catch (e) {
        return send(res, 503, JSON.stringify({ error: 'Supabase backup failed' }), 'application/json; charset=utf-8');
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/backups') {
      try {
        return send(res, 200, JSON.stringify(await listBackups()), 'application/json; charset=utf-8');
      } catch {
        return send(
          res,
          503,
          JSON.stringify({ error: 'Supabase backup storage is unavailable' }),
          'application/json; charset=utf-8',
        );
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/restore') {
      try {
        const b = await readBody(req),
          file = String(b.file || '');
        if (!/^dispatch-[a-zA-Z0-9T_.-]+$/.test(file)) throw Error('Invalid backup identifier');
        const priorCount = state.officers.length + state.sites.length;
        let restoredAt;
        if (unitSchemaReady) {
          const result = await cloudRequest('/rest/v1/rpc/dispatch_restore_backup', {
            method: 'POST',
            body: JSON.stringify({ p_file: file }),
          });
          restoredAt = result?.restoredAt || now();
          await refreshCloudState();
        } else {
          const rows = await cloudRequest(
            `/rest/v1/dispatch_backups?select=payload&file=eq.${encodeURIComponent(file)}&limit=1`,
          );
          const restored = rows?.[0]?.payload;
          if (!restored?.officers || !restored?.sites) throw Error('Backup file was not found or is invalid');
          state = restored;
          state.locationEventIds ||= [];
          locationEventSet.clear();
          state.locationEventIds.forEach((x) => locationEventSet.add(x));
          restoredAt = now();
        }
        audit('Database restored', file, authUser.email);
        await save();
        return send(
          res,
          200,
          JSON.stringify({ ok: true, restoredAt, previousRecords: priorCount }),
          'application/json; charset=utf-8',
        );
      } catch (e) {
        return send(res, e.status || 400, JSON.stringify({ error: e.message }), 'application/json; charset=utf-8');
      }
    }

    return send(res, 404, JSON.stringify({ error: 'Not found' }), 'application/json; charset=utf-8');
  }
  let file = decodeURIComponent(url.pathname);
  if (file === '/' || file === '/') file = '/index.html';
  const target = path.resolve(PUBLIC, `.${file}`);
  if (!target.startsWith(PUBLIC + path.sep)) {
    return send(res, 403, 'Forbidden', 'text/plain');
  }
  try {
    const content = await fs.promises.readFile(target);
    send(res, 200, content, MIME[path.extname(target)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
  } catch {
    send(res, 404, 'Not found', 'text/plain', { 'Cache-Control': 'no-store' });
  }
};
const server = http.createServer(requestListener);
function action(b) {
  const at = now(),
    o = state.officers.find((x) => x.id === b.officerId),
    actor = b.actor || 'Local console';
  switch (b.type) {
    case 'clock-in': {
      if (!o) throw Error('Choose an officer');
      if (o.stunned) throw Error('This terminal is stunned');
      if (o.shiftId) throw Error('Officer is already clocked in');
      const s = state.sites.find((x) => x.id === b.siteId) || state.sites.find((x) => x.areaType === 'work');
      if (!s) throw Error('Create a work site first');
      o.shiftId = id('shift');
      o.siteId = s.id;
      o.status = 'en-route';
      o.online = false;
      o.tracking = true;
      o.clockedInAt = at;
      o.onSiteSince = null;
      audit('Clocked in', `${o.callSign} · ${s.name}`, actor);
      return { officer: o.id, site: s.id };
    }
    case 'clock-out': {
      if (!o) throw Error('Choose an officer');
      o.status = 'off-duty';
      o.shiftId = null;
      o.tracking = false;
      o.online = false;
      o.clockedOutAt = at;
      for (const a of state.alerts.filter(
        (x) => x.officerId === o.id && x.status !== 'handled' && ['absence', 'left-site'].includes(x.type),
      )) {
        a.status = 'handled';
        a.events.push({ status: 'handled', at, by: actor, note: 'Shift ended' });
      }
      audit('Clocked out', o.callSign, actor);
      return {};
    }
    case 'field-presence': {
      if (!o) throw Error('Choose an officer');
      if (Boolean(b.online)) {
        if (!o.shiftId) throw Error('Clock in before going online');
        if (o.stunned) throw Error('This terminal is stunned');
        o.tracking = true;
        touchOfficerPresence(o.id);
        audit('Field terminal online', o.callSign, actor);
        return { online: true, tracking: true };
      }
      o.online = false;
      o.tracking = false;
      audit('Field terminal offline', o.callSign, actor);
      return { online: false, tracking: false };
    }
    case 'sos': {
      if (!o) throw Error('Choose an officer');
      if (!o.shiftId) throw Error('Officer must be clocked in to raise SOS');
      if (o.stunned) throw Error('This terminal is stunned and cannot transmit');
      const reported =
        b.location && Number.isFinite(Number(b.location.lat)) && Number.isFinite(Number(b.location.lng))
          ? b.location
          : null;
      if (
        Number.isFinite(Number(reported?.battery)) &&
        Number(reported.battery) >= 0 &&
        Number(reported.battery) <= 100
      )
        o.battery = Number(reported.battery);
      if (Number.isFinite(Number(reported?.signal)) && Number(reported.signal) >= 0 && Number(reported.signal) <= 5)
        o.signal = Number(reported.signal);
      const reportedAt = Date.parse(reported?.locationAt || ''),
        knownAt = Date.parse(o.lastSeen || ''),
        useReported = reported && (!Number.isFinite(knownAt) || !Number.isFinite(reportedAt) || reportedAt >= knownAt),
        point = useReported
          ? {
              lat: Number(reported.lat),
              lng: Number(reported.lng),
              accuracy: Number(reported.accuracy ?? o.accuracy ?? 0),
              phoneTime: reported.locationAt || at,
              receivedAt: at,
            }
          : null,
        pressKey = String(b.raisedAt || at),
        repeatOfPress = state.alerts.find(
          (x) => x.type === 'sos' && x.officerId === o.id && String(x.phonePressedAt || '') === pressKey,
        );
      // A phone (or its offline queue) can resend the same press minutes later. That must never
      // raise a second alarm, not even after control has already resolved the first one.
      if (repeatOfPress) {
        if (repeatOfPress.status === 'raised') {
          repeatOfPress.lastRaisedAt = at;
          repeatOfPress.events.push({ status: 'repeated', at, by: actor });
        }
        return { alert: repeatOfPress.id, duplicate: true };
      }
      const previous = state.alerts.find(
          (x) =>
            x.type === 'sos' &&
            x.officerId === o.id &&
            x.status === 'raised' &&
            Date.now() - Date.parse(x.raisedAt) < 120000,
        ),
        a = raiseAlert(
          'sos',
          'SOS emergency',
          `${o.callSign} needs immediate assistance`,
          o,
          null,
          point || { lat: o.lat, lng: o.lng, accuracy: o.accuracy },
        );
      a.raisedAt ||= at;
      a.lastRaisedAt = at;
      a.phonePressedAt = b.raisedAt || at;
      a.offline = Boolean(b.offline || !o.online);
      a.events ||= [];
      if (a.events[0]?.status === 'raised') a.events[0].by = actor;
      if (previous) a.events.push({ status: 'repeated', at, by: actor });
      const snap = sosLocationRecord(
        o,
        point || { lat: o.lat, lng: o.lng, accuracy: o.accuracy, phoneTime: o.lastSeen, receivedAt: at },
        point ? 'device-report' : 'last-known',
      );
      snap.phonePressedAt = a.phonePressedAt;
      snap.raisedAt = a.raisedAt;
      snap.offline = a.offline;
      snap.locationAgeSeconds = Number.isFinite(Date.parse(snap.locationAt))
        ? Math.max(0, Math.floor((Date.now() - Date.parse(snap.locationAt)) / 1000))
        : null;
      a.lat = snap.lat;
      a.lng = snap.lng;
      a.accuracy = snap.accuracy;
      a.locationAt = snap.locationAt;
      a.locationReceivedAt = at;
      a.sosSnapshot = snap;
      a.locationHistory ||= [];
      if (snap.lat !== null && snap.lng !== null && (!a.locationHistory.length || previous)) {
        a.locationHistory.push(snap);
        if (a.locationHistory.length > 10000) a.locationHistory.shift();
      }
      audit('SOS raised', o.callSign, actor);
      return { alert: a.id };
    }
    case 'sos-location': {
      if (!o) throw Error('Choose an officer');
      const a = state.alerts.find(
        (x) => (!b.alertId || x.id === b.alertId) && x.type === 'sos' && x.officerId === o.id && x.status !== 'handled',
      );
      if (!a) throw Error('Active SOS alert not found');
      if (!b.point) throw Error('GPS point required');
      if (Number.isFinite(Number(b.battery)) && Number(b.battery) >= 0 && Number(b.battery) <= 100)
        o.battery = Number(b.battery);
      if (Number.isFinite(Number(b.signal)) && Number(b.signal) >= 0 && Number(b.signal) <= 5)
        o.signal = Number(b.signal);
      const result = processLocation(o, {
        ...b.point,
        eventId: b.point.eventId || `sos-${a.id}-${b.point.timestamp || at}`,
      });
      if (result.ignored) throw Error('Location sharing is off duty');
      a.offline = false;
      a.sosSnapshot = { ...(a.sosSnapshot || {}), battery: o.battery ?? null, signal: o.signal ?? null };
      audit('SOS location updated', o.callSign, actor);
      return { alert: a.id, point: result.point };
    }
    case 'alert-status': {
      const a = state.alerts.find((x) => x.id === b.id);
      if (!a) throw Error('Alert not found');
      if (!['taken', 'handled'].includes(b.status)) throw Error('Invalid alert status');
      if (b.status === 'handled' && !String(b.note || '').trim()) throw Error('Add a short resolution note');
      a.status = b.status;
      a.events.push({ status: b.status, at, by: actor, note: b.note || '' });
      if (b.status === 'taken') a.takenBy = actor;
      if (b.status === 'handled') {
        a.handledBy = actor;
        a.note = b.note;
      }
      audit(`Alert ${b.status}`, a.title, actor);
      return {};
    }
    case 'message': {
      const body = String(b.body || '').trim();
      if (!body) throw Error('Write a message first');
      const sender = state.officers.find((x) => x.callSign === b.from);
      if (sender && !sender.shiftId) throw Error('Clock in before sending messages');
      if (sender?.stunned) throw Error('This terminal is stunned and cannot transmit');
      const to = b.to || 'all',
        group = b.group || null,
        recipient = state.officers.find((x) => x.id === to),
        groupOnline = to === 'all' && group && state.officers.some((x) => x.group === group && x.online),
        delivered = to === 'all' ? !group || groupOnline : Boolean(recipient?.online);
      const m = {
        id: id('msg'),
        from: b.from || 'Control',
        to,
        group,
        body,
        createdAt: at,
        deliveredAt: delivered ? at : null,
        readAt: null,
        scheduledAt: b.scheduledAt || null,
      };
      if (m.scheduledAt) state.scheduledMessages.push(m);
      else state.messages.unshift(m);
      audit(m.scheduledAt ? 'Message scheduled' : 'Message sent', m.to, actor);
      return { message: m.id };
    }
    case 'mark-read': {
      const m = state.messages.find((x) => x.id === b.id);
      if (m) m.readAt = at;
      return {};
    }
    case 'site-save': {
      if (!b.name?.trim()) throw Error('Site name is required');
      const coords = (b.coordinates || []).map((p) => [Number(p[0]), Number(p[1])]);
      if (coords.length < 3) throw Error('Draw at least three points on the map');
      let s = b.id && state.sites.find((x) => x.id === b.id);
      if (s)
        Object.assign(s, {
          name: b.name.trim(),
          areaType: b.areaType || 'work',
          coordinates: coords,
          color: b.color || '#e0a12a',
          tolerance: Number(b.tolerance || 40),
          assigned: b.assigned || [],
        });
      else {
        s = {
          id: id('site'),
          name: b.name.trim(),
          areaType: b.areaType || 'work',
          coordinates: coords,
          color: b.color || '#e0a12a',
          tolerance: Number(b.tolerance || 40),
          assigned: [],
        };
        state.sites.push(s);
      }
      audit('Site saved', s.name, actor);
      return { site: s.id };
    }
    case 'site-delete': {
      state.sites = state.sites.filter((x) => x.id !== b.id);
      audit('Site deleted', b.id, actor);
      return {};
    }
    case 'officer-save': {
      let person = b.officer || {};
      let x = person.id && state.officers.find((y) => y.id === person.id);
      if (x) {
        Object.assign(x, person);
        audit('Officer details updated', x.callSign, actor);
      } else {
        x = {
          id: id('officer'),
          name: person.name || 'New officer',
          callSign: person.callSign || 'Unit',
          group: person.group || state.groups[0],
          phone: person.phone || 'Android',
          status: 'off-duty',
          shiftId: null,
          siteId: person.siteId || null,
          lat: null,
          lng: null,
          accuracy: null,
          battery: null,
          signal: null,
          online: false,
          lastSeen: null,
          color: person.color || '#648b73',
          speed: null,
          stunned: false,
          tracking: false,
          history: [],
          config: {
            locationInterval: 15,
            defaultGroup: person.group || state.groups[0],
            colorCode: '1',
            timeSlot: '1',
            frequency: '',
          },
        };
        state.officers.push(x);
        audit('Officer added', x.callSign, actor);
      }
      return { officer: x.id };
    }
    case 'officer-delete': {
      if (!o) throw Error('Officer not found');
      if (o.shiftId) throw Error('Clock out before removing an officer');
      state.officers = state.officers.filter((x) => x.id !== o.id);
      audit('Officer removed', o.callSign, actor);
      return {};
    }
    case 'stun': {
      if (!o) throw Error('Choose an officer');
      o.stunned = Boolean(b.stunned);
      audit(o.stunned ? 'Terminal stunned' : 'Terminal reactivated', o.callSign, actor);
      if (o.stunned) raiseAlert('stun', 'Terminal stunned', o.callSign, o, null);
      return {};
    }
    case 'status-query': {
      const units = b.officerId ? state.officers.filter((x) => x.id === b.officerId) : state.officers;
      audit('Terminal status query', b.officerId || `${units.length} units`, actor);
      return {
        units: units.map((x) => ({
          id: x.id,
          callSign: x.callSign,
          online: x.online,
          stunned: x.stunned,
          shiftId: x.shiftId,
          status: x.status,
          battery: x.battery,
          signal: x.signal,
          lat: x.lat,
          lng: x.lng,
          accuracy: x.accuracy,
          lastSeen: x.lastSeen,
        })),
      };
    }
    case 'break': {
      if (!o || !o.shiftId) throw Error('Officer must be on shift');
      if (b.enabled) {
        if (o.status === 'on-break') throw Error('Break is already active');
        o.status = 'on-break';
        o.breakStartedAt = at;
        audit('Break started', o.callSign, actor);
        return { status: o.status };
      }
      if (o.status !== 'on-break') throw Error('No active break');
      o.breakEndedAt = at;
      o.status = 'en-route';
      const s = state.sites.find((x) => x.id === o.siteId);
      if (
        s &&
        (pointInPolygon([o.lat, o.lng], s.coordinates) ||
          pointNearPolygon([o.lat, o.lng], s.coordinates, Number(s.tolerance || 0)))
      )
        o.status = 'on-site';
      audit('Break ended', o.callSign, actor);
      return { status: o.status };
    }
    case 'tracking': {
      if (!o) throw Error('Choose an officer');
      o.tracking = Boolean(b.enabled);
      audit(o.tracking ? 'Tracking started' : 'Tracking stopped', o.callSign, actor);
      return {};
    }
    case 'call-start': {
      const caller = state.officers.find((x) => x.callSign === b.from);
      if (caller && (!caller.shiftId || caller.stunned))
        throw Error('Clock in and be active before starting a voice call');
      const c = {
        id: id('call'),
        type: b.callType || 'private',
        from: b.from || 'Control',
        to: b.to || 'all',
        group: b.group || null,
        startedAt: at,
        endedAt: null,
        status: b.live ? 'ringing' : 'active',
        live: Boolean(b.live),
        audioMode: b.live ? 'webrtc-lan' : null,
        participants: b.participantIds || [],
        recording: null,
        channel: Number(b.channel || 1),
      };
      if (state.calls.filter((x) => ['active', 'ringing'].includes(x.status)).length >= 8)
        throw Error('All eight dispatch channels are busy');
      state.calls.unshift(c);
      audit(b.live ? 'Live voice call ringing' : 'Call started', `${c.type} · ${c.to}`, actor);
      return { call: c.id };
    }
    case 'call-answer': {
      const c = state.calls.find((x) => x.id === b.id);
      if (!c) throw Error('Call not found');
      const participant = String(b.participant || ''),
        firstControlAnswer = Boolean(c.live && c.to === 'control');
      if (!['ringing', 'active'].includes(c.status)) return { accepted: false, reason: 'call-ended' };
      if (firstControlAnswer && c.answeredBy && participant && c.answeredBy !== participant)
        return { accepted: false, answeredBy: c.answeredBy, reason: 'another-controller-answered' };
      const firstAnswer = !c.answeredAt;
      if (c.status === 'ringing') c.status = 'active';
      c.answeredAt ||= at;
      if (firstControlAnswer && participant) c.answeredBy ||= participant;
      if (participant && !c.participants.includes(participant)) c.participants.push(participant);
      if (firstAnswer) audit('Live voice call answered', c.id, actor);
      return { accepted: true, answeredBy: c.answeredBy || participant || null };
    }
    case 'call-fail': {
      const c = state.calls.find((x) => x.id === b.id);
      if (!c) throw Error('Call not found');
      c.status = 'failed';
      c.endedAt = at;
      c.failure = String(b.reason || 'Call failed').slice(0, 200);
      audit('Voice call failed', c.failure, actor);
      return {};
    }
    case 'call-end': {
      const c = state.calls.find((x) => x.id === b.id);
      if (!c) throw Error('Call not found');
      c.endedAt = at;
      c.status = 'ended';
      audit('Call ended', c.id, actor);
      return {};
    }
    case 'recording-save': {
      if (String(b.data || '').length > STATE_LIMITS.recordingBytes)
        throw Error('Recording is larger than 8 MB. Keep field recordings short.');
      const r = {
        id: id('rec'),
        callId: b.callId || null,
        name: b.name || 'Dispatch recording',
        mime: b.mime || 'audio/webm',
        data: b.data || '',
        createdAt: at,
        duration: Number(b.duration || 0),
        from: b.from || 'Control',
        to: b.to || 'all',
      };
      state.recordings.unshift(r);
      if (b.callId) {
        const c = state.calls.find((x) => x.id === b.callId);
        if (c) c.recording = r.id;
      }
      audit('Recording stored', r.name, actor);
      return { recording: r.id };
    }
    case 'group-save': {
      const name = String(b.name || '').trim();
      if (!name) throw Error('Group name required');
      if (!state.groups.includes(name)) state.groups.push(name);
      audit('Group added', name, actor);
      return {};
    }
    case 'group-delete': {
      state.groups = state.groups.filter((x) => x !== b.name);
      audit('Group removed', b.name, actor);
      return {};
    }
    case 'region-save': {
      const r = {
        id: b.id || id('region'),
        name: b.name,
        areaType: b.areaType || 'work',
        coordinates: b.coordinates || [],
        assigned: b.assigned || [],
      };
      const i = state.regions.findIndex((x) => x.id === r.id);
      if (i >= 0) state.regions[i] = r;
      else state.regions.push(r);
      audit('Region saved', r.name, actor);
      return { region: r.id };
    }
    case 'region-delete': {
      state.regions = state.regions.filter((x) => x.id !== b.id);
      audit('Region deleted', b.id, actor);
      return {};
    }
    case 'relay-save': {
      const r = {
        id: b.id || id('relay'),
        name: b.name || 'Relay node',
        host: String(b.host || '').trim(),
        mode: b.mode || 'relay',
        status: 'configured',
      };
      const i = state.relays.findIndex((x) => x.id === r.id);
      if (i >= 0) state.relays[i] = r;
      else state.relays.push(r);
      audit('Relay node configured', r.name, actor);
      return { relay: r.id };
    }
    case 'patch-save': {
      const p = {
        id: id('patch'),
        name: b.name || 'Audio patch',
        members: b.members || [],
        active: true,
        createdAt: at,
      };
      state.callPatches.push(p);
      audit('Audio patch preset saved', p.name, actor);
      return {};
    }
    case 'patch-stop': {
      const p = state.callPatches.find((x) => x.id === b.id);
      if (p) p.active = false;
      audit('Audio patch removed', b.id, actor);
      return {};
    }
    case 'settings': {
      const incoming = { ...(b.settings || {}) };
      if (!String(incoming.trafficKey || '').trim()) delete incoming.trafficKey;
      Object.assign(state.settings, incoming);
      state.settings.backupFrequency = 'hourly';
      delete state.settings.mapTileUrl;
      if (Object.hasOwn(b.settings || {}, 'mapProvider')) {
        state.settings.mapProvider = ['Esri World Street Map', 'OpenStreetMap'].includes(b.settings.mapProvider)
          ? b.settings.mapProvider
          : 'Esri World Street Map';
        state.settings.mapProviderUserSet = true;
      }
      audit('System settings changed', 'Settings', actor);
      return {};
    }
    case 'audit':
      audit(b.action || 'Console action', b.target || '', actor);
      return {};
    case 'import': {
      const list = b.officers || [];
      let added = 0;
      for (const item of list) {
        if (!item.name) continue;
        const dup = state.officers.some((x) => x.callSign === item.callSign);
        if (dup) continue;
        action({ type: 'officer-save', officer: item, actor });
        added++;
      }
      audit('Batch import', `${added} officers`);
      return { added };
    }
    case 'backup':
      return makeBackup();
    default:
      throw Error(`Unsupported action: ${b.type}`);
  }
}
async function makeBackup() {
  await save();
  await cloudWriteQueue;
  const file = `dispatch-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (unitSchemaReady) {
    const result = await cloudRequest('/rest/v1/rpc/dispatch_create_backup', {
      method: 'POST',
      body: JSON.stringify({ p_file: file }),
    });
    await pruneBackups();
    return result;
  }
  const payload = structuredClone(state),
    size = Buffer.byteLength(JSON.stringify(payload));
  await cloudRequest('/rest/v1/dispatch_backups', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ file, payload, size_bytes: size }),
  });
  await pruneBackups();
  return { file, createdAt: now(), size };
}

async function pruneBackups() {
  const keep = Math.max(1, Number(state.settings.backupRetention || 14)),
    files = await listBackups();
  for (const item of files.slice(keep))
    await cloudRequest(`/rest/v1/dispatch_backups?file=eq.${encodeURIComponent(item.file)}`, { method: 'DELETE' });
}
async function listBackups() {
  const rows = await cloudRequest(
    '/rest/v1/dispatch_backups?select=file,size_bytes,created_at&order=created_at.desc&limit=500',
  );
  return (rows || []).map((x) => ({ file: x.file, size: Number(x.size_bytes || 0), modifiedAt: x.created_at }));
}
function exportRows(type) {
  if (type === 'locations')
    return state.officers.flatMap((o) =>
      (o.history || []).map((p) => ({
        officer: o.callSign,
        lat: p.lat,
        lng: p.lng,
        accuracy: p.accuracy,
        phoneTime: p.phoneTime,
        receivedAt: p.receivedAt,
      })),
    );
  if (type === 'alerts')
    return state.alerts.map((a) => ({
      type: a.type,
      title: a.title,
      officer: state.officers.find((o) => o.id === a.officerId)?.callSign,
      status: a.status,
      raisedAt: a.raisedAt,
      phonePressedAt: a.phonePressedAt,
      locationAt: a.locationAt,
      lat: a.lat,
      lng: a.lng,
      accuracy: a.accuracy,
      battery: a.sosSnapshot?.battery,
      signal: a.sosSnapshot?.signal,
      offline: a.offline,
      site: a.sosSnapshot?.siteName,
      takenBy: a.takenBy,
      handledBy: a.handledBy,
      note: a.note,
    }));
  if (type === 'messages')
    return state.messages.map((m) => ({
      from: m.from,
      to: m.to,
      body: m.body,
      createdAt: m.createdAt,
      deliveredAt: m.deliveredAt,
      readAt: m.readAt,
    }));
  if (type === 'calls')
    return state.calls.map((c) => ({
      type: c.type,
      from: c.from,
      to: c.to,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      status: c.status,
      recording: c.recording,
    }));
  if (type === 'traffic')
    return state.traffic.map((t) => ({
      site: state.sites.find((s) => s.id === t.siteId)?.name,
      at: t.at,
      currentSpeed: t.currentSpeed,
      freeFlowSpeed: t.freeFlowSpeed,
      ratio: t.ratio,
      confidence: t.confidence,
      level: t.level,
      roadClosure: t.roadClosure,
      provider: t.provider,
    }));
  if (type === 'audit') return state.audit;
  if (type === 'sites')
    return state.sites.map((s) => ({
      id: s.id,
      name: s.name,
      areaType: s.areaType,
      tolerance: s.tolerance,
      assigned: s.assigned.join('|'),
    }));
  return state.officers.map((o) => ({
    id: o.id,
    name: o.name,
    callSign: o.callSign,
    group: o.group,
    status: o.status,
    site: state.sites.find((s) => s.id === o.siteId)?.name || '',
    online: o.online,
    lastSeen: o.lastSeen,
    battery: o.battery,
    stunned: o.stunned,
  }));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 25_000_000) {
        reject(Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
function send(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, ...headers });
  res.end(body);
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0)
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {}
  }
  return out;
}
function requestIsHttps(req) {
  return Boolean(
    req.socket.encrypted ||
      ((IS_VERCEL || String(process.env.DISPATCH_TRUST_PROXY || '').toLowerCase() === 'true') &&
        String(req.headers['x-forwarded-proto'] || '')
          .split(',')[0]
          .trim() === 'https'),
  );
}
function cookieLine(req, name, value, maxAge) {
  const secure =
    String(process.env.DISPATCH_COOKIE_SECURE || '').toLowerCase() === 'false'
      ? false
      : String(process.env.DISPATCH_COOKIE_SECURE || '').toLowerCase() === 'true' || requestIsHttps(req);
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function writeSessionCookies(req, res, session) {
  const headers = [
    cookieLine(req, 'dispatch_access', session.access_token, Math.max(60, Number(session.expires_in) || 3600)),
    cookieLine(req, 'dispatch_refresh', session.refresh_token, 60 * 60 * 24 * 30),
  ];
  res.setHeader('Set-Cookie', headers);
}
function clearSessionCookies(req, res) {
  res.setHeader('Set-Cookie', [cookieLine(req, 'dispatch_access', '', 0), cookieLine(req, 'dispatch_refresh', '', 0)]);
}
function safeAuthUser(user) {
  return {
    id: user.id,
    email: user.email || '',
    role: user.app_metadata?.dispatch_role === 'field' ? 'field' : 'operator',
    name: user.user_metadata?.full_name || user.user_metadata?.name || '',
  };
}
function publicAuthUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    name: user.name || '',
    ...(user.role === 'field' ? { officerId: user.officerId } : {}),
  };
}
async function resolveAuthUser(user, accessToken = '') {
  const safe = safeAuthUser(user);
  if (safe.role === 'field') {
    if (!unitSchemaReady)
      throw Object.assign(new Error('Field unit access is not configured. Run the current Supabase schema first.'), {
        status: 503,
      });
    const rows = await cloudRequest(
      `/rest/v1/dispatch_unit_accounts?select=officer_id&user_id=eq.${encodeURIComponent(safe.id)}&limit=1`,
    );
    if (!rows?.[0]?.officer_id)
      throw Object.assign(new Error('This field login has no active unit assignment'), { status: 403 });
    return { ...safe, officerId: rows[0].officer_id, accessToken };
  }
  return { ...safe, accessToken };
}
async function supabaseAuth(path, { method = 'GET', body, accessToken = '' } = {}) {
  const headers = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  if (!response.ok) throw Object.assign(new Error('Authentication request failed'), { status: response.status, data });
  return data;
}
const authCache = new Map(),
  loginAttempts = new Map();
async function currentUser(req, res) {
  if (!supabaseConfigured || !supabaseBaseValid) return null;
  const cookies = parseCookies(req);
  let access = cookies.dispatch_access,
    refresh = cookies.dispatch_refresh;
  if (!access && !refresh) return null;
  const cacheKey = access ? crypto.createHash('sha256').update(access).digest('hex') : '';
  const cached = cacheKey && authCache.get(cacheKey);
  if (cached && cached.until > Date.now()) return cached.user;
  try {
    const user = await supabaseAuth('/auth/v1/user', { accessToken: access }),
      resolved = await resolveAuthUser(user, access);
    if (cacheKey) {
      authCache.set(cacheKey, { user: resolved, until: Date.now() + 30000 });
      if (authCache.size > 2000) authCache.delete(authCache.keys().next().value);
    }
    return resolved;
  } catch (error) {
    if (error.status !== 401 || !refresh) return null;
  }
  try {
    const session = await supabaseAuth('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: refresh },
    });
    if (!session.access_token || !session.refresh_token) return null;
    writeSessionCookies(req, res, session);
    const user = session.user || (await supabaseAuth('/auth/v1/user', { accessToken: session.access_token }));
    return await resolveAuthUser(user, session.access_token);
  } catch {
    return null;
  }
}
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin),
      host = req.headers['x-forwarded-host'] || req.headers.host;
    return u.host === host;
  } catch {
    return false;
  }
}
// Probe the Supabase pieces the sign-in flow depends on, so a broken deployment says which
// layer failed instead of a generic "storage is not ready". Cached for 15s; booleans only.
let supabaseHealthCache = { at: 0, value: null };
async function probeSupabase(path, headers) {
  try {
    const response = await fetch(`${SUPABASE_URL}${path}`, {
      headers,
      signal: AbortSignal.timeout(2500),
    });
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
async function supabaseHealth({ force = false } = {}) {
  if (!supabaseConfigured || !supabaseBaseValid) return null;
  if (!force && supabaseHealthCache.value && Date.now() - supabaseHealthCache.at < 15000)
    return supabaseHealthCache.value;
  const [settings, stateRow, adminUsers] = await Promise.all([
    probeSupabase('/auth/v1/settings', { apikey: SUPABASE_ANON_KEY }),
    probeSupabase('/rest/v1/dispatch_state?select=id&id=eq.1', cloudHeaders()),
    probeSupabase('/auth/v1/admin/users?page=1&per_page=1', cloudHeaders()),
  ]);
  const value = {
    auth: settings.ok,
    database: stateRow.ok,
    serviceRole: adminUsers.ok,
    stateRow: stateRow.ok && Array.isArray(stateRow.data) && stateRow.data.length > 0,
    unitSchema: unitSchemaReady,
    signupDisabled: settings.ok ? settings.data?.disable_signup !== false : null,
  };
  supabaseHealthCache = { at: Date.now(), value };
  return value;
}
function startupMessage(checks) {
  if (!supabaseConfigured || !supabaseBaseValid)
    return 'Server credentials are missing or the Supabase URL is invalid. Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.';
  if (checks && !checks.auth)
    return 'Supabase Auth is unreachable from the server. Check the project URL, the anon key, and that the Supabase project is not paused.';
  if (checks && !checks.database)
    return 'The Supabase database rejected the server request. Check the service-role key and that the project is not paused.';
  if (checks && !checks.serviceRole)
    return 'The service-role key was rejected. SUPABASE_SERVICE_ROLE_KEY must be the service_role secret key, not the anon key.';
  if (checks && !checks.stateRow)
    return 'The dispatch_state row is missing. Run supabase/schema.sql in the Supabase SQL editor.';
  if (!unitSchemaReady)
    return 'The unit tables are missing. Run the current supabase/schema.sql in the Supabase SQL editor.';
  if (checks?.signupDisabled === false)
    return 'Public sign-up is enabled in Supabase Auth. Disable "Allow new users to sign up" in Authentication → Providers → Email.';
  if (!cloudReady) return cloudInitError || 'Supabase storage is not ready. Check the database schema and connection.';
  return null;
}

// Behind Vercel or a trusted proxy every request shares the proxy's socket address, so keying
// the limiter on remoteAddress locks all operators out after 12 failures. Use the forwarded
// client IP there, and the socket address everywhere else so it cannot be spoofed.
function clientKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const trustedProxy = IS_VERCEL || String(process.env.DISPATCH_TRUST_PROXY || '').toLowerCase() === 'true';
  if (trustedProxy && typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function loginFailure(error) {
  const code = String(error.data?.error_code || error.data?.error || '').toLowerCase();
  if (error.status === 429)
    return { status: 429, message: 'Too many sign-in attempts. Wait 15 minutes and try again.' };
  if (code.includes('email_not_confirmed'))
    return {
      status: 403,
      message:
        'This email address is not confirmed. Confirm it in Supabase → Authentication → Users, then sign in again.',
    };
  if (error.status === 400 || error.status === 401 || code.includes('invalid'))
    return { status: 401, message: 'Email or password is incorrect.' };
  return { status: 503, message: 'Supabase Auth did not respond. Check the project URL and keys.' };
}
function loginRateLimited(req) {
  const key = clientKey(req),
    entry = loginAttempts.get(key) || { count: 0, reset: Date.now() + 15 * 60 * 1000 };
  if (entry.reset < Date.now()) {
    entry.count = 0;
    entry.reset = Date.now() + 15 * 60 * 1000;
  }
  entry.count++;
  loginAttempts.set(key, entry);
  return entry.count > 12;
}
async function handleAuthApi(req, res, url) {
  if (url.pathname === '/api/auth/status' && req.method === 'GET') {
    const checks = await supabaseHealth({ force: url.searchParams.get('refresh') === '1' });
    return send(
      res,
      200,
      JSON.stringify({
        configured: supabaseConfigured && supabaseBaseValid,
        ready: cloudReady,
        unitSchemaReady,
        checks,
        message: startupMessage(checks),
      }),
      'application/json; charset=utf-8',
    );
  }
  if (!originAllowed(req))
    return send(res, 403, JSON.stringify({ error: 'Request origin rejected' }), 'application/json; charset=utf-8');
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const host = String(req.headers.host || '').split(':')[0];
    const localHost =
      ['localhost', '127.0.0.1', '::1'].includes(host) ||
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (
      String(process.env.DISPATCH_COOKIE_SECURE || 'true').toLowerCase() !== 'false' &&
      !requestIsHttps(req) &&
      !localHost
    )
      return send(
        res,
        426,
        JSON.stringify({
          error: 'HTTPS is required for sign-in. Use a trusted TLS reverse proxy or local development on localhost.',
        }),
        'application/json; charset=utf-8',
      );
    if (loginRateLimited(req))
      return send(
        res,
        429,
        JSON.stringify({ error: 'Too many sign-in attempts. Wait 15 minutes and try again.' }),
        'application/json; charset=utf-8',
      );
    if (!supabaseConfigured || !supabaseBaseValid || !cloudReady)
      return send(
        res,
        503,
        JSON.stringify({ error: 'Supabase authentication and storage are not ready.' }),
        'application/json; charset=utf-8',
      );
    try {
      const b = await readBody(req),
        email = String(b.email || '')
          .trim()
          .toLowerCase(),
        password = String(b.password || '');
      if (!email || !password) throw Object.assign(new Error('Enter your email and password.'), { status: 400 });
      const session = await supabaseAuth('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: { email, password },
      });
      if (!session.access_token || !session.refresh_token)
        throw Object.assign(new Error('Sign-in failed.'), { status: 401 });
      const user = await resolveAuthUser(session.user, session.access_token);
      writeSessionCookies(req, res, session);
      loginAttempts.delete(clientKey(req));
      return send(
        res,
        200,
        JSON.stringify({ ok: true, user: publicAuthUser(user) }),
        'application/json; charset=utf-8',
      );
    } catch (error) {
      const failure = error.data ? loginFailure(error) : { status: error.status || 500, message: error.message };
      return send(res, failure.status, JSON.stringify({ error: failure.message }), 'application/json; charset=utf-8');
    }
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const cookies = parseCookies(req);
    try {
      if (cookies.dispatch_access) {
        authCache.delete(crypto.createHash('sha256').update(cookies.dispatch_access).digest('hex'));
        await supabaseAuth('/auth/v1/logout', { method: 'POST', accessToken: cookies.dispatch_access });
      }
    } catch {}
    clearSessionCookies(req, res);
    return send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
  }
  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    const user = await currentUser(req, res);
    return user
      ? send(res, 200, JSON.stringify({ user: publicAuthUser(user) }), 'application/json; charset=utf-8')
      : send(
          res,
          401,
          JSON.stringify({ error: 'Sign in required or field assignment missing' }),
          'application/json; charset=utf-8',
        );
  }
  if (url.pathname === '/api/auth/password' && req.method === 'POST') {
    const actor = await currentUser(req, res);
    if (!actor) return send(res, 401, JSON.stringify({ error: 'Sign in required' }), 'application/json; charset=utf-8');
    try {
      const b = await readBody(req),
        currentPassword = String(b.currentPassword || ''),
        newPassword = String(b.newPassword || '');
      if (newPassword.length < 14)
        throw Object.assign(new Error('Choose a password with at least 14 characters'), { status: 400 });
      if (newPassword === currentPassword)
        throw Object.assign(new Error('Choose a different password'), { status: 400 });
      let session;
      try {
        session = await supabaseAuth('/auth/v1/token?grant_type=password', {
          method: 'POST',
          body: { email: actor.email, password: currentPassword },
        });
      } catch {
        throw Object.assign(new Error('Current password is incorrect'), { status: 400 });
      }
      await supabaseAuth('/auth/v1/user', {
        method: 'PUT',
        accessToken: session.access_token,
        body: { password: newPassword },
      });
      writeSessionCookies(req, res, session);
      return send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
    } catch (error) {
      return send(
        res,
        error.status || 400,
        JSON.stringify({ error: error.message || 'Could not change password' }),
        'application/json; charset=utf-8',
      );
    }
  }
  if (
    url.pathname === '/api/auth/users' &&
    (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE')
  ) {
    const actor = await currentUser(req, res);
    if (!actor) return send(res, 401, JSON.stringify({ error: 'Sign in required' }), 'application/json; charset=utf-8');
    if (actor.role !== 'operator')
      return send(res, 403, JSON.stringify({ error: 'Operator account required' }), 'application/json; charset=utf-8');
    if (!cloudReady)
      return send(
        res,
        503,
        JSON.stringify({ error: 'Supabase storage is not ready' }),
        'application/json; charset=utf-8',
      );
    try {
      if (req.method === 'GET') {
        const [result, accounts] = await Promise.all([
          cloudRequest('/auth/v1/admin/users?page=1&per_page=100'),
          unitSchemaReady
            ? cloudRequest('/rest/v1/dispatch_unit_accounts?select=user_id,officer_id')
            : Promise.resolve([]),
        ]);
        const mappings = new Map((accounts || []).map((account) => [account.user_id, account.officer_id]));
        const users = (result.users || []).map((user) => {
          const safe = safeAuthUser(user),
            officerId = mappings.get(user.id) || null,
            officer = officerId && state.officers.find((x) => x.id === officerId);
          return { ...safe, ...(officerId ? { officerId, unit: officer?.callSign || officerId } : {}) };
        });
        return send(res, 200, JSON.stringify({ users }), 'application/json; charset=utf-8');
      }
      if (req.method === 'DELETE') {
        if (!unitSchemaReady)
          return send(
            res,
            503,
            JSON.stringify({ error: 'Run the current Supabase schema before managing unit logins' }),
            'application/json; charset=utf-8',
          );
        const b = await readBody(req),
          userId = String(b.userId || '');
        if (!/^[0-9a-f-]{36}$/i.test(userId)) throw Object.assign(new Error('Choose a valid account'), { status: 400 });
        const account = await cloudRequest(
          `/rest/v1/dispatch_unit_accounts?select=officer_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
        );
        if (!account?.length)
          throw Object.assign(new Error('Only a field-unit login can be removed here'), { status: 409 });
        await cloudRequest(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
        audit('Field unit login removed', account[0].officer_id, actor.email);
        await save();
        return send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
      }
      const b = await readBody(req),
        email = String(b.email || '')
          .trim()
          .toLowerCase(),
        password = String(b.password || ''),
        name = String(b.name || '')
          .trim()
          .slice(0, 100),
        role = b.role === 'field' ? 'field' : 'operator',
        officerId = String(b.officerId || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw Object.assign(new Error('Enter a valid email address'), { status: 400 });
      if (password.length < 14)
        throw Object.assign(new Error('Use a temporary password of at least 14 characters'), { status: 400 });
      if (role === 'field') {
        if (!unitSchemaReady)
          throw Object.assign(new Error('Run the current Supabase schema before creating unit logins'), {
            status: 503,
          });
        if (!state.officers.some((officer) => officer.id === officerId))
          throw Object.assign(new Error('Choose a unit before creating its login'), { status: 400 });
        const existing = await cloudRequest(
          `/rest/v1/dispatch_unit_accounts?select=user_id&officer_id=eq.${encodeURIComponent(officerId)}&limit=1`,
        );
        if (existing?.length) throw Object.assign(new Error('This unit already has a login account'), { status: 409 });
      }
      const created = await cloudRequest('/auth/v1/admin/users', {
          method: 'POST',
          body: {
            email,
            password,
            email_confirm: true,
            user_metadata: { full_name: name },
            app_metadata: role === 'field' ? { dispatch_role: 'field' } : { dispatch_role: 'operator' },
          },
        }),
        createdUser = created.user || created;
      try {
        if (role === 'field')
          await cloudRequest('/rest/v1/dispatch_unit_accounts', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ user_id: createdUser.id, officer_id: officerId, created_by: actor.id }),
          });
      } catch (error) {
        try {
          await cloudRequest(`/auth/v1/admin/users/${encodeURIComponent(createdUser.id)}`, { method: 'DELETE' });
        } catch {}
        throw error;
      }
      audit(
        role === 'field' ? 'Field unit login created' : 'Operator account created',
        role === 'field'
          ? `${email} · ${state.officers.find((x) => x.id === officerId)?.callSign || officerId}`
          : email,
        actor.email,
      );
      await save();
      const user = safeAuthUser(createdUser);
      return send(
        res,
        201,
        JSON.stringify({
          ok: true,
          user: {
            ...user,
            ...(role === 'field'
              ? { officerId, unit: state.officers.find((x) => x.id === officerId)?.callSign || officerId }
              : {}),
          },
        }),
        'application/json; charset=utf-8',
      );
    } catch (error) {
      const status =
        error.status === 400 ? 400 : error.status === 409 ? 409 : error.status === 422 ? 409 : error.status || 500;
      return send(
        res,
        status,
        JSON.stringify({
          error:
            error.status === 400 || error.status === 409
              ? error.message
              : error.status === 422
                ? 'An account with that email may already exist'
                : error.message?.includes('dispatch_unit_accounts')
                  ? 'Run the current Supabase schema before creating unit logins'
                  : 'Could not complete user management request',
        }),
        'application/json; charset=utf-8',
      );
    }
  }

  return null;
}

// Background rules: one-hour assignment warning and stale/offline state. Server timestamps are authoritative.
let autoBackupInProgress = false,
  autoBackupRetryAt = 0;
async function runMaintenance() {
  let dirty = false;
  const ms = Date.now();
  for (const o of state.officers) {
    if (o.online && o.lastSeen && ms - Date.parse(o.lastSeen) > Number(state.settings.offlineMinutes || 5) * 60000) {
      o.online = false;
      raiseAlert('offline', 'Terminal offline', `${o.callSign} · last seen ${o.lastSeen}`, o, null);
      for (const a of state.alerts.filter((x) => x.type === 'sos' && x.officerId === o.id && x.status !== 'handled')) {
        a.offline = true;
        a.sosSnapshot = { ...(a.sosSnapshot || {}), offline: true, online: false };
      }
      dirty = true;
    }
    if (
      o.shiftId &&
      o.status === 'en-route' &&
      o.clockedInAt &&
      ms - Date.parse(o.clockedInAt) > Number(state.settings.absenceMinutes || 60) * 60000
    ) {
      const before = state.alerts.length;
      raiseAbsence(o, state.sites.find((s) => s.id === o.siteId) || {});
      dirty ||= state.alerts.length !== before;
    }
  }
  for (const m of state.messages) {
    const recipient = state.officers.find((x) => x.id === m.to),
      groupOnline = m.to === 'all' && m.group && state.officers.some((x) => x.group === m.group && x.online);
    if (!m.deliveredAt && (recipient?.online || groupOnline)) {
      m.deliveredAt = now();
      dirty = true;
    }
  }
  const pending = state.scheduledMessages.filter((m) => m.scheduledAt && Date.parse(m.scheduledAt) <= ms);
  if (pending.length) {
    for (const m of pending) {
      const recipient = state.officers.find((x) => x.id === m.to),
        groupOnline = m.to === 'all' && m.group && state.officers.some((x) => x.group === m.group && x.online),
        delivered =
          m.to === 'all' ? !m.group || Boolean(groupOnline) || Boolean(recipient?.online) : Boolean(recipient?.online);
      m.deliveredAt = delivered ? now() : null;
      state.messages.unshift(m);
    }
    state.scheduledMessages = state.scheduledMessages.filter((m) => !pending.includes(m));
    dirty = true;
  }
  for (const a of state.alerts.filter(
    (x) =>
      x.type === 'sos' &&
      x.status === 'raised' &&
      !x.escalated &&
      ms - Date.parse(x.raisedAt) > Number(state.settings.sosEscalationMinutes || 2) * 60000,
  )) {
    a.escalated = true;
    a.events.push({ status: 'escalated', at: now(), by: 'System' });
    dirty = true;
  }
  for (const c of state.calls.filter((x) => x.live && x.status === 'ringing' && ms - Date.parse(x.startedAt) > 90000)) {
    c.status = 'failed';
    c.endedAt = now();
    c.failure = 'No endpoint answered';
    dirty = true;
  }
  const cutoff = ms - Math.max(1, Number(state.settings.retentionDays || 90)) * 86400000;
  for (const o of state.officers) {
    const before = (o.history || []).length;
    o.history = (o.history || []).filter((p) => Date.parse(p.receivedAt) >= cutoff);
    if (before !== o.history.length) {
      o.historyCount = o.history.length;
      o.latestHistoryAt = o.history.at(-1)?.receivedAt || null;
      o.historyTail = o.history.slice(-10);
      dirty = true;
    }
  }
  for (const key of ['messages', 'calls', 'recordings', 'alerts', 'traffic', 'emails'])
    if (Array.isArray(state[key])) {
      const before = state[key].length;
      state[key] = state[key].filter(
        (x) => Date.parse(x.createdAt || x.raisedAt || x.startedAt || x.at || now()) >= cutoff,
      );
      if (before !== state[key].length) dirty = true;
    }
  const lastAutoBackupAt = Date.parse(state.lastAutoBackup || '');
  if (
    IS_VERCEL &&
    !autoBackupInProgress &&
    ms >= autoBackupRetryAt &&
    (!Number.isFinite(lastAutoBackupAt) || ms - lastAutoBackupAt >= 3600000)
  ) {
    autoBackupInProgress = true;
    try {
      const backup = await makeBackup();
      state.lastAutoBackup = now();
      autoBackupRetryAt = 0;
      recordDiagnostic('backup.auto.succeeded', { file: backup.file, sizeBytes: backup.size });
      await save();
    } catch (error) {
      autoBackupRetryAt = Date.now() + 300000;
      recordDiagnostic('backup.auto.failed', { message: error.message, status: error.status || null }, 'error');
    } finally {
      autoBackupInProgress = false;
    }
  } else if (
    !IS_VERCEL &&
    !autoBackupInProgress &&
    ms >= autoBackupRetryAt &&
    (!Number.isFinite(lastAutoBackupAt) || ms - lastAutoBackupAt >= 3600000)
  ) {
    autoBackupInProgress = true;
    makeBackup()
      .then((backup) => {
        state.lastAutoBackup = now();
        autoBackupRetryAt = 0;
        recordDiagnostic('backup.auto.succeeded', { file: backup.file, sizeBytes: backup.size });
        console.log(`Hourly full-state backup created: ${backup.file} (${backup.size} bytes)`);
        save().catch((error) => {
          recordDiagnostic(
            'backup.auto.metadata-save-failed',
            { message: error.message, status: error.status || null },
            'error',
          );
          console.error('Could not persist automatic backup timestamp:', error.message);
        });
      })
      .catch((error) => {
        autoBackupRetryAt = Date.now() + 300000;
        recordDiagnostic('backup.auto.failed', { message: error.message, status: error.status || null }, 'error');
        console.error('Hourly full-state backup failed; retrying in five minutes:', error.message);
      })
      .finally(() => {
        autoBackupInProgress = false;
      });
  }
  if (unitSchemaReady) {
    const prunedAt = Date.parse(state.lastLocationPruneAt || '');
    if (!Number.isFinite(prunedAt) || ms - prunedAt >= 86400000) {
      const cutoff = new Date(ms - Math.max(1, Number(state.settings.retentionDays || 90)) * 86400000).toISOString(),
        pruned = await cloudRequest('/rest/v1/rpc/dispatch_prune_locations', {
          method: 'POST',
          body: JSON.stringify({ p_before: cutoff }),
        });
      for (const officer of state.officers) {
        const summary = pruned?.units?.[officer.id];
        officer.historyCount = Number(summary?.count || 0);
        officer.latestHistoryAt = summary?.latest || null;
        officer.historyTail = (officer.historyTail || [])
          .filter((point) => Date.parse(point.receivedAt) >= Date.parse(cutoff))
          .slice(-10);
      }
      state.lastLocationPruneAt = now();
      dirty = true;
    }
  }
  if (dirty) await save();
}
if (!IS_VERCEL) setInterval(() => runMaintenance().catch(() => {}), 5000).unref();
const PORT = Number(process.env.PORT || 3000);
const startServer = () =>
  server.listen(PORT, process.env.HOST || '0.0.0.0', () =>
    console.log(`Dispatch Control Room running locally at http://localhost:${PORT}`),
  );
const cloudInitialization =
  supabaseConfigured && supabaseBaseValid
    ? initializeCloud().then((ready) => {
        if (!ready && !IS_VERCEL) scheduleCloudRecovery();
        return ready;
      })
    : Promise.resolve(false);
if (IS_VERCEL) {
  async function processVercelRequest(req, res) {
    let lockToken = null;
    const requestUrl = new URL(req.url, 'http://localhost'),
      isApi = requestUrl.pathname.startsWith('/api/');
    try {
      const trafficTile = req.method === 'GET' && requestUrl.pathname.startsWith('/api/traffic/tiles/flow/');
      if (isApi && !trafficTile) {
        await cloudInitialization;
        if (supabaseConfigured && supabaseBaseValid && !cloudReady && Date.now() - cloudInitLastAttemptAt >= 30000)
          await initializeCloud();
        else if (cloudReady && !unitSchemaReady && Date.now() - unitSchemaLastCheckAt >= 30000) await checkUnitSchema();
      }
      const publicAuth = [
          '/api/auth/status',
          '/api/auth/login',
          '/api/auth/logout',
          '/api/auth/me',
          '/api/auth/password',
        ].includes(requestUrl.pathname),
        statelessRtc = requestUrl.pathname === '/api/rtc/poll' || requestUrl.pathname === '/api/rtc/signal',
        trafficTileRequest = req.method === 'GET' && requestUrl.pathname.startsWith('/api/traffic/tiles/flow/'),
        scopedFieldRead =
          req.method === 'GET' &&
          requestUrl.pathname === '/api/field/state' &&
          requestUrl.searchParams.get('scope') === 'unit',
        statePollRequest =
          (req.method === 'GET' && requestUrl.pathname === '/api/state') ||
          (req.method === 'GET' && requestUrl.pathname === '/api/field/state' && !scopedFieldRead),
        needsCloudState = isApi && !publicAuth && !statelessRtc && !trafficTileRequest && !scopedFieldRead;
      if (needsCloudState && cloudReady) {
        if (req.method === 'POST' && requestUrl.pathname !== '/api/rtc/signal') {
          lockToken = crypto.randomUUID();
          await acquireCloudStateLock(lockToken);
        }
        const since = statePollRequest ? requestUrl.searchParams.get('since') : null;
        if (statePollRequest && since && (await cloudStateUnchanged(since))) req.dispatchStateUnchanged = true;
        else {
          const snapshot = await refreshCloudState();
          if (statePollRequest) req.dispatchStateSnapshot = snapshot;
        }
        if (lockToken) {
          const lastMaintenanceAt = Date.parse(state.maintenanceAt || '');
          if (!Number.isFinite(lastMaintenanceAt) || Date.now() - lastMaintenanceAt >= 5000) {
            state.maintenanceAt = now();
            await runMaintenance();
            await save();
          }
        }
      }
      await requestListener(req, res);
      if (needsCloudState && req.method !== 'GET') await cloudWriteQueue;
    } catch (error) {
      recordDiagnostic(
        'vercel.function.failed',
        {
          method: req.method,
          path: String(req.url || '').slice(0, 180),
          status: error.status || null,
          message: error.message,
        },
        'error',
      );
      if (!res.headersSent)
        send(
          res,
          error.status || 503,
          JSON.stringify({ error: error.status === 503 ? error.message : 'Dispatch request failed' }),
          'application/json; charset=utf-8',
        );
      else if (!res.writableEnded) res.end();
    } finally {
      if (lockToken) await releaseCloudStateLock(lockToken);
    }
  }
  module.exports = function vercelHandler(req, res) {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!pathname.startsWith('/api/')) return processVercelRequest(req, res);
    const independentRead =
      (req.method === 'GET' && pathname.startsWith('/api/traffic/tiles/flow/')) ||
      (req.method === 'GET' && pathname === '/api/state') ||
      (req.method === 'GET' &&
        pathname === '/api/field/state' &&
        new URL(req.url, 'http://localhost').searchParams.get('scope') === 'unit') ||
      pathname === '/api/rtc/poll' ||
      pathname === '/api/rtc/signal';
    if (independentRead) return processVercelRequest(req, res);
    const task = vercelRequestQueue.then(() => processVercelRequest(req, res));
    vercelRequestQueue = task.catch(() => {});
    return task;
  };
} else cloudInitialization.finally(startServer);
