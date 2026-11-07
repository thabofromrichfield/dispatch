const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
let MAPLIBRE_3D_SUPPORTED = false,
  mapLibreLoadPromise = null;
function loadOptionalMapLibre() {
  if (window.maplibregl) {
    MAPLIBRE_3D_SUPPORTED = (() => {
      try {
        return Boolean(window.maplibregl.supported?.({ failIfMajorPerformanceCaveat: false }));
      } catch {
        return false;
      }
    })();
    return MAPLIBRE_3D_SUPPORTED
      ? Promise.resolve(true)
      : Promise.reject(new Error('WebGL is unavailable on this device'));
  }
  if (mapLibreLoadPromise) return mapLibreLoadPromise;
  mapLibreLoadPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-maplibre-style]')) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/vendor/maplibre/maplibre-gl.css?v=5.6.2';
      css.dataset.maplibreStyle = 'true';
      document.head.append(css);
    }
    const script = document.createElement('script');
    script.src = '/vendor/maplibre/maplibre-gl.js?v=5.6.2';
    script.async = true;
    script.onload = () => {
      MAPLIBRE_3D_SUPPORTED = (() => {
        try {
          return Boolean(window.maplibregl?.supported?.({ failIfMajorPerformanceCaveat: false }));
        } catch {
          return false;
        }
      })();
      if (MAPLIBRE_3D_SUPPORTED) resolve(true);
      else reject(new Error('WebGL is unavailable on this device'));
    };
    script.onerror = () => {
      mapLibreLoadPromise = null;
      reject(new Error('3D map renderer could not be downloaded'));
    };
    document.head.append(script);
  });
  return mapLibreLoadPromise;
}
let S = null,
  currentUser = null,
  uiMounted = false,
  pageRenderSignatures = {},
  fieldGpsLifecycleKey = '',
  selectedMapOfficerId = null,
  map = null,
  mapLibre = null,
  mapMode = '2d',
  mapStyle = 'street',
  mapLibreReady = false,
  map3dView = null,
  mapTransition = null,
  mapSwitchTimer = null,
  mapTransitionTarget = { pitch: 58, bearing: -18 },
  mapLibreMarkers = new Map(),
  mapLibreDataSignatures = { units: '', sites: '' },
  markerLayer = null,
  siteLayer = null,
  sitePolygonLayer = null,
  leafletOfficerMarkers = new Map(),
  leafletSitePolygons = new Map(),
  leafletSosMarkers = new Map(),
  siteMap = null,
  reviewMap = null,
  trafficLayer = null,
  trafficOn = false,
  measureMode = false,
  measurePoints = [],
  measurements = [],
  editingMeasureId = null,
  measureLayer = null,
  mapLibreMeasureMarkers = new Map(),
  currentPage = 'overview',
  drawPoints = [],
  drawMode = false,
  editingSiteId = null,
  editingZoneKind = 'site',
  editingSiteOriginal = null,
  editingSiteHandles = [],
  editingSiteLayer = null,
  editingZoneMap = null,
  editingZonePolygon = null,
  sitePagePolygons = new Map(),
  sitePageUnitMarkers = new Map(),
  alertSeen = new Set(),
  pollTimer = null,
  clockTimer = null,
  trafficTimer = null,
  gpsWatch = null,
  fieldId = null,
  replayTimer = null,
  replayStartIndex = 0,
  replayPointGroups = new Map(),
  replayTrafficGroups = new Map(),
  reviewTrailLayers = new Map(),
  reviewTrailCounts = new Map(),
  reviewLastReplayIndex = -1,
  soundEnabled = true,
  lastAlarmSound = 0,
  lastLocationPush = 0,
  currentReportRows = [],
  trafficStatusTimer = null,
  boundaryEditor = null,
  rtcPeerId = '',
  rtcPollTimer = null,
  rtcPollBusy = false,
  rtcRetryAt = 0,
  rtcFailureCount = 0,
  rtcSessions = new Map(),
  rtcPendingOffers = new Map(),
  rtcPendingIce = new Map(),
  pendingFieldCalls = new Map(),
  lastGpsErrorCode = 0,
  lastGpsErrorAt = 0;
const esc = (x) =>
  String(x ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const fmt = (x, opts = { hour: '2-digit', minute: '2-digit' }) =>
  x
    ? new Intl.DateTimeFormat('en-ZA', { ...opts, timeZone: S?.settings?.timezone || undefined }).format(new Date(x))
    : '—';
const dateKey = (x) => {
  if (!x) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: S?.settings?.timezone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(x));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
const ago = (x) => {
  if (!x) return '—';
  let m = Math.max(0, Math.floor((Date.now() - Date.parse(x)) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
};
const initials = (x) =>
  (x || '')
    .split(' ')
    .map((y) => y[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
const batteryPercent = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
};
const batteryLabel = (value) => {
  const percent = batteryPercent(value);
  return percent === null ? '—' : `${Math.round(percent)}%`;
};
const officer = (id) => S?.officers.find((x) => x.id === id),
  site = (id) => S?.sites.find((x) => x.id === id);
const trafficConfigured = (settings) => Boolean(settings?.trafficKey || settings?.trafficKeyConfigured);
function status(o) {
  if (o.stunned) return 'Stunned';
  if (!o.online && o.shiftId) return 'Offline';
  return (
    {
      'off-duty': 'Off duty',
      'en-route': 'En route',
      'on-site': 'On site',
      'left-site': 'Left site',
      'on-break': 'On break',
    }[o.status] || o.status
  );
}
function cls(o) {
  return status(o) === 'On site'
    ? ''
    : status(o) === 'En route'
      ? 'amber'
      : status(o) === 'Offline' || status(o) === 'Stunned'
        ? 'red'
        : 'grey';
}
async function api(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) };
  let status = 0,
    d = null;
  if (window.DispatchAPI?.request && String(url).startsWith('/api/')) {
    const native = await window.DispatchAPI.request(url, opts.method || 'GET', opts.body || '');
    status = Number(native?.status || 503);
    try {
      d = native?.body ? JSON.parse(native.body) : null;
    } catch {
      d = {};
    }
  } else {
    let r;
    try {
      r = await fetch(url, {
        credentials: 'same-origin',
        ...opts,
        headers,
        signal: opts.signal || AbortSignal.timeout(15000),
      });
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      const failure = new Error(timeout ? 'The server did not answer within 15 seconds.' : 'The server is unreachable.');
      failure.status = timeout ? 504 : 0;
      throw failure;
    }
    status = r.status;
    d = status === 304 ? null : await r.json().catch(() => ({}));
  }
  if (status === 401 && !url.startsWith('/api/auth/')) {
    showAuthGate('Your secure session ended. Sign in again to continue.');
    stopDashboardTimers();
  }
  if (status !== 304 && (status < 200 || status >= 300 || d?.ok === false)) {
    const error = new Error(d?.error || `Request failed: ${status}`);
    error.status = status;
    throw error;
  }
  return d;
}
function toast(text, error = false) {
  const n = document.createElement('div');
  n.className = 'toast' + (error ? ' error' : '');
  n.textContent = text;
  $('#toastRoot').append(n);
  setTimeout(() => n.remove(), 3300);
}
function say(t) {
  toast(
    {
      'clock-in': 'Shift started',
      'clock-out': 'Shift ended',
      sos: 'SOS alarm raised',
      'alert-status': 'Alert updated',
      message: 'Message sent',
      'site-save': 'Site saved',
      'site-delete': 'Site deleted',
      'officer-save': 'Officer saved',
      'officer-delete': 'Officer removed',
      stun: 'Terminal updated',
      location: 'Location updated',
      'call-start': 'Dispatch channel opened',
      'call-end': 'Call ended',
      settings: 'Settings saved',
      backup: 'Backup created',
      break: 'Break status updated',
      'status-query': 'Terminal status received',
      'region-save': 'Region saved',
      'region-delete': 'Region removed',
      'group-save': 'Group created',
      email: 'Email queued locally',
    }[t] || 'Saved',
  );
}
async function action(type, data = {}) {
  try {
    const d = await api('/api/action', { method: 'POST', body: JSON.stringify({ type, ...data }) });
    if (d.state) S = d.state;
    render();
    say(type);
    if (d.volatile)
      toast('Live voice is temporary while Supabase is unavailable; call history will sync after recovery.', true);
    return d.result;
  } catch (e) {
    toast(e.message, true);
    e.dispatchToastShown = true;
    throw e;
  }
}
function title(page) {
  return (
    {
      overview: 'Live operations',
      units: 'Units & people',
      sites: 'Sites & regions',
      messages: 'Messages',
      calls: 'Voice dispatch',
      recordings: 'Recordings',
      network: 'Network & devices',
      review: 'Day review',
      reports: 'Reports & exports',
      settings: 'System settings',
      field: 'Officer field app',
    }[page] || page
  );
}
function header(title, sub, button = '', action = '') {
  return `<section class="page-head workspace-page"><div><div class="eyebrow">DISPATCH CONSOLE <span class="live-pill"><i></i> SECURE</span></div><h1>${title}</h1><p>${sub}</p></div>${button ? `<div class="head-actions"><button class="button primary" data-action="${action}">${button}</button></div>` : ''}</section>`;
}
function pageDataSignature(page) {
  if (!S) return '';
  const officerLive = (o) => [
    o.id,
    o.name,
    o.callSign,
    o.group,
    o.shiftId,
    o.siteId,
    o.status,
    o.stunned,
    o.online,
    o.lastSeen,
    o.lat,
    o.lng,
    o.accuracy,
    o.battery,
    o.signal,
    o.color,
  ];
  const latestTrafficReading = trafficLog.at(-1);
  const trafficMeta = [
    trafficLog.length,
    latestTrafficReading?.id,
    latestTrafficReading?.at,
    latestTrafficReading?.level,
    latestTrafficReading?.currentSpeed,
  ];
  switch (page) {
    case 'overview':
      return JSON.stringify([
        S.officers.map(officerLive),
        S.sites.map((x) => [x.id, x.name, x.areaType, x.coordinates, x.color]),
        S.regions.map((x) => [x.id, x.name, x.areaType, x.coordinates, x.color]),
        S.alerts.map((x) => [
          x.id,
          x.type,
          x.title,
          x.detail,
          x.officerId,
          x.siteId,
          x.lat,
          x.lng,
          x.raisedAt,
          x.status,
        ]),
        trafficMeta,
        S.settings.trafficEnabled,
        S.settings.mapProvider,
        mapStyle,
        mapMode,
        trafficOn,
      ]);
    case 'units':
      return JSON.stringify([S.officers.map(officerLive), S.sites.map((x) => [x.id, x.name]), S.groups]);
    case 'sites':
      return JSON.stringify([
        S.sites.map((x) => [x.id, x.name, x.areaType, x.coordinates, x.color, x.assigned, x.tolerance]),
        S.regions.map((x) => [x.id, x.name, x.areaType, x.coordinates, x.color, x.assigned]),
        S.officers.filter((x) => x.shiftId).map(officerLive),
      ]);
    case 'messages':
      return JSON.stringify([
        S.messages.map((x) => [
          x.id,
          x.from,
          x.to,
          x.group,
          x.body,
          x.createdAt,
          x.deliveredAt,
          x.readAt,
          x.scheduledAt,
        ]),
        S.officers.map((x) => [x.id, x.callSign]),
      ]);
    case 'calls':
      return JSON.stringify([
        S.calls.map((x) => [x.id, x.type, x.from, x.to, x.startedAt, x.endedAt, x.status]),
        S.callPatches,
      ]);
    case 'recordings':
      return JSON.stringify(
        S.recordings.map((x) => [
          x.id,
          x.name,
          x.callId,
          x.mime,
          x.createdAt,
          x.duration,
          x.from,
          x.to,
          Boolean(x.hasData),
        ]),
      );
    case 'network':
      return JSON.stringify([
        S.officers.map(officerLive),
        S.relays,
      ]);
    case 'reports': {
      const type = $('#reportType')?.value || 'officers',
        history = S.officers.map((x) => [x.id, x.historyCount || 0, x.latestHistoryAt]);
      return JSON.stringify([
        type,
        S.officers.map(officerLive),
        history,
        S.alerts.map((x) => [x.id, x.status, x.raisedAt]),
        S.messages.map((x) => [x.id, x.createdAt, x.deliveredAt]),
        S.calls.map((x) => [x.id, x.status, x.startedAt]),
        S.sites.map((x) => [x.id, x.name, x.coordinates]),
        trafficMeta,
        S.audit.length,
        S.audit[0]?.id,
      ]);
    }
    case 'field': {
      const f = officer(fieldId);
      return JSON.stringify([
        f && officerLive(f),
        f?.config,
        S.settings.locationInterval,
        S.officers.map((x) => [x.id, x.callSign, x.name]),
        S.messages
          .filter((x) => x.to === fieldId || (x.to === 'all' && (!x.group || x.group === f?.group)))
          .map((x) => [x.id, x.body, x.createdAt, x.deliveredAt, x.readAt]),
        pendingEvents().length,
      ]);
    }
    default:
      return null;
  }
}
function refreshVisiblePage() {
  const signature = pageDataSignature(currentPage);
  if (signature === null || pageRenderSignatures[currentPage] === signature) return;
  pageRenderSignatures[currentPage] = signature;
  switch (currentPage) {
    case 'overview':
      renderOverview();
      break;
    case 'units':
      renderUnits();
      break;
    case 'sites':
      renderSites();
      break;
    case 'messages':
      renderMessages();
      break;
    case 'calls':
      renderCalls();
      break;
    case 'recordings':
      renderRecordings();
      break;
    case 'network':
      renderNetwork();
      break;
    case 'reports':
      renderReports();
      break;
    case 'field':
      refreshFieldPage();
      break;
  }
}
function render(rebuildPage = false) {
  if (!S) return;
  $('#clock').textContent = fmt(Date.now(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('#crumbPage').textContent = title(currentPage);
  $$('.nav-item').forEach((x) => x.classList.toggle('active', x.dataset.page === currentPage));
  $$('.top-tab').forEach((x) => x.classList.toggle('active', x.dataset.page === currentPage));
  $('#navAlerts').textContent = S.alerts.filter((a) => a.status !== 'handled').length;
  if (!uiMounted) {
    uiMounted = true;
    renderPage();
  } else if (rebuildPage) renderPage();
  else refreshVisiblePage();
  syncTrafficButton();
  updateTrafficSummary();
  checkSOS();
}
function renderPage() {
  const root = $('#pageContent');
  $('.app-shell')?.classList.toggle('map-first', currentPage === 'overview');
  $('.app-shell')?.classList.toggle('field-screen', currentPage === 'field');
  if (editingSiteLayer) editingSiteLayer.remove();
  editingSiteLayer = null;
  editingZoneMap = null;
  editingZonePolygon = null;
  editingSiteId = null;
  editingZoneKind = 'site';
  editingSiteOriginal = null;
  editingSiteHandles = [];
  if (currentPage !== 'review') stopReplay();
  if (map) {
    map.remove();
    map = null;
    markerLayer = siteLayer = sitePolygonLayer = trafficLayer = measureLayer = null;
    leafletOfficerMarkers = new Map();
    leafletSitePolygons = new Map();
    leafletSosMarkers = new Map();
  }
  if (mapLibre) {
    clearMapLibreMeasurementMarkers();
    mapLibre.remove();
    mapLibre = null;
    mapLibreReady = false;
    mapLibreMarkers = new Map();
    mapLibreDataSignatures = { units: '', sites: '' };
  }
  if (siteMap) {
    siteMap.remove();
    siteMap = null;
    sitePagePolygons = new Map();
    sitePageUnitMarkers = new Map();
  }
  if (reviewMap) {
    reviewMap.remove();
    reviewMap = null;
  }
  if (currentPage === 'overview') {
    root.innerHTML = overviewHtml();
    renderOverview();
  } else if (currentPage === 'units') {
    root.innerHTML = unitsHtml();
    renderUnits();
  } else if (currentPage === 'sites') {
    root.innerHTML = sitesHtml();
    renderSites();
  } else if (currentPage === 'messages') {
    root.innerHTML = messagesHtml();
    renderMessages();
  } else if (currentPage === 'calls') {
    root.innerHTML = callsHtml();
    renderCalls();
  } else if (currentPage === 'recordings') {
    root.innerHTML = recordingsHtml();
    renderRecordings();
  } else if (currentPage === 'network') {
    root.innerHTML = networkHtml();
    renderNetwork();
  } else if (currentPage === 'review') {
    root.innerHTML = reviewHtml();
    renderReview();
  } else if (currentPage === 'reports') {
    root.innerHTML = reportsHtml();
    renderReports();
  } else if (currentPage === 'settings') {
    root.innerHTML = settingsHtml();
    renderBackups();
    renderUsers();
  } else if (currentPage === 'field') {
    root.innerHTML = fieldHtml();
    renderField();
  }
  pageRenderSignatures[currentPage] = pageDataSignature(currentPage);
  setTimeout(() => {
    map?.invalidateSize();
    mapLibre?.resize();
    siteMap?.invalidateSize();
    reviewMap?.invalidateSize();
  }, 80);
}
function go(page) {
  currentPage = page;
  $('#sidebar').classList.remove('open');
  render(true);
  rtcHeartbeat();
}
function overviewHtml() {
  return `<section class="map-panel panel dashboard-map"><div class="panel-heading map-heading"><div><div class="panel-title">Live operations map <span class="live-pill small"><i></i> LIVE</span></div><div class="panel-subtitle">Live unit locations · <span id="mapTime">Updated just now</span><span class="map-summary-sep">·</span><span id="mapUnitSummary">Loading units</span></div></div><div class="map-tools"><div class="map-mode-segment" aria-label="Map perspective"><button class="mode-button active" id="map2dBtn" data-action="map-2d">2D</button><button class="mode-button" id="map3dBtn" data-action="map-3d">Pitched 3D</button></div><button class="button small ghost" data-action="traffic"><span class="toggle-dot"></span> Traffic</button><details class="map-tools-more"><summary class="button small ghost">More <span aria-hidden="true">⌄</span></summary><div class="map-tools-menu"><div class="map-menu-label">MAP</div><select class="select map-style" id="mapStyleSelect" aria-label="Map style"><option value="street">Street map</option><option value="satellite">Satellite</option><option value="topo">Terrain</option></select><button class="button small ghost map-fit" data-action="fit">⌖ <span>Fit units</span></button><div class="map-menu-label">TOOLS</div><button class="button small ghost" data-action="locate-me">◎ <span>Locate me</span></button><button class="button small ghost" data-action="measure">↔ <span>Measure distance</span></button><button class="button small ghost" data-action="fullscreen">⛶ <span>Full screen</span></button><button class="button small ghost" data-action="draw-site">＋ <span>Draw a site</span></button></div></details></div></div><div class="map-wrap"><div id="map"></div><div id="map3d" class="hidden"></div><div class="map-zoom-controls" role="group" aria-label="Map zoom controls"><button type="button" data-action="zoom-in" aria-label="Zoom in" title="Zoom in">+</button><button type="button" data-action="zoom-out" aria-label="Zoom out" title="Zoom out">−</button></div><div id="mapCoordinates" class="map-coordinates">LAT — · LNG —</div><div id="measurePanel" class="measure-panel hidden" aria-live="polite"></div><details class="map-info-drawer" id="mapInfoDrawer"><summary><span>Map key & traffic</span><b>＋</b></summary><div class="map-info-content"><div id="trafficSummary" class="traffic-summary"></div><div class="map-legend"><div><span class="legend-dot green"></span> On site <span class="legend-dot amber"></span> En route <span class="legend-dot grey"></span> Off duty</div><div class="traffic-legend"><span class="road green-road"></span> Free flow <span class="road orange-road"></span> Slow <span class="road red-road"></span> Heavy</div></div><div id="trafficNotice" class="map-notice">Traffic key required · configure in Settings</div></div></details><div class="draw-hint hidden" id="drawHint">Click map to add points <button data-action="finish-draw">Finish</button><button data-action="cancel-draw">Cancel</button></div><div id="mapUnitCard" class="map-unit-card hidden"></div><details class="map-fleet-dock" id="mapFleetDock"><summary><span class="fleet-dock-pulse"></span><b>Active units</b><span id="fleetDockCount" class="tag green">0</span><span class="fleet-dock-hint">Quick locate</span><span class="fleet-dock-chevron">⌃</span></summary><div id="fleetDockList" class="fleet-dock-list"></div></details></div></section><section class="dashboard-foldouts" aria-label="Additional live operations"><details class="dashboard-foldout"><summary><span class="foldout-name">Needs attention</span><span id="alertCount" class="count-badge">0</span><span class="foldout-hint" id="alertSummary">No unresolved alerts</span><span class="foldout-chevron">＋</span></summary><div class="foldout-body"><div id="alertList" class="alert-list"></div><div class="panel-footer"><span class="foot-indicator"></span> SOS alarms always break through filters <button class="text-button" data-page-link="reports">View alert log</button></div></div></details><details class="dashboard-foldout"><summary><span class="foldout-name">Units on the ground</span><span id="unitCount" class="count-badge pale">0 active</span><span class="foldout-hint">Select a unit to locate it</span><span class="foldout-chevron">＋</span></summary><div class="foldout-body"><div id="unitList" class="unit-list"></div><button class="panel-link" data-page-link="units">View all officers <span>→</span></button></div></details></section>`;
}
function mapUnitColor(o) {
  return !o.shiftId
    ? '#94a3b8'
    : o.stunned
      ? '#fb7185'
      : o.status === 'on-site'
        ? '#34d399'
        : o.status === 'left-site'
          ? '#fb7185'
          : '#fbbf24';
}
function renderMapUnitHud() {
  const dock = $('#fleetDockList'),
    count = $('#fleetDockCount'),
    card = $('#mapUnitCard');
  if (!dock || !card) return;
  const active = S.officers.filter((o) => o.shiftId),
    countText = String(active.length);
  if (count.textContent !== countText) count.textContent = countText;
  const dockHtml = active.length
    ? active
        .map(
          (o) =>
            `<button class="fleet-dock-unit ${selectedMapOfficerId === o.id ? 'selected' : ''}" data-action="select-map-unit" data-id="${esc(o.id)}"><span class="fleet-unit-dot" style="--unit-color:${mapUnitColor(o)}"></span><span class="fleet-unit-copy"><b>${esc(o.callSign)}</b><small>${esc(site(o.siteId)?.name || 'Unassigned')}</small></span><span class="fleet-unit-battery">${batteryLabel(o.battery)}</span></button>`,
        )
        .join('')
    : '<div class="fleet-dock-empty">No active shifts</div>';
  if (dock.dataset.renderKey !== dockHtml) {
    dock.innerHTML = dockHtml;
    dock.dataset.renderKey = dockHtml;
  }
  const unit = officer(selectedMapOfficerId);
  if (!unit) {
    card.classList.add('hidden');
    if (card.innerHTML) {
      card.innerHTML = '';
      card.dataset.renderKey = '';
    }
    return;
  }
  const battery = batteryPercent(unit.battery),
    coords =
      Number.isFinite(unit.lat) && Number.isFinite(unit.lng)
        ? `${Number(unit.lat).toFixed(5)}, ${Number(unit.lng).toFixed(5)}`
        : 'No GPS fix',
    unitSite = site(unit.siteId)?.name || 'Unassigned',
    accuracy = Number.isFinite(Number(unit.accuracy)) ? `±${Math.round(Number(unit.accuracy))} m` : '—',
    signalText = unit.online ? 'Connected' : 'Last seen ' + ago(unit.lastSeen),
    signature = JSON.stringify([
      unit.id,
      unit.callSign,
      unit.name,
      status(unit),
      unitSite,
      battery,
      unit.signal,
      signalText,
      accuracy,
      mapUnitColor(unit),
    ]);
  if (card.dataset.renderKey !== signature) {
    card.innerHTML = `<div class="map-unit-head"><span class="map-unit-status" style="--unit-color:${mapUnitColor(unit)}"></span><div class="map-unit-title"><b>${esc(unit.callSign)} · ${esc(unit.name)}</b><small>${esc(status(unit))} · ${esc(unitSite)}</small></div><button class="map-unit-close" data-action="close-map-unit" aria-label="Close unit details">×</button></div><div class="map-unit-metrics"><div class="map-unit-metric"><small>Battery</small><b>${battery === null ? '—' : `${Math.round(battery)}%`}</b>${battery === null ? '' : `<span class="map-unit-battery-track"><i style="width:${battery}%"></i></span>`}</div><div class="map-unit-metric"><small>Signal</small><b>${esc(unit.signal ?? '—')}</b><span>${esc(signalText)}</span></div><div class="map-unit-metric"><small>GPS accuracy</small><b>${accuracy}</b><span class="map-unit-coordinate">${esc(coords)}</span></div></div><div class="map-unit-actions"><button class="button small ghost" onclick="window.quickMessage('${esc(unit.id)}')">Message</button><button class="button small primary" data-action="focus-unit" data-id="${esc(unit.id)}">Locate unit</button></div>`;
    card.dataset.renderKey = signature;
  } else {
    const coordinateNode = card.querySelector('.map-unit-coordinate');
    if (coordinateNode && coordinateNode.textContent !== coords) coordinateNode.textContent = coords;
  }
  card.classList.remove('hidden');
}
function selectMapUnit(id, pan = true) {
  const unit = officer(id);
  if (!unit) return;
  selectedMapOfficerId = id;
  renderMapUnitHud();
  if (pan && Number.isFinite(unit.lat) && Number.isFinite(unit.lng)) {
    if (mapMode === '3d' && mapLibre)
      mapLibre.flyTo({ center: [unit.lng, unit.lat], zoom: Math.max(mapLibre.getZoom(), 15), duration: 700 });
    else map?.flyTo([unit.lat, unit.lng], Math.max(map.getZoom(), 15), { duration: 0.7 });
  }
}
function renderOverview() {
  const active = S.officers.filter((o) => o.shiftId),
    alerts = S.alerts.filter((a) => a.status !== 'handled');
  $('#alertCount').textContent = alerts.length;
  $('#unitCount').textContent = `${active.length} active`;
  $('#alertSummary').textContent = alerts.length
    ? `${alerts.filter((a) => a.status === 'raised').length} need a response`
    : 'No unresolved alerts';
  $('#mapUnitSummary').textContent = `${active.length} active units · ${alerts.length} open alerts`;
  renderMapUnitHud();
  $('#alertList').innerHTML =
    alerts
      .slice(0, 3)
      .map(
        (a) =>
          `<div class="alert-row"><div class="alert-symbol ${a.type === 'absence' ? 'amber' : ''}">${a.type === 'sos' ? '!' : a.type === 'geofence' ? '⌖' : '◷'}</div><div class="alert-copy"><b>${esc(a.title)}</b><small>${esc(officer(a.officerId)?.callSign || 'System')} · ${esc(a.detail)}</small><div class="alert-actions">${a.type === 'sos' ? `<button class="mini-action primary" data-action="view-sos" data-id="${a.id}">View on map</button>` : ''}${a.status === 'raised' ? `<button class="mini-action primary" data-alert="${a.id}" data-status="taken">Take alert</button>` : ''}<button class="mini-action" data-alert="${a.id}" data-status="handled">${a.status === 'raised' ? 'Handle' : 'Resolve'}</button><span class="tag ${a.status === 'taken' ? 'amber' : ''}">${esc(a.status)}</span></div></div><time>${ago(a.raisedAt)}</time></div>`,
      )
      .join('') || '<div class="empty-state"><strong>All clear</strong>No open alerts right now.</div>';
  $('#unitList').innerHTML =
    active
      .slice(0, 4)
      .map(
        (o) =>
          `<div class="unit-row" data-focus="${o.id}"><div class="unit-avatar" style="background:${o.color}22;color:${o.color}">${initials(o.name)}</div><div class="unit-copy"><b>${esc(o.callSign)} · ${esc(o.name)}</b><small>${esc(site(o.siteId)?.name || 'Unassigned')} · ${o.online ? 'Online' : 'Last seen ' + ago(o.lastSeen)}</small></div><span class="unit-state ${cls(o)}">${status(o)}</span></div>`,
      )
      .join('') || '<div class="empty-state">No active shifts</div>';
  $('#mapStyleSelect').value = mapStyle;
  const map3dButton = $('#map3dBtn');
  if (map3dButton) {
    map3dButton.disabled = false;
    map3dButton.title = MAPLIBRE_3D_SUPPORTED ? 'Pitched 3D map' : 'Load optional 3D renderer';
    map3dButton.setAttribute('aria-label', map3dButton.title);
  }
  syncTrafficButton();
  $('#map2dBtn')?.classList.toggle('active', mapMode === '2d');
  $('#map3dBtn')?.classList.toggle('active', mapMode === '3d');
  if (mapTransition) {
    if (mapMode === '3d' && mapLibre) mapLibreReady && refreshMapLibre();
  } else if (mapMode === '3d') {
    $('#map').classList.add('hidden');
    $('#map3d').classList.remove('hidden');
    if (!mapLibre) initMapLibre();
    else refreshMapLibre();
    if (!mapLibre) fallbackTo2DMap('3D renderer unavailable · using the 2D map');
  } else {
    $('#map3d').classList.add('hidden');
    $('#map').classList.remove('hidden');
    if (!map) initMap();
    else {
      map.invalidateSize();
      refreshMap();
    }
  }
}

function baseTileUrl() {
  if (mapStyle === 'satellite')
    return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  if (mapStyle === 'topo')
    return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}';
  if (S.settings.mapProvider === 'OpenStreetMap') return 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
}
function mapLibreBaseTileUrl() {
  return baseTileUrl();
}
function trafficTilesUrl() {
  const token = S?.settings?.tileToken,
    query = token ? `?t=${encodeURIComponent(token)}` : '';
  return `${location.origin}/api/traffic/tiles/flow/relative/{z}/{x}/{y}.png${query}`;
}
function mapAttribution() {
  return mapStyle === 'satellite'
    ? 'Imagery © Esri, Maxar, Earthstar Geographics'
    : mapStyle === 'topo'
      ? 'Tiles © Esri — Source: Esri, USGS, NOAA'
      : S.settings.mapProvider === 'OpenStreetMap'
        ? '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        : 'Tiles © Esri — Source: Esri, TomTom, Garmin, FAO, NOAA, USGS';
}
function installTileFallback(target, notice) {
  const layer = L.tileLayer(baseTileUrl(), { maxZoom: 19, attribution: mapAttribution() }).addTo(target);
  let ready = false,
    errors = 0,
    triedOsmFallback = false;
  const setNotice = (text, kind = '') => {
    if (!notice) return;
    notice.textContent = text;
    notice.classList.remove('hidden', 'traffic-loading', 'traffic-ok', 'traffic-error');
    if (kind) notice.classList.add(`traffic-${kind}`);
  };
  layer.on('tileload', () => {
    ready = true;
    if (notice && !trafficOn)
      setNotice(trafficConfigured(S.settings) ? 'Live traffic is off' : 'Traffic key required · Configure in Settings');
  });
  layer.on('tileerror', () => {
    errors++;
    window.DispatchDiagnostics?.record('map.basemap.tile.error', {
      style: mapStyle,
      provider: S.settings.mapProvider,
      consecutiveErrors: errors,
    });
    if (
      errors >= 3 &&
      !ready &&
      !triedOsmFallback &&
      mapStyle === 'street' &&
      S.settings.mapProvider === 'Esri World Street Map'
    ) {
      triedOsmFallback = true;
      errors = 0;
      layer.setUrl('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
      layer.options.attribution = '© OpenStreetMap contributors';
      target.attributionControl?.addAttribution('© OpenStreetMap contributors');
      setNotice('Esri basemap unavailable · trying OpenStreetMap', 'error');
      return;
    }
    if (errors >= 3 && !ready) setNotice('Map tiles are unavailable · check your connection', 'error');
  });
  setTimeout(() => {
    if (!ready) setNotice('Map tiles are taking a while to load · check your connection', 'error');
  }, 5000);
  return layer;
}
function initMap() {
  if (!window.L) {
    $('#map').innerHTML =
      '<div class="empty-state">Map engine did not load. Refresh the page or check the Leaflet assets.</div>';
    return;
  }
  try {
    map = L.map('map', { zoomControl: false }).setView([-26.1037, 28.0585], 14);
    L.control.scale({ imperial: false, metric: true, position: 'topleft' }).addTo(map);
    installTileFallback(map, $('#trafficNotice'));
    if (mapStyle === 'satellite')
      L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19, opacity: 0.95, attribution: 'Labels © Esri' },
      ).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    siteLayer = L.layerGroup().addTo(map);
    sitePolygonLayer = L.layerGroup().addTo(map);
    measureLayer = L.layerGroup().addTo(map);
    leafletOfficerMarkers = new Map();
    leafletSitePolygons = new Map();
    leafletSosMarkers = new Map();
    map.on('mousemove', (e) => {
      $('#mapCoordinates').textContent = `LAT ${e.latlng.lat.toFixed(5)} · LNG ${e.latlng.lng.toFixed(5)}`;
    });
    map.on('click', (e) => {
      if (drawMode) {
        drawPoints.push([e.latlng.lat, e.latlng.lng]);
        L.circleMarker(e.latlng, { radius: 4, color: '#285442', fillOpacity: 1 }).addTo(siteLayer);
        if (drawPoints.length > 1) L.polyline(drawPoints, { color: '#285442', dashArray: '5 4' }).addTo(siteLayer);
      } else if (measureMode) measurePoint(e.latlng.lat, e.latlng.lng);
    });
    renderMeasurements();
    refreshMap();
    if ((trafficOn || S.settings.trafficEnabled) && trafficConfigured(S.settings)) traffic(true);
  } catch (e) {
    console.error('Map initialization failed', e);
    $('#map').innerHTML =
      `<div class="empty-state"><strong>Could not initialize map</strong>${esc(e.message || e)}</div>`;
    toast(`Map initialization failed: ${e.message || e}`, true);
  }
}
let trafficLog = [];
let trafficLogLoadedAt = 0;
async function loadTrafficLog({ force = false } = {}) {
  if (!force && Date.now() - trafficLogLoadedAt < 15000) return trafficLog;
  try {
    const d = await api('/api/traffic');
    trafficLog = Array.isArray(d.traffic) ? d.traffic : [];
    trafficLogLoadedAt = Date.now();
    mapDataCache = null;
    if (typeof updateTrafficSummary === 'function') updateTrafficSummary();
  } catch {}
  return trafficLog;
}
function latestTraffic(siteId, when = Infinity) {
  return [...trafficLog].reverse().find((x) => x.siteId === siteId && Date.parse(x.at) <= when);
}
function updateTrafficSummary() {
  const n = $('#trafficSummary');
  if (!n || !S) return;
  const rows = S.sites
    .filter((s) => s.areaType === 'work')
    .map((s) => ({ site: s, reading: latestTraffic(s.id) }))
    .filter((x) => x.reading);
  if (!rows.length) {
    n.innerHTML = `<b><i></i> TOMTOM FLOW</b><span>${trafficOn ? 'Waiting for traffic readings' : 'No flow readings yet'}</span>`;
    return;
  }
  const fresh = rows.some((x) => Date.now() - Date.parse(x.reading.at) < 10 * 60000);
  n.innerHTML = `<b><i class="${fresh ? 'fresh' : ''}"></i> ${fresh ? 'LIVE' : 'LATEST'} TOMTOM FLOW</b>${rows.map((x) => `<span class="flow-reading ${esc(x.reading.level)}"><strong>${esc(x.site.name)}</strong> ${Math.round(x.reading.currentSpeed)}/${Math.round(x.reading.freeFlowSpeed)} km/h · ${esc(x.reading.level)}</span>`).join('')}`;
}
function trafficColor(level) {
  return (
    { free: '#64a47a', moderate: '#9eae70', slow: '#e3a243', heavy: '#d75e50', stopped: '#7e2929' }[level] || '#648b73'
  );
}
function siteMapPopup(s) {
  return `<div class="site-map-popup"><b>${esc(s.name)}</b><small>${s.areaType === 'restricted' ? 'Restricted area' : 'Work site'} · ${s.coordinates.length} boundary points</small><div><button type="button" class="mini-action primary" data-action="edit-site-map" data-id="${esc(s.id)}">Edit boundary on map</button> <button type="button" class="mini-action" data-action="edit-site" data-id="${esc(s.id)}">Site details</button></div></div>`;
}
function regionMapPopup(r) {
  return `<div class="site-map-popup"><b>${esc(r.name)}</b><small>${r.areaType === 'restricted' ? 'Restricted zone' : 'Work zone'} · ${r.coordinates.length} boundary points</small><div><button type="button" class="mini-action primary" data-action="edit-region-map" data-id="${esc(r.id)}">Edit boundary on map</button> <button type="button" class="mini-action" data-action="edit-region" data-id="${esc(r.id)}">Zone details</button></div></div>`;
}
function cancelSiteMapEdit() {
  if (editingSiteLayer) {
    editingSiteLayer.remove();
    editingSiteLayer = null;
  }
  editingSiteHandles = [];
  if (editingSiteId && editingSiteOriginal && editingZonePolygon) editingZonePolygon.setLatLngs(editingSiteOriginal);
  const wasOverview = editingZoneMap === map;
  editingSiteId = null;
  editingZoneKind = 'site';
  editingSiteOriginal = null;
  editingZoneMap = null;
  editingZonePolygon = null;
  drawMode = false;
  const hint = $('#drawHint');
  if (hint) {
    hint.classList.add('hidden');
    hint.innerHTML =
      'Click map to add points <button data-action="finish-draw">Finish</button><button data-action="cancel-draw">Cancel</button>';
  }
  if (wasOverview && map) refreshMap();
}
function startZoneMapEdit(kind, id) {
  const target = kind === 'region' ? S.regions.find((x) => x.id === id) : site(id);
  if (!target) return;
  const key = kind === 'region' ? `region:${id}` : id,
    targetMap = currentPage === 'overview' ? (mapMode === '2d' ? map : null) : siteMap;
  if (!targetMap) {
    if (kind === 'region') regionForm(target);
    else siteForm(target);
    toast('Switch to 2D to drag the numbered boundary points on the map.');
    return;
  }
  cancelSiteMapEdit();
  editingSiteId = id;
  editingZoneKind = kind;
  editingZoneMap = targetMap;
  editingSiteOriginal = target.coordinates.map((p) => [Number(p[0]), Number(p[1])]);
  editingZonePolygon = targetMap === map ? leafletSitePolygons.get(key)?.layer : sitePagePolygons.get(key);
  editingSiteLayer = L.layerGroup().addTo(targetMap);
  const update = () => {
    const coords = editingSiteHandles.map((h) => {
      const p = h.getLatLng();
      return [p.lat, p.lng];
    });
    editingZonePolygon?.setLatLngs(coords);
  };
  editingSiteHandles = editingSiteOriginal.map((point, index) => {
    const handle = L.marker(point, {
      draggable: true,
      icon: L.divIcon({
        className: 'site-edit-handle',
        html: `<span>${index + 1}</span>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      }),
    }).addTo(editingSiteLayer);
    handle.on('drag', () => {
      const snapped = nearestBoundarySnap(targetMap, handle.getLatLng(), { kind, id });
      if (snapped) handle.setLatLng(snapped);
      update();
    });
    return handle;
  });
  const hint = $('#drawHint');
  hint.innerHTML =
    '<span><b>Edit boundary:</b> drag numbered points; corners snap to nearby zone edges.</span><button type="button" data-action="save-site-edit">Save boundary</button><button type="button" data-action="cancel-site-edit">Cancel</button>';
  hint.classList.remove('hidden');
  toast('Drag the numbered map points; nearby boundaries snap into alignment.');
}
async function saveSiteMapEdit() {
  if (!editingSiteId || editingSiteHandles.length < 3)
    return toast('A zone boundary needs at least three points.', true);
  const target = editingZoneKind === 'region' ? S.regions.find((x) => x.id === editingSiteId) : site(editingSiteId),
    type = editingZoneKind === 'region' ? 'region-save' : 'site-save',
    coordinates = editingSiteHandles.map((h) => {
      const p = h.getLatLng();
      return [p.lat, p.lng];
    });
  try {
    await action(type, { ...target, coordinates });
    cancelSiteMapEdit();
    toast('Zone boundary updated');
  } catch (e) {
    toast(e.message || 'Could not save this boundary', true);
  }
}
function sosPopupHtml(a) {
  const snapshot = a.sosSnapshot || {},
    unit = officer(a.officerId),
    siteName = snapshot.siteName || site(unit?.siteId)?.name || 'Unassigned',
    lat = a.lat ?? snapshot.lat ?? unit?.lat,
    lng = a.lng ?? snapshot.lng ?? unit?.lng,
    accuracy = a.accuracy ?? snapshot.accuracy ?? unit?.accuracy,
    battery = batteryPercent(snapshot.battery ?? unit?.battery),
    signal = snapshot.signal ?? unit?.signal,
    position =
      lat !== null &&
      lat !== undefined &&
      lng !== null &&
      lng !== undefined &&
      Number.isFinite(Number(lat)) &&
      Number.isFinite(Number(lng))
        ? `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`
        : 'No GPS position available';
  return `<div class="sos-map-popup"><b>EMERGENCY SOS · ${esc(unit?.callSign || a.detail || 'Unit')}</b><div>${esc(unit?.name || '')}</div><small>SOS pressed · ${esc(fmt(a.phonePressedAt || a.raisedAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</small><small>Last GPS fix · ${esc(fmt(a.locationAt || snapshot.locationAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}${a.offline ? ' · OFFLINE / LAST KNOWN' : ''}</small><small>Position · ${esc(position)} · accuracy ±${esc(accuracy ?? '—')} m</small><small>Site · ${esc(siteName)} · Status · ${esc(status(unit || {}))}</small><small>Battery · ${battery === null ? '—' : `${Math.round(battery)}%`} · Signal · ${esc(signal ?? '—')}/5</small></div>`;
}
function focusSosAlert(alertId) {
  const alert = S.alerts.find((a) => a.id === alertId && a.type === 'sos');
  if (!alert) return;
  const unit = officer(alert.officerId),
    lat = Number.isFinite(alert.lat) ? alert.lat : unit?.lat,
    lng = Number.isFinite(alert.lng) ? alert.lng : unit?.lng;
  if (currentPage !== 'overview') go('overview');
  else renderOverview();
  const show = () => {
    if (alert.officerId) selectMapUnit(alert.officerId, false);
    const popup = sosPopupHtml(alert);
    if (mapMode === '3d' && mapLibre) {
      if (Number.isFinite(lat) && Number.isFinite(lng))
        mapLibre.flyTo({ center: [lng, lat], zoom: Math.max(mapLibre.getZoom(), 16), duration: 700 });
      const addPopup = () => {
        if (mapLibre && Number.isFinite(lat) && Number.isFinite(lng))
          new maplibregl.Popup({ maxWidth: '300px' }).setLngLat([lng, lat]).setHTML(popup).addTo(mapLibre);
      };
      if (mapLibreReady) addPopup();
      else mapLibre.once('load', addPopup);
    } else if (map) {
      if (Number.isFinite(lat) && Number.isFinite(lng))
        map.flyTo([lat, lng], Math.max(map.getZoom(), 16), { duration: 0.7 });
      const item = leafletSosMarkers.get(alert.id);
      if (item) item.layer.openPopup();
      else if (Number.isFinite(lat) && Number.isFinite(lng))
        L.popup().setLatLng([lat, lng]).setContent(popup).openOn(map);
    }
  };
  setTimeout(show, currentPage === 'overview' ? 60 : 180);
}
function refreshMap() {
  if (!map || !S) return;
  const liveSites = new Set(),
    liveOfficers = new Set(),
    liveAlerts = new Set();
  for (const s of S.sites) {
    liveSites.add(s.id);
    const t = latestTraffic(s.id),
      color = s.areaType === 'restricted' ? s.color || '#c65b51' : t ? trafficColor(t.level) : s.color || '#648b73',
      label = `${esc(s.name)}${t ? ` · ${t.level.toUpperCase()} · ${t.currentSpeed}/${t.freeFlowSpeed} km/h` : ''}${s.areaType === 'restricted' ? ' · RESTRICTED' : ''}`,
      style = {
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: s.areaType === 'restricted' ? 0.15 : t ? 0.25 : 0.1,
        dashArray: s.areaType === 'restricted' ? '5 4' : null,
      },
      shape = JSON.stringify(s.coordinates),
      styleKey = JSON.stringify(style);
    let item = leafletSitePolygons.get(s.id);
    if (!item) {
      const polygon = L.polygon(s.coordinates, style).addTo(sitePolygonLayer);
      polygon.bindTooltip(`<span class="site-label">${label}</span>`, { sticky: true });
      polygon.bindPopup(siteMapPopup(s));
      item = { layer: polygon, shape, styleKey, label, popupKey: JSON.stringify([s.id, s.name, s.areaType]) };
      leafletSitePolygons.set(s.id, item);
    } else {
      const popupKey = JSON.stringify([s.id, s.name, s.areaType]);
      if (item.popupKey !== popupKey) {
        item.layer.getPopup()?.setContent(siteMapPopup(s));
        item.popupKey = popupKey;
      }
      if (item.shape !== shape && !(editingZoneKind === 'site' && editingSiteId === s.id)) {
        item.layer.setLatLngs(s.coordinates);
        item.shape = shape;
      }
      if (item.styleKey !== styleKey) {
        item.layer.setStyle(style);
        item.styleKey = styleKey;
      }
      if (item.label !== label) {
        item.layer.getTooltip()?.setContent(`<span class="site-label">${label}</span>`);
        item.label = label;
      }
    }
  }
  for (const r of S.regions) {
    const key = `region:${r.id}`;
    liveSites.add(key);
    const color = r.color || (r.areaType === 'restricted' ? '#c65b51' : '#648b73'),
      label = `${esc(r.name)} · ZONE`,
      style = {
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: 0.09,
        dashArray: r.areaType === 'restricted' ? '5 4' : '2 5',
      },
      shape = JSON.stringify(r.coordinates),
      styleKey = JSON.stringify(style),
      popupKey = JSON.stringify([r.id, r.name, r.areaType]);
    let item = leafletSitePolygons.get(key);
    if (!item) {
      const polygon = L.polygon(r.coordinates, style).addTo(sitePolygonLayer);
      polygon.bindTooltip(`<span class="site-label">${label}</span>`, { sticky: true });
      polygon.bindPopup(regionMapPopup(r));
      item = { layer: polygon, shape, styleKey, label, popupKey };
      leafletSitePolygons.set(key, item);
    } else {
      if (item.shape !== shape && !(editingZoneKind === 'region' && editingSiteId === r.id)) {
        item.layer.setLatLngs(r.coordinates);
        item.shape = shape;
      }
      if (item.styleKey !== styleKey) {
        item.layer.setStyle(style);
        item.styleKey = styleKey;
      }
      if (item.label !== label) {
        item.layer.getTooltip()?.setContent(`<span class="site-label">${label}</span>`);
        item.label = label;
      }
      if (item.popupKey !== popupKey) {
        item.layer.getPopup()?.setContent(regionMapPopup(r));
        item.popupKey = popupKey;
      }
    }
  }
  for (const [id, item] of leafletSitePolygons)
    if (!liveSites.has(id)) {
      item.layer.remove();
      leafletSitePolygons.delete(id);
    }
  for (const o of S.officers) {
    if (!Number.isFinite(o.lat) || !Number.isFinite(o.lng)) continue;
    liveOfficers.add(o.id);
    const color = !o.shiftId
        ? '#949e99'
        : o.stunned
          ? '#c65b51'
          : o.status === 'on-site'
            ? '#4b9267'
            : o.status === 'left-site'
              ? '#c65b51'
              : '#d59a39',
      iconHtml = `<div class="officer-marker" style="background:${color}">${initials(o.callSign)}</div>`,
      popupHtml = `<b>${esc(o.callSign)} · ${esc(o.name)}</b><br>${esc(status(o))} · ${esc(site(o.siteId)?.name || 'No site')}<br>${o.online ? 'Online' : 'Offline'} · GPS ±${Math.round(o.accuracy || 0)}m<br><button onclick="window.quickMessage('${esc(o.id)}')">Message unit</button>`;
    let item = leafletOfficerMarkers.get(o.id);
    if (!item) {
      const icon = L.divIcon({ className: '', html: iconHtml, iconSize: [29, 29], iconAnchor: [14, 14] }),
        marker = L.marker([o.lat, o.lng], { icon }).addTo(markerLayer);
      marker.on('click', () => selectMapUnit(o.id, false));
      marker.bindPopup(popupHtml);
      item = { layer: marker, lat: o.lat, lng: o.lng, iconHtml, popupHtml };
      leafletOfficerMarkers.set(o.id, item);
    } else {
      if (item.lat !== o.lat || item.lng !== o.lng) {
        item.layer.setLatLng([o.lat, o.lng]);
        item.lat = o.lat;
        item.lng = o.lng;
      }
      if (item.iconHtml !== iconHtml) {
        item.layer.setIcon(L.divIcon({ className: '', html: iconHtml, iconSize: [29, 29], iconAnchor: [14, 14] }));
        item.iconHtml = iconHtml;
      }
      if (item.popupHtml !== popupHtml) {
        item.layer.getPopup()?.setContent(popupHtml);
        item.popupHtml = popupHtml;
      }
    }
  }
  for (const [id, item] of leafletOfficerMarkers)
    if (!liveOfficers.has(id)) {
      item.layer.remove();
      leafletOfficerMarkers.delete(id);
    }
  for (const a of S.alerts.filter((x) => x.type === 'sos' && x.status !== 'handled' && Number.isFinite(x.lat))) {
    liveAlerts.add(a.id);
    const popupHtml = sosPopupHtml(a);
    let item = leafletSosMarkers.get(a.id);
    if (!item) {
      const layer = L.circleMarker([a.lat, a.lng], {
        radius: 14,
        color: '#c33f35',
        weight: 3,
        fillColor: '#f4a29a',
        fillOpacity: 0.35,
      })
        .addTo(markerLayer)
        .bindPopup(popupHtml);
      item = { layer, lat: a.lat, lng: a.lng, popupHtml };
      leafletSosMarkers.set(a.id, item);
    } else {
      if (item.lat !== a.lat || item.lng !== a.lng) {
        item.layer.setLatLng([a.lat, a.lng]);
        item.lat = a.lat;
        item.lng = a.lng;
      }
      if (item.popupHtml !== popupHtml) {
        item.layer.getPopup()?.setContent(popupHtml);
        item.popupHtml = popupHtml;
      }
    }
  }
  for (const [id, item] of leafletSosMarkers)
    if (!liveAlerts.has(id)) {
      item.layer.remove();
      leafletSosMarkers.delete(id);
    }
  $('#mapTime').textContent = `Updated ${fmt(Date.now())}`;
}
function checkSOS() {
  const list = S.alerts.filter((a) => a.type === 'sos' && a.status === 'raised'),
    fresh = list.find((a) => !alertSeen.has(a.id));
  if (fresh) {
    alertSeen.add(fresh.id);
    const sos = fresh.sosSnapshot || {};
    $('#alarmText').textContent =
      `${fresh.detail} · ${fmt(fresh.phonePressedAt || fresh.raisedAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · GPS ±${sos.accuracy ?? '—'}m · battery ${batteryLabel(sos.battery)}`;
    $('#alarmLayer').classList.remove('hidden');
  }
  if (list.length) {
    $('#alarmLayer').classList.remove('hidden');
    if (soundEnabled && Date.now() - lastAlarmSound > 5000) {
      alarmSound();
      lastAlarmSound = Date.now();
    }
  } else $('#alarmLayer').classList.add('hidden');
}
function alarmSound() {
  try {
    const c = window.dispatchAudio || (window.dispatchAudio = new AudioContext());
    if (c.state === 'suspended') return;
    const o = c.createOscillator(),
      g = c.createGain();
    o.connect(g);
    g.connect(c.destination);
    o.frequency.value = 850;
    g.gain.value = 0.06;
    o.start();
    setTimeout(() => o.stop(), 250);
  } catch {}
}
window.quickMessage = (id) => messageForm(id);
function unitsHtml() {
  const on = S.officers.filter((o) => o.shiftId).length;
  return (
    header('Units & people', 'Roster and live shift status.', '＋ Add officer', 'add-officer') +
    `<div class="workspace-grid"><div class="content-card workspace-full"><div class="toolbar"><input id="unitSearch" class="input" placeholder="Search name, unit or group"><select id="unitFilter" class="select"><option value="all">All statuses</option><option value="active">On shift</option><option value="off-duty">Off duty</option><option value="offline">Offline</option><option value="stunned">Stunned</option></select><span class="spacer"></span><details class="inline-disclosure"><summary>Import / export</summary><div class="inline-disclosure-menu"><button class="button ghost small" data-action="template">↓ Import template</button><button class="button ghost small" data-action="import">↑ Import CSV</button><a class="button ghost small" href="/api/export?type=officers">Export roster</a></div></details></div><div id="unitsTable"></div></div><details class="workspace-disclosure workspace-full"><summary><span><b>Groups & shift summary</b><small id="groupsShiftSummary">${S.groups.length} groups · ${on} clocked in</small></span><span class="disclosure-action">Show</span></summary><div class="workspace-disclosure-body"><div class="workspace-grid"><div class="content-card"><div class="panel-heading"><div><div class="panel-title">Radio groups</div><div class="panel-subtitle">Groups available to terminals</div></div><button class="button ghost small" data-action="add-group">＋ Group</button></div><div id="groupsList" class="detail-list"></div></div><div class="content-card"><div class="panel-heading"><div class="panel-title">Shift summary</div></div><div class="kv-grid"><div class="kv-card"><small>Clocked in</small><b id="unitClockedInCount">${on}</b></div><div class="kv-card"><small>Online</small><b id="unitOnlineCount">${S.officers.filter((o) => o.shiftId && o.online).length}</b></div><div class="kv-card"><small>Stunned</small><b id="unitStunnedCount">${S.officers.filter((o) => o.stunned).length}</b></div></div></div></div></div></details></div>`
  );
}
function renderUnits() {
  unitsTable();
  $('#groupsList').innerHTML = S.groups
    .map(
      (g) =>
        `<div class="detail-row"><span>${esc(g)} · ${S.officers.filter((o) => o.group === g).length} terminals</span><b><button class="mini-action" data-action="delete-group" data-name="${esc(g)}">Remove</button></b></div>`,
    )
    .join('');
  const active = S.officers.filter((o) => o.shiftId),
    summary = $('#groupsShiftSummary');
  if (summary) summary.textContent = `${S.groups.length} groups · ${active.length} clocked in`;
  const counts = {
    '#unitClockedInCount': active.length,
    '#unitOnlineCount': S.officers.filter((o) => o.shiftId && o.online).length,
    '#unitStunnedCount': S.officers.filter((o) => o.stunned).length,
  };
  for (const [selector, value] of Object.entries(counts)) {
    const node = $(selector);
    if (node) node.textContent = String(value);
  }
}
function unitsTable() {
  const q = ($('#unitSearch')?.value || '').toLowerCase(),
    f = $('#unitFilter')?.value || 'all',
    rows = S.officers.filter(
      (o) =>
        `${o.name} ${o.callSign} ${o.group}`.toLowerCase().includes(q) &&
        (f === 'all' ||
          (f === 'active' && o.shiftId) ||
          (f === 'off-duty' && !o.shiftId) ||
          (f === 'offline' && !o.online) ||
          (f === 'stunned' && o.stunned)),
    );
  $('#unitsTable').innerHTML = rows.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Terminal / officer</th><th>Group</th><th>Shift / site</th><th>Status</th><th>Health</th><th>Last seen</th><th>Actions</th></tr></thead><tbody>${rows.map((o) => `<tr><td><b>${esc(o.callSign)}</b><br>${esc(o.name)}</td><td>${esc(o.group)}</td><td>${o.shiftId ? esc(site(o.siteId)?.name || 'Assigned') : '—'}</td><td><span class="tag ${cls(o)}">${esc(status(o))}</span></td><td>▰ ${batteryPercent(o.battery) === null ? '—' : `${Math.round(batteryPercent(o.battery))}%`} · ▂ ${o.signal ?? '—'}/5</td><td>${ago(o.lastSeen)}</td><td>${o.shiftId ? `<button class="mini-action" data-action="clock-out" data-id="${o.id}">Clock out</button>` : `<button class="mini-action primary" data-action="clock-in" data-id="${o.id}">Clock in</button>`} <button class="mini-action" data-action="unit-menu" data-id="${o.id}">•••</button></td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty-state">No matching terminals</div>';
}
function sitesHtml() {
  const count = S.regions.length;
  return (
    header('Sites & regions', 'Work locations and restricted areas.', '＋ New site', 'add-site') +
    `<div class="workspace-grid"><div class="content-card workspace-full"><div class="toolbar"><span class="panel-subtitle">Draw or edit boundaries on the map.</span><span class="spacer"></span><button class="button ghost small" data-action="draw-site-page">＋ Draw boundary</button></div><div class="site-map-editor"><div id="siteMap" class="workspace-map" role="region" aria-label="Map of sites and active units"></div><div class="draw-hint hidden" id="drawHint">Click map to add points <button data-action="finish-draw">Finish</button><button data-action="cancel-draw">Cancel</button></div></div><div id="sitesTable"></div></div><details class="workspace-disclosure workspace-full"><summary><span><b>Geofenced regions</b><small>${count} regions · work and restricted areas</small></span><span class="disclosure-action">Show</span></summary><div class="workspace-disclosure-body"><div class="content-card"><div class="panel-heading"><div><div class="panel-title">Regions</div><div class="panel-subtitle">Assigned boundaries and access rules</div></div><button class="button ghost small" data-action="add-region">＋ Region</button></div><div id="regionsTable"></div></div></div></details></div>`
  );
}
function renderSites() {
  if (window.L) {
    if (!siteMap) {
      siteMap = L.map('siteMap').setView([-26.1037, 28.0585], 14);
      sitePagePolygons = new Map();
      sitePageUnitMarkers = new Map();
      installTileFallback(siteMap, null);
    }
    const live = new Set();
    const updateZone = (key, zone, kind) => {
      live.add(key);
      const color = zone.color || (zone.areaType === 'restricted' ? '#c65b51' : '#648b73'),
        style = {
          color,
          fillColor: color,
          weight: 2,
          fillOpacity: kind === 'site' ? 0.12 : 0.09,
          dashArray: zone.areaType === 'restricted' ? '5 4' : kind === 'region' ? '2 5' : null,
        },
        shape = JSON.stringify(zone.coordinates);
      let layer = sitePagePolygons.get(key);
      if (!layer) {
        layer = L.polygon(zone.coordinates, style).addTo(siteMap);
        sitePagePolygons.set(key, layer);
        layer._dispatchShape = shape;
        layer._dispatchStyle = JSON.stringify(style);
        layer
          .bindTooltip(kind === 'region' ? `${zone.name} · ZONE` : zone.name)
          .bindPopup(kind === 'region' ? regionMapPopup(zone) : siteMapPopup(zone));
      } else {
        if (layer._dispatchShape !== shape) {
          layer.setLatLngs(zone.coordinates);
          layer._dispatchShape = shape;
        }
        const styleKey = JSON.stringify(style);
        if (layer._dispatchStyle !== styleKey) {
          layer.setStyle(style);
          layer._dispatchStyle = styleKey;
        }
        const label = kind === 'region' ? `${zone.name} · ZONE` : zone.name;
        layer.getTooltip()?.setContent(label);
        layer.getPopup()?.setContent(kind === 'region' ? regionMapPopup(zone) : siteMapPopup(zone));
      }
    };
    for (const x of S.sites) updateZone(x.id, x, 'site');
    for (const x of S.regions) updateZone(`region:${x.id}`, x, 'region');
    for (const [key, layer] of sitePagePolygons)
      if (!live.has(key)) {
        layer.remove();
        sitePagePolygons.delete(key);
      }
    const active = new Set();
    for (const o of S.officers.filter((x) => x.shiftId && Number.isFinite(x.lat) && Number.isFinite(x.lng))) {
      active.add(o.id);
      const color = o.color || '#648b73';
      let marker = sitePageUnitMarkers.get(o.id);
      if (!marker) {
        marker = L.circleMarker([o.lat, o.lng], { radius: 6, color, fillOpacity: 1 })
          .addTo(siteMap)
          .bindTooltip(o.callSign);
        sitePageUnitMarkers.set(o.id, marker);
      } else {
        marker.setLatLng([o.lat, o.lng]);
        marker.setStyle({ color });
        marker.getTooltip()?.setContent(o.callSign);
      }
    }
    for (const [id, marker] of sitePageUnitMarkers)
      if (!active.has(id)) {
        marker.remove();
        sitePageUnitMarkers.delete(id);
      }
  }
  $('#sitesTable').innerHTML = sitesTable();
  $('#regionsTable').innerHTML = S.regions.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Region</th><th>Type</th><th>Assigned units</th><th></th></tr></thead><tbody>${S.regions.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(r.areaType)}</td><td>${r.assigned?.map((id) => esc(officer(id)?.callSign || id)).join(', ') || 'All units'}</td><td><button class="mini-action" data-action="edit-region" data-id="${r.id}">Edit</button> <button class="mini-action" data-action="region-delete" data-id="${r.id}">Remove</button></td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty-state">No additional regions</div>';
}

function sitesTable() {
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Site / region</th><th>Type</th><th>Assigned</th><th>On site</th><th>Tolerance</th><th>Actions</th></tr></thead><tbody>${S.sites.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td><span class="tag ${s.areaType === 'restricted' ? 'red' : ''}">${esc(s.areaType)}</span></td><td>${s.assigned?.map((id) => esc(officer(id)?.callSign || id)).join(', ') || '—'}</td><td>${S.officers.filter((o) => o.siteId === s.id && o.status === 'on-site').length}</td><td>${s.tolerance || 40} m</td><td><button class="mini-action" data-action="edit-site" data-id="${s.id}">Edit</button> <button class="mini-action" data-action="delete-site" data-id="${s.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>`;
}
function messagesHtml() {
  return (
    header('Messages', 'Dispatch messages and delivery status.', '＋ Compose message', 'compose-message') +
    `<div class="workspace-grid"><div class="content-card workspace-full"><div class="toolbar"><input id="messageSearch" class="input" placeholder="Search messages"><select id="messageFilter" class="select"><option value="all">All</option><option value="queued">Queued</option><option value="scheduled">Scheduled</option></select><span class="spacer"></span><button class="button ghost small" data-action="compose-message">＋ Compose</button></div><div id="messagesTable"></div></div></div>`
  );
}
function renderMessages() {
  const draw = () => {
    const q = ($('#messageSearch')?.value || '').toLowerCase(),
      f = $('#messageFilter')?.value || 'all',
      ms = S.messages.filter(
        (m) =>
          `${m.body} ${m.to} ${m.from}`.toLowerCase().includes(q) &&
          (f === 'all' || (f === 'queued' && !m.deliveredAt) || (f === 'scheduled' && m.scheduledAt)),
      );
    $('#messagesTable').innerHTML = ms.length
      ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>From / to</th><th>Message</th><th>Sent</th><th>Delivery</th><th>Read</th><th></th></tr></thead><tbody>${ms.map((m) => `<tr><td><b>${esc(m.from)}</b><br>${esc(officer(m.to)?.callSign || m.to)}</td><td>${esc(m.body)}</td><td>${fmt(m.createdAt)}</td><td><span class="tag ${m.deliveredAt ? '' : 'amber'}">${m.deliveredAt ? 'Delivered' : 'Queued'}</span></td><td>${m.readAt ? fmt(m.readAt) : '—'}</td><td><button class="mini-action" data-action="mark-read" data-id="${m.id}">Mark read</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty-state">No messages match.</div>';
  };
  draw();
  $('#messageSearch').oninput = draw;
  $('#messageFilter').onchange = draw;
}
function callsHtml() {
  return (
    header('Voice dispatch', 'Private, group and all-call channels for your network.', '＋ Start call', 'start-call') +
    `<div class="workspace-grid"><div class="content-card"><div class="panel-heading"><div><div class="panel-title">Dispatch channels</div><div class="panel-subtitle">8 dispatch channels · live browser audio over WebRTC on your local network</div></div><span class="tag">${S.calls.filter((c) => ['active', 'ringing'].includes(c.status)).length} active</span></div><div class="kv-grid">${Array.from(
      { length: 8 },
      (_, i) => {
        const c = S.calls.find((x) => ['active', 'ringing'].includes(x.status) && x.channel === i + 1);
        return `<div class="kv-card"><small>Channel ${i + 1}</small><b style="font-size:12px">${c ? esc(c.type.toUpperCase()) : 'Available'}</b><small>${c ? `${esc(c.to)} · ` : ''}${c ? `<button class="text-button" data-action="end-call" data-id="${c.id}">End</button>` : 'Ready to transmit'}</small></div>`;
      },
    ).join(
      '',
    )}</div><div class="toolbar"><button class="button primary small" data-action="start-call">◖ Open channel</button><button class="button ghost small" data-action="intercom">▣ Dispatcher intercom</button><button class="button ghost small" data-action="record-call">● Record local mic</button></div></div><details class="workspace-disclosure"><summary><span><b>Audio patch presets</b><small>Saved local routing configuration</small></span><span class="disclosure-action">Show</span></summary><div class="workspace-disclosure-body"><div class="panel-heading"><button class="button ghost small" data-action="new-patch">＋ Patch</button></div><div id="patchList" class="detail-list"></div></div></details><details class="workspace-disclosure workspace-full"><summary><span><b>Call history</b><small>${S.calls.length} recorded sessions</small></span><span class="disclosure-action">Show</span></summary><div class="workspace-disclosure-body"><div class="panel-heading"><a class="button ghost small" href="/api/export?type=calls">Export CSV</a></div><div id="callTable"></div></div></details><details class="workspace-disclosure"><summary><span><b>External PBX / SIP gateway</b><small>Optional · local WebRTC calls work without it</small></span><span class="disclosure-action">Show</span></summary><div class="workspace-disclosure-body"><div class="detail-list"><div class="detail-row"><span>PBX endpoint</span><b>${esc(S.settings.sipHost || 'Not configured')}</b></div><div class="detail-row"><span>State</span><b><span class="tag grey">Not connected</span></b></div><div class="detail-row"><span>Protocol</span><b>External SIP trunk required</b></div></div></div></details></div>`
  );
}
function renderCalls() {
  $('#callTable').innerHTML = S.calls.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Call</th><th>From / to</th><th>Start</th><th>State</th><th></th></tr></thead><tbody>${S.calls.map((c) => `<tr><td><b>${esc(c.type)}</b></td><td>${esc(c.from)} → ${esc(officer(c.to)?.callSign || c.to)}</td><td>${fmt(c.startedAt)}</td><td><span class="tag ${['active', 'ringing'].includes(c.status) ? 'amber' : ''}">${esc(c.status)}</span></td><td>${['active', 'ringing'].includes(c.status) ? `<button class="mini-action" data-action="end-call" data-id="${c.id}">End</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty-state">No calls yet.</div>';
  $('#patchList').innerHTML = S.callPatches.length
    ? S.callPatches
        .map(
          (p) =>
            `<div class="detail-row"><span>${esc(p.name)} · ${p.members.map(esc).join(', ')}</span><b>${p.active ? `<button class="mini-action" data-action="stop-patch" data-id="${p.id}">Remove</button>` : 'Removed'}</b></div>`,
        )
        .join('')
    : '<div class="empty-state">No audio patches</div>';
}
function recordingsHtml() {
  return (
    header('Recordings', 'Search and review locally saved dispatch audio.', '＋ Upload recording', 'upload-recording') +
    `<div class="content-card"><div class="toolbar"><input id="recordingSearch" class="input" placeholder="Search recordings"><button class="button ghost small" data-action="remote-monitor">◉ Remote monitor</button></div><div id="recordingsTable"></div></div><details class="workspace-disclosure"><summary><span><b>Recording privacy & storage</b><small>Consent, retention and local storage details</small></span><span class="disclosure-action">Show</span></summary><div class="workspace-disclosure-body"><div class="detail-list"><div class="detail-row"><span>Retention</span><b>${S.settings.retentionDays} days</b></div><div class="detail-row"><span>Storage</span><b>Local server disk</b></div><div class="detail-row"><span>Remote monitoring</span><b>Explicit microphone permission only</b></div></div></div></details>`
  );
}
function renderRecordings() {
  const draw = () => {
    let q = $('#recordingSearch').value.toLowerCase(),
      rs = S.recordings.filter((r) => `${r.name} ${r.from} ${r.to}`.toLowerCase().includes(q));
    $('#recordingsTable').innerHTML = rs.length
      ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Recording</th><th>Call</th><th>Captured</th><th>Playback</th><th></th></tr></thead><tbody>${rs.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(r.from)} → ${esc(r.to)}</td><td>${fmt(r.createdAt)}</td><td>${r.hasData ? `<audio controls preload="none" src="/api/recordings/${encodeURIComponent(r.id)}"></audio>` : '—'}</td><td>${r.hasData ? `<button class="mini-action" data-action="download-rec" data-id="${esc(r.id)}">Download</button>` : '—'}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty-state">No recordings stored.</div>';
  };
  draw();
  $('#recordingSearch').oninput = draw;
}
function networkHtml() {
  return (
    header(
      'Network & devices',
      'Terminal status, relays and device controls.',
      '＋ Add relay node',
      'add-relay',
    ) +
    `<div class="workspace-grid"><div class="content-card workspace-full"><div class="panel-heading"><div><div class="panel-title">Terminal health</div><div class="panel-subtitle">Battery, signal, connectivity and remote controls</div></div><button class="button ghost small" data-action="status-query">↻ Query all</button></div><div id="deviceTable"></div></div><details class="workspace-disclosure"><summary><span><b>Relay configuration</b><small>Locally configured · no physical link probe</small></span><span class="disclosure-action">Show</span></summary><div class="workspace-disclosure-body"><div id="relayList" class="detail-list"></div></div></details><details class="workspace-disclosure"><summary><span><b>Terminal actions</b><small>Remote commands and unit controls</small></span><span class="disclosure-action">Show</span></summary><div class="workspace-disclosure-body"><div id="terminalActions" class="detail-list"></div></div></details></div>`
  );
}
function renderNetwork() {
  $('#deviceTable').innerHTML =
    `<div class="table-wrap"><table class="data-table"><thead><tr><th>Unit</th><th>Battery</th><th>Signal</th><th>Connectivity</th><th>GPS</th><th>Status</th><th></th></tr></thead><tbody>${S.officers.map((o) => `<tr><td><b>${esc(o.callSign)}</b> · ${esc(o.name)}</td><td>${batteryLabel(o.battery)}</td><td>${'▮'.repeat(Math.max(0, o.signal || 0))}${'▯'.repeat(5 - Math.max(0, o.signal || 0))}</td><td><span class="tag ${o.online ? '' : 'red'}">${o.online ? 'Online' : 'Offline'}</span></td><td>±${o.accuracy || '—'} m</td><td>${esc(status(o))}</td><td><button class="mini-action" data-action="status-one" data-id="${o.id}">Query</button></td></tr>`).join('')}</tbody></table></div>`;
  $('#relayList').innerHTML =
    S.relays
      .map(
        (r) =>
          `<div class="detail-row"><span>${esc(r.name)}<small style="display:block;color:#96a099">${esc(r.host)} · ${esc(r.mode)}</small></span><b><span class="tag">${esc(r.status)}</span></b></div>`,
      )
      .join('') || '<div class="empty-state">No relays</div>';
  $('#terminalActions').innerHTML = S.officers
    .map(
      (o) =>
        `<div class="detail-row"><span>${esc(o.callSign)} · ${esc(o.name)}</span><b><button class="mini-action" data-action="stun" data-id="${o.id}">${o.stunned ? 'Activate' : 'Stun'}</button></b></div>`,
    )
    .join('');
}
function latestReviewDate() {
  const dates = [
    ...(S.officers || []).map((o) => (o.latestHistoryAt ? dateKey(o.latestHistoryAt) : '')),
    ...trafficLog.map((t) => dateKey(t.at)),
  ]
    .filter(Boolean)
    .sort();
  return dates.at(-1) || dateKey(Date.now());
}
function reviewHtml() {
  return (
    header(
      'Day review',
      'Replay archived traffic and recorded unit fixes together; opens on the newest matching date when available.',
      '↓ Export day report',
      'export-review',
    ) +
    `<div class="workspace-grid"><div class="content-card workspace-full review-stage"><div class="toolbar review-filters"><label class="form-field">Date <input id="reviewDate" type="date" class="input" value="${latestReviewDate()}"></label><label class="form-field" style="min-width:175px"><span>Unit history</span><select id="reviewOfficer" class="select" aria-label="Choose one unit or all units"><option value="all">All units</option>${S.officers.map((o) => `<option value="${o.id}">${esc(o.callSign)} · ${esc(o.name)}</option>`).join('')}</select></label><button class="button ghost small" data-action="load-review">Load day</button><span class="spacer"></span><span id="reviewTrafficCount" class="tag amber">Loading archived traffic…</span></div><div class="review-map-grid"><div class="review-map-frame"><div id="reviewMap" class="workspace-map" role="region" aria-label="Historical traffic and officer positions map"></div><div class="review-map-legend"><span>Recorded flow</span><i class="flow-free"></i><span>Free</span><i class="flow-slow"></i><span>Slow</span><i class="flow-heavy"></i><span>Heavy / stopped</span><span class="legend-divider"></span><i class="unit-pin-legend"></i><span>Unit fix</span></div></div><aside class="review-now"><section class="review-now-section"><div class="review-now-heading"><div><b>Traffic at replay time</b><small id="reviewTrafficAsOf">Waiting for timeline</small></div><span id="reviewTrafficBadge" class="tag grey">—</span></div><div id="reviewTrafficNow" class="review-now-list"><div class="empty-state">Choose a recorded time to view traffic.</div></div></section><section class="review-now-section"><div class="review-now-heading"><div><b>Unit positions</b><small id="reviewPositionAsOf">Same replay time</small></div><span id="reviewPositionBadge" class="tag grey">—</span></div><div id="reviewPositionsNow" class="review-now-list"><div class="empty-state">Recorded positions will appear here.</div></div></section></aside></div><div class="toolbar review-timeline"><button class="button primary small" data-action="replay-play">▶ Play</button><button class="button ghost small" data-action="replay-pause">Ⅱ Pause</button><select id="replaySpeed" class="select" aria-label="Replay speed"><option value="1">1×</option><option value="2">2×</option><option value="5">5×</option></select><input id="replayRange" type="range" min="0" max="0" value="0" aria-label="Replay timeline" style="flex:1"><span id="replayTime" class="panel-subtitle">Select a date</span></div></div><details class="workspace-disclosure workspace-full"><summary><span><b>Traffic coverage gaps</b><small>Heavy traffic with no nearby recorded GPS fix</small></span><span class="disclosure-action">Show</span></summary><div class="workspace-disclosure-body"><div class="content-card"><div id="coverageTable"></div></div></div></details><details class="workspace-disclosure workspace-full"><summary><span><b>Day summary</b><small>Recorded sample counts and data sources</small></span><span class="disclosure-action">Show</span></summary><div class="workspace-disclosure-body"><div class="content-card"><div id="daySummary"></div></div></div></details></div>`
  );
}
let replayPoints = [],
  replayTrafficPoints = [],
  replayEvents = [],
  reviewPaths = null,
  reviewTraffic = null,
  reviewUnits = null;
function stopReplay() {
  if (replayTimer !== null) {
    cancelAnimationFrame(replayTimer);
    replayTimer = null;
  }
}
function installReviewBasemap(target) {
  return installTileFallback(target, null);
}
function renderReview() {
  if (!window.L) return;
  reviewMap = L.map('reviewMap').setView([-26.1037, 28.0585], 14);
  installReviewBasemap(reviewMap);
  reviewPaths = L.layerGroup().addTo(reviewMap);
  reviewTraffic = L.layerGroup().addTo(reviewMap);
  reviewUnits = L.layerGroup().addTo(reviewMap);
  S.sites.forEach((s) =>
    L.polygon(s.coordinates, { color: s.color, weight: 1.5, fillOpacity: 0.035 }).addTo(reviewMap).bindTooltip(s.name),
  );
  loadReview();
  $('#reviewDate').onchange = loadReview;
  $('#reviewOfficer').onchange = loadReview;
  $('#replayRange').oninput = () => {
    stopReplay();
    showReplay(+$('#replayRange').value);
  };
}
function replayUpperBound(list, time, key) {
  let low = 0,
    high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (Date.parse(list[mid][key]) <= time) low = mid + 1;
    else high = mid;
  }
  return low;
}
let reviewLoadSequence = 0;
async function loadReview() {
  const sequence = ++reviewLoadSequence;
  stopReplay();
  const day = $('#reviewDate').value,
    officerId = $('#reviewOfficer').value;
  $('#reviewTrafficCount').textContent = 'Loading archived activity…';
  try {
    const query = new URLSearchParams({ date: day, officerId });
    const archive = await api(`/api/history?${query}`);
    if (sequence !== reviewLoadSequence) return;
    replayPoints = archive.points || [];
    replayTrafficPoints = archive.traffic || [];
    replayPointGroups = new Map();
    for (const point of replayPoints) {
      if (!replayPointGroups.has(point.officer.id)) replayPointGroups.set(point.officer.id, []);
      replayPointGroups.get(point.officer.id).push(point);
    }
    replayTrafficGroups = new Map();
    for (const sample of replayTrafficPoints) {
      if (!replayTrafficGroups.has(sample.siteId)) replayTrafficGroups.set(sample.siteId, []);
      replayTrafficGroups.get(sample.siteId).push(sample);
    }
    replayEvents = [
      ...replayPoints.map((point) => ({ kind: 'position', at: point.receivedAt, point })),
      ...replayTrafficPoints.map((traffic) => ({ kind: 'traffic', at: traffic.at, traffic })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    $('#replayRange').max = Math.max(0, replayEvents.length - 1);
    replayStartIndex = 0;
    $('#replayRange').value = 0;
    reviewPaths.clearLayers();
    reviewTrailLayers.clear();
    reviewTrailCounts.clear();
    reviewLastReplayIndex = -1;
    reviewTraffic.clearLayers();
    reviewUnits.clearLayers();
    const bounds = L.latLngBounds(
      S.sites.flatMap((item) => item.coordinates).concat(replayPoints.map((point) => [point.lat, point.lng])),
    );
    if (bounds.isValid()) reviewMap.fitBounds(bounds.pad(0.12), { maxZoom: 15 });
    const gaps = replayTrafficPoints
      .filter((sample) => ['heavy', 'stopped'].includes(sample.level))
      .filter((sample) => {
        const workSite = site(sample.siteId);
        if (!workSite) return false;
        return !replayPoints.some(
          (point) =>
            Math.abs(Date.parse(point.receivedAt) - Date.parse(sample.at)) <= 120000 &&
            insideSite([point.lat, point.lng], workSite.coordinates),
        );
      });
    $('#coverageTable').innerHTML = gaps.length
      ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Site</th><th>Traffic</th><th>Time</th><th>Flow</th><th>Observed coverage</th></tr></thead><tbody>${gaps.map((sample) => `<tr><td><b>${esc(site(sample.siteId)?.name || 'Site')}</b></td><td><span class="tag red">${esc(sample.level)}</span></td><td>${fmt(sample.at, { hour: '2-digit', minute: '2-digit' })}</td><td>${sample.currentSpeed}/${sample.freeFlowSpeed} km/h</td><td><span class="tag amber">No nearby GPS sample${officerId === 'all' ? '' : ' for selected unit'}</span></td></tr>`).join('')}</tbody></table></div>`
      : replayTrafficPoints.length
        ? '<div class="empty-state">No heavy-traffic coverage gaps recorded on this date for the selected unit.</div>'
        : '<div class="empty-state">No historical traffic snapshots for this date.</div>';
    $('#daySummary').innerHTML =
      `<div class="detail-list"><div class="detail-row"><span>Recorded GPS samples</span><b>${replayPoints.length}</b></div><div class="detail-row"><span>Traffic snapshots archived</span><b>${replayTrafficPoints.length}</b></div><div class="detail-row"><span>Work sites monitored</span><b>${S.sites.filter((item) => item.areaType === 'work').length}</b></div><div class="detail-row"><span>Data source</span><b>Saved movement history${replayTrafficPoints.length ? ' · archived traffic' : ''}</b></div></div><div class="panel-footer">Playback uses saved GPS fixes for ${officerId === 'all' ? 'all units' : 'the selected unit'} and archived traffic.</div>`;
    $('#reviewTrafficCount').textContent = replayTrafficPoints.length
      ? `${replayTrafficPoints.length} archived traffic samples · ${officerId === 'all' ? 'all units' : 'selected unit'}`
      : `${replayPoints.length} GPS fixes · no traffic archive`;
    $('#reviewTrafficCount').className = `tag ${replayTrafficPoints.length ? 'green' : 'amber'}`;
    showReplay(0);
  } catch (error) {
    if (sequence !== reviewLoadSequence) return;
    $('#reviewTrafficCount').textContent = 'Could not load archived activity';
    $('#reviewTrafficCount').className = 'tag red';
    toast(`Day review could not load: ${error.message}`, true);
  }
}
function reviewAgeLabel(sampleAt, asOf) {
  const seconds = Math.max(0, Math.round((asOf - Date.parse(sampleAt)) / 1000));
  return seconds < 30 ? 'at replay time' : seconds < 90 ? '1 min before' : `${Math.floor(seconds / 60)} min before`;
}
function showReplay(i) {
  reviewTraffic?.clearLayers();
  reviewUnits?.clearLayers();
  const replayIndex = Math.max(0, Math.min(Math.floor(i), replayEvents.length - 1));
  if (replayIndex < reviewLastReplayIndex) {
    reviewPaths?.clearLayers();
    reviewTrailLayers.clear();
    reviewTrailCounts.clear();
  }
  const event = replayEvents[replayIndex];
  if (!event) {
    $('#replayTime').textContent = 'No recorded activity for this date';
    $('#reviewTrafficAsOf').textContent = 'No traffic at selected time';
    $('#reviewTrafficBadge').textContent = '0 sites';
    $('#reviewTrafficNow').innerHTML = '<div class="empty-state">No traffic snapshot is recorded for this date.</div>';
    $('#reviewPositionAsOf').textContent = 'No GPS fixes for selected time';
    $('#reviewPositionBadge').textContent = '0 units';
    $('#reviewPositionsNow').innerHTML =
      '<div class="empty-state">No recorded unit position is available on this date.</div>';
    return;
  }
  const ms = Date.parse(event.at),
    workSites = S.sites.filter((s) => s.areaType === 'work'),
    trafficRows = workSites.map((s) => {
      const samples = replayTrafficGroups.get(s.id) || [],
        count = replayUpperBound(samples, ms, 'at');
      return { site: s, reading: count ? samples[count - 1] : null };
    });
  for (const { site: s, reading: t } of trafficRows) {
    if (t) {
      const center = s.coordinates.reduce(
        (a, p) => [a[0] + p[0] / s.coordinates.length, a[1] + p[1] / s.coordinates.length],
        [0, 0],
      );
      L.circleMarker(center, {
        radius: 10,
        color: '#f2f4ff',
        weight: 2,
        fillColor: trafficColor(t.level),
        fillOpacity: 0.95,
      })
        .addTo(reviewTraffic)
        .bindTooltip(
          `${esc(s.name)} · ${esc(t.level)} · ${t.currentSpeed}/${t.freeFlowSpeed} km/h · site-centre sample recorded ${fmt(t.at)}`,
        );
    }
  }
  const positions = [],
    focusPoint = event.kind === 'position' ? event.point : null;
  for (const [oid, points] of replayPointGroups) {
    const count = replayUpperBound(points, ms, 'receivedAt');
    if (!count) continue;
    const p = points[count - 1],
      previousCount = reviewTrailCounts.get(oid) || 0;
    positions.push(p);
    let trail = reviewTrailLayers.get(oid);
    if (count > previousCount) {
      if (!trail && count > 1) {
        trail = L.polyline(
          points.slice(0, count).map((x) => [x.lat, x.lng]),
          { color: p.officer.color || '#8d90fa', weight: 3, opacity: 0.8 },
        ).addTo(reviewPaths);
        reviewTrailLayers.set(oid, trail);
      } else if (trail) {
        for (let n = previousCount; n < count; n++) trail.addLatLng([points[n].lat, points[n].lng]);
      }
      reviewTrailCounts.set(oid, count);
    }
  }
  positions.sort((a, b) => a.officer.callSign.localeCompare(b.officer.callSign));
  for (const p of positions) {
    const color = /^#[0-9a-f]{3,8}$/i.test(p.officer.color || '') ? p.officer.color : '#8589f5',
      selected = focusPoint?.officer.id === p.officer.id && focusPoint.eventId === p.eventId;
    L.circleMarker([p.lat, p.lng], {
      radius: selected ? 10 : 7,
      color: '#f2f4ff',
      weight: selected ? 3 : 2,
      fillColor: color,
      fillOpacity: 1,
    })
      .addTo(reviewUnits)
      .bindTooltip(
        `<b>${esc(p.officer.callSign)}</b><br>${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}<br>GPS ${fmt(p.receivedAt)} · ±${Math.round(p.accuracy || 0)} m`,
      );
  }
  const trafficAvailable = trafficRows.filter((x) => x.reading).length;
  $('#reviewTrafficAsOf').textContent =
    `As of ${fmt(event.at, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · latest reading per site`;
  $('#reviewTrafficBadge').textContent = `${trafficAvailable}/${workSites.length} sites`;
  $('#reviewTrafficBadge').className = `tag ${trafficAvailable ? 'green' : 'grey'}`;
  $('#reviewTrafficNow').innerHTML = trafficRows.length
    ? trafficRows
        .map(({ site: s, reading: t }) =>
          t
            ? `<div class="review-now-row ${event.kind === 'traffic' && event.traffic.id === t.id ? 'selected' : ''}"><span class="review-flow-dot" style="--flow-color:${trafficColor(t.level)}"></span><div class="review-now-copy"><b>${esc(s.name)}</b><small>${esc(t.level)} · ${fmt(t.at, { hour: '2-digit', minute: '2-digit' })} · ${reviewAgeLabel(t.at, ms)}</small></div><div class="review-flow-speed">${Math.round(t.currentSpeed)}<small>of ${Math.round(t.freeFlowSpeed)} km/h</small></div></div>`
            : `<div class="review-now-row no-reading"><span class="review-flow-dot"></span><div class="review-now-copy"><b>${esc(s.name)}</b><small>No traffic sample by this time</small></div><span class="review-no-sample">—</span></div>`,
        )
        .join('')
    : '<div class="empty-state">No work sites are configured.</div>';
  $('#reviewPositionAsOf').textContent =
    `As of ${fmt(event.at, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · last recorded fix per unit`;
  $('#reviewPositionBadge').textContent = `${positions.length} units`;
  $('#reviewPositionBadge').className = `tag ${positions.length ? 'green' : 'grey'}`;
  $('#reviewPositionsNow').innerHTML = positions.length
    ? positions
        .map((p) => {
          const color = /^#[0-9a-f]{3,8}$/i.test(p.officer.color || '') ? p.officer.color : '#8589f5';
          return `<div class="review-now-row ${focusPoint?.eventId === p.eventId ? 'selected' : ''}"><span class="review-unit-dot" style="--unit-color:${color}"></span><div class="review-now-copy"><b>${esc(p.officer.callSign)}</b><small>${fmt(p.receivedAt, { hour: '2-digit', minute: '2-digit' })} · ${reviewAgeLabel(p.receivedAt, ms)} · ±${Math.round(p.accuracy || 0)} m</small><code>${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}</code></div></div>`;
        })
        .join('')
    : '<div class="empty-state">No unit had a recorded GPS fix by this time.</div>';
  const eventText =
    event.kind === 'traffic'
      ? `Traffic · ${site(event.traffic.siteId)?.name || 'work site'} · ${event.traffic.level}`
      : `GPS · ${event.point.officer.callSign}`;
  $('#replayTime').textContent =
    `${fmt(event.at, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${eventText}`;
  reviewLastReplayIndex = replayIndex;
}

function insideSite(point, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1] || 1e-12) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
function reportsHtml() {
  return (
    header(
      'Reports & exports',
      'Operational records, audit history and downloadable reports.',
      '↓ Export CSV',
      'export-report',
    ) +
    `<div class="stat-grid" id="reportStats"></div><div class="content-card"><div class="toolbar"><select id="reportType" class="select"><option value="officers">Officer status</option><option value="alerts">Alert report</option><option value="locations">Location history</option><option value="traffic">Traffic snapshots</option><option value="messages">Message report</option><option value="calls">Call report</option><option value="sites">Sites</option><option value="audit">Audit log</option></select><input id="reportStart" type="date" class="input"><input id="reportEnd" type="date" class="input"><select id="reportGroup" class="select"><option value="all">All groups</option>${S.groups.map((g) => `<option>${esc(g)}</option>`).join('')}</select><button class="button primary small" data-action="run-report">Run report</button><span class="spacer"></span><button class="button ghost small" data-action="print">Print / PDF</button><button class="button ghost small" data-action="export-excel">Export Excel</button></div><div id="reportTable"></div></div><details class="workspace-disclosure"><summary><span><b>Audit trail</b><small>Sensitive actions and console activity</small></span><span class="disclosure-action">Show</span></summary><div class="workspace-disclosure-body"><div class="panel-heading"><a class="button ghost small" href="/api/export?type=audit">Download CSV</a></div><div id="auditTable"></div></div></details>`
  );
}
function renderReports() {
  const data = [
    ['Officers', S.officers.length],
    ['Alerts', S.alerts.length],
    ['Messages', S.messages.length],
    ['Locations', S.officers.reduce((n, o) => n + (o.historyCount || 0), 0)],
  ];
  $('#reportStats').innerHTML = data
    .map(([a, b]) => `<div class="stat-card"><div class="stat-top">${a}</div><div class="stat-number">${b}</div></div>`)
    .join('');
  $('#auditTable').innerHTML =
    `<div class="table-wrap" style="max-height:320px;overflow:auto"><table class="data-table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th></tr></thead><tbody>${S.audit
      .slice(0, 100)
      .map(
        (a) =>
          `<tr><td>${fmt(a.at, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.target)}</td></tr>`,
      )
      .join('')}</tbody></table></div>`;
  runReport();
}
let reportLoadSequence = 0;
async function runReport() {
  const table = $('#reportTable');
  if (!table) return;
  const sequence = ++reportLoadSequence,
    type = $('#reportType').value,
    from = $('#reportStart')?.value || '',
    to = $('#reportEnd')?.value || '';
  let rows = [];
  try {
    if (type === 'locations' || type === 'traffic') {
      const query = new URLSearchParams({ officerId: 'all' });
      if (from) query.set('from', from);
      if (to) query.set('to', to);
      const archive = await api(`/api/history?${query}`);
      if (sequence !== reportLoadSequence) return;
      rows =
        type === 'locations'
          ? archive.points.map((point) => ({
              unit: point.officer.callSign,
              latitude: point.lat,
              longitude: point.lng,
              accuracy: point.accuracy,
              received: point.receivedAt,
              phoneTime: point.phoneTime,
            }))
          : archive.traffic.map((sample) => ({
              site: site(sample.siteId)?.name,
              at: sample.at,
              currentSpeed: sample.currentSpeed,
              freeFlowSpeed: sample.freeFlowSpeed,
              ratio: sample.ratio,
              confidence: sample.confidence,
              level: sample.level,
              roadClosure: sample.roadClosure,
              provider: sample.provider,
            }));
    } else {
      rows =
        type === 'alerts'
          ? S.alerts.map((a) => ({
              type: a.type,
              alert: a.title,
              officer: officer(a.officerId)?.callSign || 'System',
              status: a.status,
              raised: a.raisedAt,
              taken: a.takenBy || '',
              handled: a.handledBy || '',
            }))
          : type === 'messages'
            ? S.messages.map((m) => ({
                from: m.from,
                to: officer(m.to)?.callSign || m.to,
                message: m.body,
                sent: m.createdAt,
                delivered: m.deliveredAt || 'queued',
              }))
            : type === 'calls'
              ? S.calls.map((c) => ({
                  type: c.type,
                  from: c.from,
                  to: c.to,
                  started: c.startedAt,
                  ended: c.endedAt || '',
                  status: c.status,
                }))
              : type === 'sites'
                ? S.sites.map((item) => ({
                    site: item.name,
                    type: item.areaType,
                    assigned: item.assigned?.map((id) => officer(id)?.callSign).join(', '),
                    tolerance: item.tolerance,
                  }))
                : type === 'audit'
                  ? S.audit.map((a) => ({ when: a.at, who: a.actor, action: a.action, target: a.target }))
                  : S.officers.map((o) => ({
                      terminal: o.callSign,
                      officer: o.name,
                      group: o.group,
                      status: status(o),
                      site: site(o.siteId)?.name || '',
                      online: o.online ? 'yes' : 'no',
                      battery: o.battery,
                      lastSeen: o.lastSeen,
                    }));
      if (type === 'officers' && $('#reportGroup').value !== 'all')
        rows = rows.filter((row) => row.group === $('#reportGroup').value);
      const timeKey = { officers: 'lastSeen', alerts: 'raised', messages: 'sent', calls: 'started', audit: 'when' }[
        type
      ];
      if (timeKey && (from || to))
        rows = rows.filter((row) => {
          const day = dateKey(row[timeKey]);
          return (!from || day >= from) && (!to || day <= to);
        });
    }
    if (sequence !== reportLoadSequence) return;
    currentReportRows = rows;
    table.innerHTML = rows.length
      ? `<div class="table-wrap"><table class="data-table"><thead><tr>${Object.keys(rows[0])
          .map((key) => `<th>${esc(key)}</th>`)
          .join('')}</tr></thead><tbody>${rows
          .slice(0, 400)
          .map(
            (row) =>
              `<tr>${Object.values(row)
                .map((value) => `<td>${esc(value)}</td>`)
                .join('')}</tr>`,
          )
          .join(
            '',
          )}</tbody></table></div><div class="panel-footer">${rows.length}${rows.length >= 20000 ? ' (showing a capped sample; narrow the date range for complete detail)' : ''} records · displaying up to 400 rows</div>`
      : '<div class="empty-state">No records for this report.</div>';
  } catch (error) {
    if (sequence === reportLoadSequence)
      table.innerHTML = `<div class="empty-state">Report could not load: ${esc(error.message)}</div>`;
  }
}
function passwordChangePanel() {
  return `<details class="workspace-disclosure"><summary><span><b>Change password</b><small>Confirm your current password and choose a new one</small></span><span class="disclosure-action">Update</span></summary><div class="workspace-disclosure-body"><form id="passwordChangeForm" class="password-change-form"><label class="form-field">Current password<input class="input" name="currentPassword" type="password" autocomplete="current-password" required></label><label class="form-field">New password<input class="input" name="newPassword" type="password" minlength="14" autocomplete="new-password" required></label><button class="button ghost small" type="submit">Change password</button></form><p class="form-help">Use at least 14 characters. Change any temporary password after first sign-in.</p></div></details>`;
}
function settingsHtml() {
  const s = S.settings;
  return (
    header(
      'System settings',
      'Manage Supabase-backed settings, access, field rules and retention.',
      'Save all changes',
      'save-settings',
    ) +
    `<div class="workspace-grid"><div class="content-card"><div class="panel-heading"><div><div class="panel-title">Live map & traffic</div><div class="panel-subtitle">Street, satellite and terrain basemaps load in the map; TomTom flow queries and traffic tiles are proxied by the Dispatch server.</div></div></div><form id="settingsForm" class="modal-body"><div class="form-grid"><div class="form-field full"><label>Company name</label><input class="input" name="company" value="${esc(s.company)}"></div><div class="form-field"><label>Map provider</label><select class="select" name="mapProvider"><option ${s.mapProvider === 'Esri World Street Map' ? 'selected' : ''}>Esri World Street Map</option><option ${s.mapProvider === 'OpenStreetMap' ? 'selected' : ''}>OpenStreetMap</option></select></div><div class="form-field"><label>Traffic provider</label><select class="select" name="trafficProvider"><option value="tomtom" ${s.trafficProvider === 'tomtom' ? 'selected' : ''}>TomTom Traffic</option><option value="here" ${s.trafficProvider === 'here' ? 'selected' : ''}>HERE Traffic (coming soon)</option></select></div><div class="form-field full"><label>TomTom API key</label><input class="input" name="trafficKey" type="password" autocomplete="off" value="" placeholder="${s.trafficKeyConfigured ? 'Configured server-side; leave blank to keep' : 'Free-tier key'}"><span class="form-help">Required for live flow data. The key remains server-side and is sent only by the server to TomTom. Leave blank to keep the existing key. Provider quotas and attribution apply.</span></div><div class="form-field"><label>Traffic layer default</label><select class="select" name="trafficEnabled"><option value="false" ${!s.trafficEnabled ? 'selected' : ''}>Off</option><option value="true" ${s.trafficEnabled ? 'selected' : ''}>On</option></select></div><div class="form-field"><label>Timezone</label><input class="input" name="timezone" value="${esc(s.timezone)}"></div></div></form></div><details class="workspace-disclosure"><summary><span><b>Field rules</b><small>Alerts, GPS accuracy, intervals and retention</small></span><span class="disclosure-action">Show</span></summary><div class="workspace-disclosure-body"><div class="modal-body"><div class="form-grid">${settingInput('Absence alert (minutes)', 'absenceMinutes', s.absenceMinutes)}${settingInput('Offline after (minutes)', 'offlineMinutes', s.offlineMinutes)}${settingInput('Good GPS accuracy (m)', 'gpsAccuracy', s.gpsAccuracy)}${settingInput('Consecutive readings', 'geofenceReadings', s.geofenceReadings)}${settingInput('Location interval (sec)', 'locationInterval', s.locationInterval)}${settingInput('SOS escalation (minutes)', 'sosEscalationMinutes', s.sosEscalationMinutes)}${settingInput('Speed alarm (km/h)', 'speedLimit', s.speedLimit)}${settingInput('Data retention (days)', 'retentionDays', s.retentionDays)}${settingInput('Supervisor contact', 'supervisor', s.supervisor || '', 'text')}</div></div></div></details><details class="workspace-disclosure"><summary><span><b>Backup options</b><small>Hourly full-system snapshots stored in Supabase</small></span><span class="disclosure-action">Show</span></summary><div class="workspace-disclosure-body"><div class="modal-body"><div class="form-grid"><div class="form-field"><label>Automatic backups</label><div class="form-help" style="padding:10px 0">Full-system snapshot every hour</div></div>${settingInput('Backup retention count', 'backupRetention', s.backupRetention)}</div></div></div></details><details class="workspace-disclosure"><summary><span><b>Backups & recovery</b><small>Snapshots stored in Supabase</small></span><span class="disclosure-action">Show</span></summary><div class="workspace-disclosure-body"><div class="toolbar"><button class="button primary small" data-action="backup">＋ Create backup</button></div><div id="backupTable"></div></div></details>${passwordChangePanel()}<details class="workspace-disclosure workspace-full"><summary><span><b>Unit accounts & access</b><small>Provision operators or a field login locked to one unit</small></span><span class="disclosure-action">Manage</span></summary><div class="workspace-disclosure-body"><form id="userCreateForm" class="user-create-form"><label class="form-field">Name<input class="input" name="name" autocomplete="off" required></label><label class="form-field">Email<input class="input" name="email" type="email" autocomplete="off" required></label><label class="form-field">Temporary password<input class="input" name="password" type="password" minlength="14" autocomplete="new-password" required></label><label class="form-field">Account type<select id="userRole" class="select" name="role"><option value="operator">Control-room operator</option><option value="field">Field unit login</option></select></label><label id="unitLoginOfficerWrap" class="form-field" hidden>Assigned unit<select id="unitLoginOfficer" class="select" name="officerId">${S.officers.map((unit) => `<option value="${esc(unit.id)}">${esc(unit.callSign)} · ${esc(unit.name)}</option>`).join('')}</select></label><button class="button primary small" type="submit">Create login</button></form><p class="form-help">${s.unitSchemaReady ? 'RLS and the indexed GPS archive are ready.' : 'To activate per-unit row-level security and the fast GPS archive, run the current supabase/schema.sql once in Supabase SQL Editor. Existing GPS history remains preserved until that migration is applied.'}</p><p class="form-help">Field logins can read and update only their assigned unit. Unit state and GPS archive reads are protected by Supabase row-level security; the server also checks every action. Passwords are never stored in Dispatch state. Share temporary passwords privately and ask users to change them after sign-in.</p><div id="userTable"></div></div></details><details class="workspace-disclosure workspace-full"><summary><span><b>Local deployment & safety</b><small>Network binding and data persistence</small></span><span class="disclosure-action">Show</span></summary><div class="workspace-disclosure-body"><div class="detail-list"><div class="detail-row"><span>Bind address</span><b>0.0.0.0:${location.port || 3000}</b></div><div class="detail-row"><span>Data persistence</span><b>Supabase Postgres · server-only access</b></div><div class="detail-row"><span>External service calls</span><b>Esri/OSM / configured traffic maps only</b></div></div><div class="panel-footer">Use HTTPS behind a trusted reverse proxy. The Supabase service-role key stays on the server.</div></div></details></div>`
  );
}
function settingInput(label, name, value, type = 'number') {
  return `<div class="form-field"><label>${label}</label><input class="input setting-field" name="${name}" type="${type}" value="${esc(value)}"></div>`;
}
async function renderBackups() {
  try {
    let rows = await api('/api/backups');
    $('#backupTable').innerHTML = rows.length
      ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Backup file</th><th>Created</th><th>Size</th><th></th></tr></thead><tbody>${rows.map((b) => `<tr><td><b>${esc(b.file)}</b></td><td>${fmt(b.modifiedAt, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td><td>${Math.ceil(b.size / 1024)} KB</td><td><button class="mini-action" data-action="restore" data-file="${esc(b.file)}">Restore</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty-state">No backups yet.</div>';
  } catch {}
}
async function renderUsers() {
  try {
    const d = await api('/api/auth/users'),
      rows = d.users || [];
    $('#userTable').innerHTML = rows.length
      ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Account</th><th>Access scope</th><th>State</th><th></th></tr></thead><tbody>${rows.map((u) => `<tr><td><b>${esc(u.name || u.email)}</b><br>${esc(u.email)}</td><td>${u.role === 'field' ? `Field · ${esc(u.unit || 'Unassigned')}` : 'Control room · full operations'}</td><td>Provisioned</td><td>${u.role === 'field' ? `<button class="button ghost small" data-action="delete-unit-login" data-id="${esc(u.id)}" data-name="${esc(u.email)}">Revoke login</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty-state">No accounts found.</div>';
  } catch (e) {
    const n = $('#userTable');
    if (n) n.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
  }
}
function fieldHtml() {
  const f = officer(fieldId) || S.officers[0];
  if (!f) return header('Field radio', 'No terminals exist.', '＋ Add officer', 'add-officer');
  fieldId = f.id;
  const voice = [...rtcSessions.values()].find(
    (s) => (s.role === 'callee' && s.fieldMic) || (s.role === 'caller' && currentPage === 'field'),
  );
  return `<section class="page-head"><div><div class="eyebrow">LIVE FIELD TERMINAL <span class="live-pill"><i></i> ${f.online ? 'CONNECTED' : 'OFFLINE'}</span></div><h1>Field radio</h1><p>Mobile-friendly officer controls · authenticated access required.</p></div><div class="head-actions"><select id="fieldOfficer" class="select">${S.officers.map((o) => `<option value="${o.id}" ${o.id === f.id ? 'selected' : ''}>${esc(o.callSign)} · ${esc(o.name)}</option>`).join('')}</select></div></section><div class="workspace-grid"><div class="content-card"><div class="panel-heading"><div><div class="panel-title" id="fieldIdentity">${esc(f.callSign)} · ${esc(f.name)}</div><div class="panel-subtitle" id="fieldPostStatus">${esc(site(f.siteId)?.name || 'No assigned post')} · ${status(f)}</div></div><span class="tag ${cls(f)}" id="fieldStatusTag">${esc(status(f))}</span></div><div class="modal-body"><div class="kv-grid"><div class="kv-card"><small>Shift</small><b id="fieldShiftValue" style="font-size:14px">${f.shiftId ? 'Clocked in' : 'Off duty'}</b></div><div class="kv-card"><small>Battery</small><b id="fieldBatteryValue">${batteryLabel(f.battery)}</b></div><div class="kv-card"><small>GPS accuracy</small><b id="fieldAccuracyValue">±${f.accuracy || '—'}m</b></div></div><div class="toolbar" style="border:0;padding:10px 0"><button class="button ${f.shiftId ? 'ghost' : 'primary'}" data-action="field-clock">${f.shiftId ? 'Clock out' : 'Clock in'}</button><button class="button danger" data-action="field-sos" ${!f.shiftId || f.stunned ? 'disabled' : ''}>⚠ SOS</button><button class="button ghost" data-action="field-gps" ${!f.shiftId || f.stunned ? 'disabled' : ''}>⌖ Share location</button><button class="button ghost" data-action="field-ptt" ${!f.shiftId || f.stunned ? 'disabled' : ''}>◖ ${voice ? (voice.stream?.getAudioTracks()?.[0]?.enabled ? 'Mute mic' : 'Push to talk') : 'Call control'}</button>${voice ? `<button class="button danger" data-action="voice-end" data-id="${esc(voice.callId)}">End voice</button>` : ''}</div><div class="panel-footer">Location tracking runs only while clocked in. Grant browser location permission to share GPS. SOS queues locally when disconnected.</div></div></div><div class="content-card"><div class="panel-heading"><div><div class="panel-title">My messages</div><div class="panel-subtitle">Private dispatch messages for this terminal</div></div></div><div id="fieldMessages" class="detail-list"></div><div class="toolbar"><textarea id="fieldReply" class="textarea" placeholder="Message control room…" ${!f.shiftId || f.stunned ? 'disabled' : ''}></textarea><button class="button primary small" data-action="field-reply" ${!f.shiftId || f.stunned ? 'disabled' : ''}>Send</button></div></div><div class="content-card workspace-full"><div class="panel-heading"><div><div class="panel-title">Radio controls</div><div class="panel-subtitle" id="fieldGroupInterval">Group · ${esc(f.group)} · Location interval ${f.config?.locationInterval || S.settings.locationInterval}s</div></div><button class="button ghost small" data-action="field-break" ${!f.shiftId ? 'disabled' : ''}>${f.status === 'on-break' ? 'End break' : 'Start break'}</button></div><div class="detail-list"><div class="detail-row"><span>Connection</span><b id="fieldConnection">${navigator.onLine ? 'Online' : 'Offline'} · last contact ${ago(f.lastSeen)}</b></div><div class="detail-row"><span>Device state</span><b id="fieldDeviceState">${f.stunned ? 'Radio stunned — transmit disabled' : 'Ready'}</b></div><div class="detail-row"><span>Queued offline events</span><b id="fieldPendingEvents">${pendingEvents().length}</b></div></div></div></div>`;
}
function syncFieldLifecycle(f) {
  const active = Boolean(f?.shiftId && !f.stunned),
    key = `${f?.id || ''}:${active}`;
  if (key !== fieldGpsLifecycleKey) {
    fieldGpsLifecycleKey = key;
    if (active) startGPS();
    else stopGPS();
  }
  if (!active && rtcSessions.size)
    for (const cid of [...rtcSessions.keys()]) {
      endVoiceCall(cid, true);
      api('/api/action', { method: 'POST', body: JSON.stringify({ type: 'call-end', id: cid }) }).catch(() => {});
    }
}
function refreshFieldPage() {
  const f = officer(fieldId);
  if (!f) return;
  syncFieldLifecycle(f);
  const put = (selector, value) => {
    const node = $(selector);
    if (node && node.textContent !== String(value)) node.textContent = String(value);
  };
  put('#fieldIdentity', `${f.callSign} · ${f.name}`);
  put('#fieldPostStatus', `${site(f.siteId)?.name || 'No assigned post'} · ${status(f)}`);
  const statusTag = $('#fieldStatusTag');
  if (statusTag) {
    statusTag.textContent = status(f);
    statusTag.className = `tag ${cls(f)}`;
  }
  put('#fieldShiftValue', f.shiftId ? 'Clocked in' : 'Off duty');
  put('#fieldBatteryValue', `${batteryLabel(f.battery)}`);
  put('#fieldAccuracyValue', `±${f.accuracy || '—'}m`);
  put(
    '#fieldGroupInterval',
    `Group · ${f.group} · Location interval ${f.config?.locationInterval || S.settings.locationInterval}s`,
  );
  put('#fieldConnection', `${navigator.onLine ? 'Online' : 'Offline'} · last contact ${ago(f.lastSeen)}`);
  put('#fieldDeviceState', f.stunned ? 'Radio stunned — transmit disabled' : 'Ready');
  put('#fieldPendingEvents', pendingEvents().length);
  const select = $('#fieldOfficer');
  if (select) {
    const options = S.officers
      .map(
        (o) =>
          `<option value="${esc(o.id)}" ${o.id === f.id ? 'selected' : ''}>${esc(o.callSign)} · ${esc(o.name)}</option>`,
      )
      .join('');
    if (select.innerHTML !== options) select.innerHTML = options;
  }
  const disabled = !f.shiftId || f.stunned;
  for (const actionName of ['field-sos', 'field-gps', 'field-ptt', 'field-reply']) {
    const node = $(`[data-action="${actionName}"]`);
    if (node) node.disabled = disabled;
  }
  const reply = $('#fieldReply');
  if (reply) reply.disabled = disabled;
  const clock = $('[data-action="field-clock"]');
  if (clock) {
    clock.textContent = f.shiftId ? 'Clock out' : 'Clock in';
    clock.className = `button ${f.shiftId ? 'ghost' : 'primary'}`;
  }
  const br = $('[data-action="field-break"]');
  if (br) {
    br.textContent = f.status === 'on-break' ? 'End break' : 'Start break';
    br.disabled = !f.shiftId;
  }
  const ms = S.messages.filter((m) => m.to === f.id || (m.to === 'all' && (!m.group || m.group === f.group)));
  const node = $('#fieldMessages');
  if (node)
    node.innerHTML = ms.length
      ? ms
          .slice(0, 12)
          .map(
            (m) =>
              `<div class="detail-row"><span><b>${esc(m.from)}</b><small style="display:block;color:#87928b;margin-top:4px">${esc(m.body)}</small></span><b>${m.deliveredAt ? 'Received' : 'Queued'}<small style="display:block;color:#87928b;margin-top:4px">${fmt(m.createdAt)}</small></b></div>`,
          )
          .join('')
      : '<div class="empty-state">No messages</div>';
}
function renderField() {
  const select = $('#fieldOfficer');
  if (select)
    select.onchange = (e) => {
      stopGPS();
      lastLocationPush = 0;
      fieldId = e.target.value;
      renderPage();
      rtcRegister().catch(() => {});
    };
  refreshFieldPage();
}
function pendingEvents() {
  try {
    return JSON.parse(localStorage.getItem('dispatchQueue') || '[]');
  } catch {
    return [];
  }
}
function queueEvent(event) {
  const q = pendingEvents();
  q.push(event);
  localStorage.setItem('dispatchQueue', JSON.stringify(q));
  flushQueue();
}

function getVoicePeerId() {
  if (rtcPeerId) return rtcPeerId;
  try {
    rtcPeerId = sessionStorage.getItem('dispatchVoicePeer') || '';
    if (!rtcPeerId) {
      rtcPeerId = crypto.randomUUID();
      sessionStorage.setItem('dispatchVoicePeer', rtcPeerId);
    }
  } catch {
    rtcPeerId = `peer-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }
  return rtcPeerId;
}
async function rtcRegister() {
  if (!S) return;
  const role = currentPage === 'field' ? 'field' : 'control',
    f = role === 'field' ? officer(fieldId) : null;
  return api('/api/rtc/register', {
    method: 'POST',
    body: JSON.stringify({
      peerId: getVoicePeerId(),
      role,
      officerId: f?.id,
      label: f?.callSign || 'Dispatch control',
    }),
  });
}
function clearAnsweredIncomingOffers() {
  for (const [key, message] of [...rtcPendingOffers]) {
    const call = S.calls.find((c) => c.id === message.callId);
    if (call?.status === 'active' && call.to === 'control' && call.answeredBy && call.answeredBy !== getVoicePeerId()) {
      rtcPendingOffers.delete(key);
      if ($('#modalRoot').dataset.incomingCallId === message.callId) {
        $('#modalRoot').innerHTML = '';
        delete $('#modalRoot').dataset.incomingCallId;
      }
    }
  }
}
function startRtcAgent() {
  if (rtcPollTimer) return;
  rtcHeartbeat();
  rtcPollTimer = setInterval(rtcHeartbeat, 1000);
}
function stopRtcAgent() {
  if (rtcPollTimer) clearInterval(rtcPollTimer);
  rtcPollTimer = null;
  for (const callId of [...rtcSessions.keys()]) closeVoiceCall(callId, false).catch(() => {});
  rtcPendingOffers.clear();
  rtcPendingIce.clear();
  pendingFieldCalls.clear();
}
function stopDashboardTimers() {
  for (const timer of [pollTimer, clockTimer, trafficTimer]) if (timer) clearInterval(timer);
  pollTimer = clockTimer = trafficTimer = null;
  stopRtcAgent();
}
// Registering is a state write (it takes the server's database lock), so it runs at the peer TTL
// rate instead of once per poll. Polling stays at 1 Hz for call signalling, and slows to 1 per 5s
// in a hidden tab so background consoles do not hammer the database.
let rtcRegisteredAt = 0;
async function rtcHeartbeat() {
  if (rtcPollBusy || !S || Date.now() < rtcRetryAt) return;
  if (document.hidden && !rtcSessions.size && Date.now() - rtcRegisteredAt < 5000) return;
  rtcPollBusy = true;
  try {
    if (document.hidden || Date.now() - rtcRegisteredAt >= 10000) {
      await rtcRegister();
      rtcRegisteredAt = Date.now();
    }
    const d = await api(`/api/rtc/poll?peer=${encodeURIComponent(getVoicePeerId())}`);
    rtcFailureCount = 0;
    rtcRetryAt = 0;
    for (const m of d.messages || []) await handleVoiceSignal(m);
    await retryPendingFieldCalls();
  } catch (error) {
    rtcFailureCount++;
    const delay = Math.min(8000, 1000 * 2 ** Math.min(rtcFailureCount - 1, 3));
    rtcRetryAt = Date.now() + delay;
    if (error.status === 401 && rtcPollTimer) {
      clearInterval(rtcPollTimer);
      rtcPollTimer = null;
    }
    if (rtcFailureCount === 1)
      window.DispatchDiagnostics?.record(
        'voice.signaling.unavailable',
        { status: error.status || 0, reason: String(error.message || '').slice(0, 100) },
        'warning',
      );
  } finally {
    rtcPollBusy = false;
  }
}
async function sendVoiceSignal(toPeer, callId, type, payload = {}) {
  return api('/api/rtc/signal', {
    method: 'POST',
    body: JSON.stringify({ fromPeer: getVoicePeerId(), toPeer, callId, type, payload }),
  });
}
function makeVoicePeer(session, remote) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }),
    conn = { peer: remote, pc, ready: false, localIce: [], remoteIce: [] };
  session.connections.set(remote.peerId, conn);
  if (session.stream) for (const track of session.stream.getTracks()) pc.addTrack(track, session.stream);
  else if (session.receiveOnly) pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    if (conn.ready) sendVoiceSignal(remote.peerId, session.callId, 'ice', { candidate: e.candidate }).catch(() => {});
    else conn.localIce.push(e.candidate);
  };
  pc.ontrack = (e) => {
    let audio = session.audioEls.get(remote.peerId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      audio.setAttribute('aria-label', 'Live dispatch audio');
      audio.style.cssText =
        'position:fixed;width:1px;height:1px;opacity:.01;pointer-events:none;left:-10px;bottom:-10px';
      document.body.append(audio);
      session.audioEls.set(remote.peerId, audio);
    }
    audio.srcObject = e.streams[0] || new MediaStream([e.track]);
    audio.play().catch(() => toast('Tap the page once to enable incoming audio.', true));
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      toast(`Voice linked · ${remote.label || 'terminal'}`);
      const call = S.calls.find((c) => c.id === session.callId);
      if (call && currentPage === 'calls') renderCalls();
    } else if (pc.connectionState === 'failed') {
      toast('Voice link failed. Use localhost/HTTPS, permit the microphone, and check peer connectivity.', true);
    }
  };
  return conn;
}
async function startLiveVoiceCall(callId, peers, options = {}) {
  if (!window.RTCPeerConnection || (!options.receiveOnly && !navigator.mediaDevices?.getUserMedia))
    throw Error('Live voice requires WebRTC and microphone permission in a secure browser context.');
  const stream = options.receiveOnly
      ? null
      : await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }),
    session = {
      callId,
      role: 'caller',
      stream,
      receiveOnly: Boolean(options.receiveOnly),
      connections: new Map(),
      audioEls: new Map(),
    };
  rtcSessions.set(callId, session);
  try {
    for (const peer of peers) {
      const conn = makeVoicePeer(session, peer);
      conn.pc._dispatchCallId = callId;
      const offer = await conn.pc.createOffer();
      await conn.pc.setLocalDescription(offer);
      await sendVoiceSignal(peer.peerId, callId, 'offer', {
        description: conn.pc.localDescription,
        fromLabel: currentPage === 'field' ? officer(fieldId)?.callSign || 'Field unit' : 'Dispatch control',
        channel: Number(options.channel || 1),
        participant: currentPage === 'field' ? fieldId : 'control',
        receiveOnly: Boolean(session.receiveOnly),
      });
      conn.ready = true;
      const candidates = conn.localIce.splice(0);
      for (const c of candidates) await sendVoiceSignal(peer.peerId, callId, 'ice', { candidate: c });
    }
    setTimeout(async () => {
      const call = S?.calls.find((c) => c.id === callId);
      if (call?.status === 'ringing' && rtcSessions.has(callId)) {
        await closeVoiceCall(callId, true);
        await api('/api/action', {
          method: 'POST',
          body: JSON.stringify({ type: 'call-fail', id: callId, reason: 'No answer after 60 seconds' }),
        }).catch(() => {});
        await refresh();
        toast('No answer · voice call ended', true);
      }
    }, 60000);
    return session;
  } catch (e) {
    await closeVoiceCall(callId, false);
    throw e;
  }
}
async function acceptLiveVoiceOffer(message) {
  const { callId, fromPeer, payload } = message;
  if (!navigator.mediaDevices?.getUserMedia)
    throw Error('Microphone unavailable. Use localhost/HTTPS and allow microphone access.');
  const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }),
    session = {
      callId,
      role: 'callee',
      stream,
      connections: new Map(),
      audioEls: new Map(),
      fieldMic: currentPage === 'field',
    };
  rtcSessions.set(callId, session);
  const remote = { peerId: fromPeer, label: payload.fromLabel || 'Dispatch control' },
    conn = makeVoicePeer(session, remote);
  conn.pc._dispatchCallId = callId;
  await conn.pc.setRemoteDescription(new RTCSessionDescription(payload.description));
  if (session.fieldMic && !payload.receiveOnly) stream.getAudioTracks().forEach((t) => (t.enabled = false));
  const pending = rtcPendingIce.get(`${callId}:${fromPeer}`) || [];
  rtcPendingIce.delete(`${callId}:${fromPeer}`);
  for (const c of pending)
    try {
      await conn.pc.addIceCandidate(new RTCIceCandidate(c));
    } catch {}
  const participant = currentPage === 'field' ? fieldId : getVoicePeerId(),
    claim = await action('call-answer', { id: callId, participant });
  if (claim?.accepted === false) {
    await closeVoiceCall(callId, false);
    sendVoiceSignal(fromPeer, callId, 'reject', { reason: 'another-controller-answered' }).catch(() => {});
    throw Error(
      claim.reason === 'another-controller-answered'
        ? 'Another control-room operator answered first.'
        : 'This call is no longer active.',
    );
  }
  const answer = await conn.pc.createAnswer();
  await conn.pc.setLocalDescription(answer);
  await sendVoiceSignal(fromPeer, callId, 'answer', {
    description: conn.pc.localDescription,
    participant,
    label: currentPage === 'field' ? officer(fieldId)?.callSign || 'Field unit' : 'Dispatch control',
  });
  conn.ready = true;
  for (const c of conn.localIce.splice(0)) await sendVoiceSignal(fromPeer, callId, 'ice', { candidate: c });
  toast('Live voice channel connected.');
}
async function handleVoiceSignal(m) {
  const key = `${m.callId}:${m.fromPeer}`;
  if (m.type === 'offer') {
    if (rtcPendingOffers.has(key) || rtcSessions.has(m.callId)) return;
    rtcPendingOffers.set(key, m);
    openModal(
      'Incoming live voice call',
      `<p><b>${esc(m.payload.fromLabel || 'Dispatch control')}</b> is calling on channel ${esc(m.payload.channel || 1)}.</p><p class="form-help">This is a live browser audio link. Allow microphone access to answer. Audio is not recorded unless you separately start a recording.</p><button type="button" class="button ghost" data-action="voice-decline" data-id="${esc(m.callId)}" data-peer="${esc(m.fromPeer)}">Decline call</button>`,
      'Accept call',
      async () => {
        try {
          await acceptLiveVoiceOffer(m);
          rtcPendingOffers.delete(key);
          $('#modalRoot').innerHTML = '';
        } catch (e) {
          rtcPendingOffers.delete(key);
          toast(`Could not answer: ${e.message}`, true);
        }
      },
    );
    $('#modalRoot').dataset.incomingCallId = m.callId;
    return;
  }
  if (m.type === 'answer') {
    const session = rtcSessions.get(m.callId),
      conn = session?.connections.get(m.fromPeer);
    if (!conn) return;
    await conn.pc.setRemoteDescription(new RTCSessionDescription(m.payload.description));
    const queued = conn.remoteIce.splice(0);
    for (const c of queued)
      try {
        await conn.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch {}
    const claim = await action('call-answer', { id: m.callId, participant: m.payload.participant || m.fromPeer });
    if (claim?.accepted === false) {
      sendVoiceSignal(m.fromPeer, m.callId, 'reject', { reason: 'another-controller-answered' }).catch(() => {});
      conn.pc.close();
      session.connections.delete(m.fromPeer);
    }
    return;
  }
  if (m.type === 'ice') {
    const conn = rtcSessions.get(m.callId)?.connections.get(m.fromPeer);
    if (!conn) {
      const list = rtcPendingIce.get(key) || [];
      list.push(m.payload.candidate);
      rtcPendingIce.set(key, list);
      return;
    }
    if (conn.pc.remoteDescription)
      try {
        await conn.pc.addIceCandidate(new RTCIceCandidate(m.payload.candidate));
      } catch {}
    else conn.remoteIce.push(m.payload.candidate);
    return;
  }
  if (m.type === 'reject') {
    const s = rtcSessions.get(m.callId);
    if (s) {
      const c = s.connections.get(m.fromPeer);
      c?.pc.close();
      s.connections.delete(m.fromPeer);
      const call = S.calls.find((c) => c.id === m.callId);
      if (!s.connections.size && call?.status === 'ringing') {
        await closeVoiceCall(m.callId, false);
        await api('/api/action', {
          method: 'POST',
          body: JSON.stringify({ type: 'call-fail', id: m.callId, reason: 'Recipient declined the call' }),
        });
        await refresh();
      }
    }
    if (m.payload?.reason !== 'another-controller-answered') toast('Call declined by recipient', true);
    return;
  }
  if (m.type === 'hangup') {
    if (rtcPendingOffers.has(key)) {
      rtcPendingOffers.delete(key);
      $('#modalRoot').innerHTML = '';
    }
    await closeVoiceCall(m.callId, false);
    try {
      await action('call-end', { id: m.callId });
    } catch {}
    toast('Remote party ended the voice call.');
  }
}
async function closeVoiceCall(callId, notify = true) {
  const session = rtcSessions.get(callId);
  if (session) {
    if (notify)
      for (const conn of session.connections.values())
        sendVoiceSignal(conn.peer.peerId, callId, 'hangup', {}).catch(() => {});
    for (const conn of session.connections.values()) conn.pc.close();
    for (const a of session.audioEls.values()) {
      a.pause();
      a.srcObject = null;
      a.remove();
    }
    session.stream?.getTracks().forEach((t) => t.stop());
    rtcSessions.delete(callId);
  }
  for (const key of [...rtcPendingIce.keys()]) if (key.startsWith(`${callId}:`)) rtcPendingIce.delete(key);
  for (const key of [...rtcPendingOffers.keys()]) if (key.startsWith(`${callId}:`)) rtcPendingOffers.delete(key);
}
async function failPendingFieldCall(callId, reason) {
  pendingFieldCalls.delete(callId);
  await api('/api/action', { method: 'POST', body: JSON.stringify({ type: 'call-fail', id: callId, reason }) }).catch(
    () => {},
  );
  await refresh();
}
async function retryPendingFieldCalls() {
  if (currentPage !== 'field') return;
  for (const [callId, pending] of [...pendingFieldCalls]) {
    const call = S.calls.find((c) => c.id === callId);
    if (!call || call.status !== 'ringing') {
      pendingFieldCalls.delete(callId);
      continue;
    }
    if (Date.now() >= pending.expiresAt) {
      await failPendingFieldCall(callId, 'No control-room endpoint answered');
      toast('No controller answered the call. SOS/location alerts remain active.', true);
      continue;
    }
    try {
      const result = await api(`/api/rtc/peers?role=control&exclude=${encodeURIComponent(getVoicePeerId())}`),
        peers = result.peers || [];
      if (!peers.length) continue;
      pendingFieldCalls.delete(callId);
      startLiveVoiceCall(callId, peers, { channel: pending.channel })
        .then(() => toast('Control room is being rung. The first controller to answer will take the call.'))
        .catch(async (error) => {
          await failPendingFieldCall(callId, error.message);
          toast(`Could not connect the call: ${error.message}`, true);
        });
    } catch {}
  }
}
async function startFieldVoiceCall() {
  if ([...pendingFieldCalls.values()].some((call) => call.officerId === fieldId)) return;
  const call = officer(fieldId);
  if (!call?.shiftId || call.stunned) throw Error('This terminal is not active.');
  const channel = 1,
    d = await action('call-start', {
      callType: 'intercom',
      from: call.callSign || 'Field unit',
      to: 'control',
      participantIds: [fieldId],
      channel,
      live: true,
    });
  pendingFieldCalls.set(d.call, { officerId: fieldId, channel, expiresAt: Date.now() + 90000 });
  try {
    const result = await api(`/api/rtc/peers?role=control&exclude=${encodeURIComponent(getVoicePeerId())}`),
      peers = result.peers || [];
    if (peers.length) {
      pendingFieldCalls.delete(d.call);
      try {
        await startLiveVoiceCall(d.call, peers, { channel });
        return true;
      } catch (error) {
        await failPendingFieldCall(d.call, error.message);
        throw error;
      }
    }
  } catch (error) {
    if (!pendingFieldCalls.has(d.call)) throw error;
  }
  return false;
}

async function requestRemoteVoiceMonitor(officerId) {
  const unit = officer(officerId);
  if (!unit?.shiftId || unit.stunned) throw Error('Selected terminal is not clocked in and available.');
  const result = await api(
    `/api/rtc/peers?officerId=${encodeURIComponent(officerId)}&exclude=${encodeURIComponent(getVoicePeerId())}`,
  );
  if (!result.peers?.length) throw Error('No active Field app is connected for this terminal.');
  const d = await action('call-start', {
    callType: 'monitor',
    from: 'Control room',
    to: unit.id,
    participantIds: [unit.id],
    live: true,
  });
  try {
    await startLiveVoiceCall(d.call, result.peers, { receiveOnly: true });
    toast(`Remote voice request sent to ${unit.callSign}; it must be accepted on the Field app.`);
  } catch (e) {
    await api('/api/action', {
      method: 'POST',
      body: JSON.stringify({ type: 'call-fail', id: d.call, reason: e.message }),
    });
    await refresh();
    throw e;
  }
}
async function togglePushToTalk() {
  if (currentPage === 'field') {
    const f = officer(fieldId);
    if (!f?.shiftId || f.stunned) return toast('Clock in and be active before using voice', true);
  }
  if ([...pendingFieldCalls.values()].some((call) => call.officerId === fieldId)) {
    toast('Your call is already ringing; waiting for a controller to answer.');
    return;
  }
  let session =
    [...rtcSessions.values()].find((x) => x.role === 'callee' && x.fieldMic) ||
    [...rtcSessions.values()].find((x) => x.role === 'caller' && currentPage === 'field');
  if (!session) {
    try {
      const connected = await startFieldVoiceCall();
      toast(
        connected
          ? 'Calling control room. A controller can answer now.'
          : 'Call placed. Waiting for a controller; no setup is needed on their side.',
      );
    } catch (e) {
      toast(e.message, true);
    }
    return;
  }
  const tracks = session.stream?.getAudioTracks() || [];
  if (!tracks.length) return toast('No microphone track is active', true);
  const enabled = !tracks[0].enabled;
  tracks.forEach((t) => (t.enabled = enabled));
  const btn = $('#pageContent [data-action="field-ptt"]');
  if (btn) btn.innerHTML = `◖ ${enabled ? 'Mute mic' : 'Push to talk'}`;
  toast(enabled ? 'Push-to-talk microphone open' : 'Push-to-talk microphone muted');
}
async function endVoiceCall(callId, notify = true) {
  await closeVoiceCall(callId, notify);
}
async function flushQueue() {
  if (!navigator.onLine) return;
  let q = pendingEvents();
  while (q.length) {
    const e = q[0];
    try {
      if (e.kind === 'location') await api('/api/ingest/location', { method: 'POST', body: JSON.stringify(e.payload) });
      else await api('/api/action', { method: 'POST', body: JSON.stringify(e.payload) });
      q.shift();
      localStorage.setItem('dispatchQueue', JSON.stringify(q));
    } catch {
      return;
    }
  }
  refresh();
}
function clearLocationError() {
  lastGpsErrorCode = 0;
  lastGpsErrorAt = 0;
}
function reportLocationError(error) {
  const code = Number(error?.code) || 0,
    nowMs = Date.now();
  if (code === lastGpsErrorCode && nowMs - lastGpsErrorAt < 120000) return;
  lastGpsErrorCode = code;
  lastGpsErrorAt = nowMs;
  window.DispatchDiagnostics?.record(
    'location.error',
    { source: 'geolocation', code, message: String(error?.message || '').slice(0, 120) },
    code === 1 ? 'warning' : 'info',
  );
  const message =
    code === 1
      ? 'Location permission is blocked. Allow location in browser or app settings, then retry.'
      : code === 2
        ? 'Location is temporarily unavailable. Check device location services or GPS signal; tracking will retry.'
        : code === 3
          ? 'No GPS fix arrived before the timeout. This can happen indoors or with a weak signal; tracking will retry.'
          : `Location unavailable${error?.message ? `: ${error.message}` : ''}.`;
  toast(message, true);
}
function startGPS() {
  if (window.DispatchNative?.startTracking) {
    const f = officer(fieldId);
    if (f?.shiftId && !f.stunned)
      window.DispatchNative.startTracking(
        f.id,
        Number(f.config?.locationInterval || S.settings.locationInterval || 15),
      );
    return;
  }
  if (gpsWatch !== null || !navigator.geolocation) return;
  gpsWatch = navigator.geolocation.watchPosition(
    (pos) => {
      clearLocationError();
      const f = officer(fieldId);
      if (!f?.shiftId) return;
      const interval = Number(f.config?.locationInterval || S.settings.locationInterval || 15) * 1000;
      if (Date.now() - lastLocationPush < interval) return;
      lastLocationPush = Date.now();
      const payload = {
        officerId: f.id,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: new Date().toISOString(),
        eventId: `${f.id}-${pos.timestamp}`,
      };
      queueEvent({ kind: 'location', payload });
    },
    (e) => {
      if (Number(e?.code) === 1 && gpsWatch !== null) {
        navigator.geolocation.clearWatch(gpsWatch);
        gpsWatch = null;
      }
      reportLocationError(e);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
  );
  toast('Location sharing active while clocked in.');
}
function stopGPS() {
  window.DispatchNative?.stopTracking?.();
  if (gpsWatch !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(gpsWatch);
    gpsWatch = null;
  }
}
function openModal(title, body, submit = 'Save', fn) {
  closeBoundaryEditor();
  const root = $('#modalRoot');
  delete root.dataset.incomingCallId;
  root.innerHTML = `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><h2>${title}</h2><button class="modal-close" data-close>×</button></div><form id="modalForm"><div class="modal-body">${body}</div><div class="modal-foot"><button type="button" class="button ghost" data-close>Cancel</button>${fn ? `<button class="button primary">${submit}</button>` : `<button type="button" class="button primary" data-close>${submit}</button>`}</div></form></div></div>`;
  root.querySelectorAll('[data-close]').forEach(
    (x) =>
      (x.onclick = () => {
        closeBoundaryEditor();
        root.innerHTML = '';
      }),
  );
  root.querySelector('.modal-backdrop').onclick = (e) => {
    if (e.target.classList.contains('modal-backdrop')) {
      closeBoundaryEditor();
      root.innerHTML = '';
    }
  };
  root.querySelector('#modalForm').onsubmit = async (e) => {
    e.preventDefault();
    const button = e.currentTarget.querySelector('button[type=submit],.modal-foot .button.primary');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    try {
      await fn?.(new FormData(e.currentTarget));
    } catch (error) {
      if (!error.dispatchToastShown) toast(error.message || 'Action failed', true);
    } finally {
      if (button && root.contains(button)) button.disabled = false;
    }
  };
}
const fld = (label, name, value = '', type = 'text', req = '') =>
  `<div class="form-field"><label>${label}</label><input class="input" name="${name}" type="${type}" value="${esc(value)}" ${req}></div>`;
const officerOpts = (sel = '') =>
  S.officers
    .map(
      (o) => `<option value="${o.id}" ${o.id === sel ? 'selected' : ''}>${esc(o.callSign)} · ${esc(o.name)}</option>`,
    )
    .join('');
const siteOpts = (sel = '') =>
  S.sites
    .filter((s) => s.areaType === 'work')
    .map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`)
    .join('');
const groupOpts = (sel = '') =>
  S.groups.map((g) => `<option ${g === sel ? 'selected' : ''}>${esc(g)}</option>`).join('');
function officerForm(o = null) {
  openModal(
    o ? 'Edit officer' : 'Add unit',
    `<div class="form-grid">${fld('Full name', 'name', o?.name || '')}${fld('Call sign / unit ID', 'callSign', o?.callSign || `Unit ${String(S.officers.length + 1).padStart(2, '0')}`)}<div class="form-field"><label>Radio group</label><select class="select" name="group">${groupOpts(o?.group)}</select></div>${fld('Phone / terminal', 'phone', o?.phone || 'Android terminal')}${fld('Marker colour', 'color', o?.color || '#628b73', 'color')}<div class="form-field"><label>Assigned work site</label><select class="select" name="siteId"><option value="" ${!o?.siteId ? 'selected' : ''}>Not assigned</option>${siteOpts(o?.siteId)}</select></div></div>${o ? '' : `<details class="workspace-disclosure"><summary><span><b>Create field login now</b><small>Optional · this login is locked to this unit</small></span><span class="disclosure-action">Add credentials</span></summary><div class="workspace-disclosure-body"><div class="form-grid">${fld('Login email', 'unitEmail', '', 'email')}${fld('Temporary password · 14+ characters', 'unitPassword', '', 'password')}</div><p class="form-help">Leave both blank to create the unit without a login. Credentials are sent directly to Supabase Auth and are never saved in Dispatch data.</p></div></details>`}<p class="form-help">Unit state starts blank; status and location appear only after a field login signs in and sends real updates.</p>`,
    o ? 'Save unit' : 'Add unit',
    async (fd) => {
      const unit = {
          ...(o || {}),
          name: fd.get('name'),
          callSign: fd.get('callSign'),
          group: fd.get('group'),
          phone: fd.get('phone'),
          color: fd.get('color'),
          siteId: fd.get('siteId') || null,
        },
        email = String(fd.get('unitEmail') || '').trim(),
        password = String(fd.get('unitPassword') || '');
      if (!o && Boolean(email) !== Boolean(password))
        throw Error('Enter both a login email and temporary password, or leave both blank');
      if (password && password.length < 14) throw Error('Use a temporary password of at least 14 characters');
      const saved = await action('officer-save', { officer: unit });
      if (!o && saved?.officer) o = { ...unit, id: saved.officer };
      if (email && password) {
        await api('/api/auth/users', {
          method: 'POST',
          body: JSON.stringify({ name: unit.name, email, password, role: 'field', officerId: saved.officer }),
        });
        toast('Unit and field login created');
      }
      $('#modalRoot').innerHTML = '';
    },
  );
}
function clockInModal(o) {
  openModal(
    `Start shift · ${esc(o.callSign)}`,
    `<div class="form-field"><label>Assigned work site</label><select class="select" name="siteId" required>${siteOpts(o.siteId)}</select></div><p class="form-help">Tracking begins only after clock-in. Location reports are retained locally until clock-out.</p>`,
    'Clock in',
    async (fd) => {
      await action('clock-in', { officerId: o.id, siteId: fd.get('siteId') });
      $('#modalRoot').innerHTML = '';
      if (currentPage === 'field') startGPS();
    },
  );
}
function closeBoundaryEditor() {
  if (boundaryEditor) {
    boundaryEditor.destroy();
    boundaryEditor = null;
  }
}
function boundaryDrawMarkup(note) {
  return `<div class="boundary-draw form-field full"><div class="boundary-draw-head"><div><b>Draw boundary on the map</b><span>Click to add corners · click the first point to close</span></div><span class="tag green">SNAP ON</span></div><div id="boundaryDrawMap" class="boundary-draw-map" role="region" aria-label="Draw geofence boundary on map"></div><div class="boundary-draw-controls"><button type="button" id="boundaryUndo" class="button ghost small">Undo point</button><button type="button" id="boundaryClose" class="button ghost small">Close outline</button><button type="button" id="boundaryRedraw" class="button ghost small">Redraw boundary</button><span id="boundarySnapStatus" class="form-help">${note}</span></div><span class="form-help">Snap aligns corners to nearby saved zone edges and helps close the outline. Drag or zoom the map to position it.</span></div>`;
}
function nearestBoundarySnap(targetMap, latlng, exclude = null, threshold = 16) {
  if (!targetMap || !window.L) return null;
  const cursor = targetMap.latLngToContainerPoint(latlng);
  let best = null,
    bestDistance = threshold;
  const shapes = [
    ...S.sites.map((s) => ({ kind: 'site', id: s.id, coordinates: s.coordinates })),
    ...S.regions.map((r) => ({ kind: 'region', id: r.id, coordinates: r.coordinates })),
  ];
  for (const shape of shapes) {
    if (exclude && shape.kind === exclude.kind && shape.id === exclude.id) continue;
    const coords = shape.coordinates || [];
    if (coords.length < 2) continue;
    for (let i = 0; i < coords.length; i++) {
      const a = targetMap.latLngToContainerPoint(coords[i]),
        b = targetMap.latLngToContainerPoint(coords[(i + 1) % coords.length]),
        dx = b.x - a.x,
        dy = b.y - a.y,
        length = dx * dx + dy * dy,
        t = length ? Math.max(0, Math.min(1, ((cursor.x - a.x) * dx + (cursor.y - a.y) * dy) / length)) : 0,
        point = L.point(a.x + dx * t, a.y + dy * t),
        distance = cursor.distanceTo(point);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = targetMap.containerPointToLatLng(point);
      }
    }
  }
  return best;
}
function initBoundaryEditor(initial = [], exclude = null, center = null) {
  closeBoundaryEditor();
  const node = $('#boundaryDrawMap');
  if (!node) return;
  if (!window.L) {
    toast('The map engine did not load; refresh before drawing a boundary.', true);
    return;
  }
  let points = (initial || [])
      .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
      .map((p) => [Number(p[0]), Number(p[1])]),
    closed = points.length >= 3;
  const targetMap = L.map(node, { doubleClickZoom: false, zoomControl: true }).setView([-26.1037, 28.0585], 14),
    references = L.layerGroup().addTo(targetMap),
    shapeLayer = L.layerGroup().addTo(targetMap),
    snapLayer = L.layerGroup().addTo(targetMap);
  const base = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Tiles © Esri' },
  ).addTo(targetMap);
  let tileErrors = 0,
    hasTiles = false,
    usedFallback = false;
  base.on('tileload', () => {
    hasTiles = true;
  });
  base.on('tileerror', () => {
    if (++tileErrors >= 3 && !hasTiles && !usedFallback) {
      usedFallback = true;
      base.options.attribution = '© OpenStreetMap contributors';
      base.setUrl('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    }
  });
  for (const s of S.sites)
    if (!(exclude?.kind === 'site' && exclude.id === s.id))
      L.polygon(s.coordinates, {
        color: s.color || '#648b73',
        weight: 1,
        fillOpacity: 0.035,
        interactive: false,
      }).addTo(references);
  for (const r of S.regions)
    if (!(exclude?.kind === 'region' && exclude.id === r.id))
      L.polygon(r.coordinates, {
        color: r.color || '#c65b51',
        weight: 1,
        fillOpacity: 0.025,
        dashArray: '4 5',
        interactive: false,
      }).addTo(references);
  S.officers
    .filter((o) => o.shiftId && Number.isFinite(Number(o.lat)) && Number.isFinite(Number(o.lng)))
    .forEach((o) =>
      L.circleMarker([o.lat, o.lng], {
        radius: 4,
        color: '#fff',
        weight: 1,
        fillColor: o.color || '#6476da',
        fillOpacity: 0.9,
        interactive: false,
      }).addTo(references),
    );
  const paint = (cursor = null, snap = null) => {
    shapeLayer.clearLayers();
    snapLayer.clearLayers();
    if (closed && points.length >= 3)
      L.polygon(points, { color: '#63d4bd', weight: 3, fillColor: '#63d4bd', fillOpacity: 0.15 }).addTo(shapeLayer);
    else if (points.length >= 2)
      L.polyline(points, { color: '#63d4bd', weight: 3, dashArray: '6 5' }).addTo(shapeLayer);
    points.forEach((point, index) =>
      L.circleMarker(point, {
        radius: 5,
        color: '#f5ffff',
        weight: 2,
        fillColor: index === 0 ? '#f0bf65' : '#62d5c4',
        fillOpacity: 1,
      })
        .addTo(shapeLayer)
        .bindTooltip(`Point ${index + 1}`),
    );
    if (cursor && points.length && !closed)
      L.polyline([...points, cursor], { color: '#63d4bd', weight: 2, dashArray: '4 6', opacity: 0.8 }).addTo(
        shapeLayer,
      );
    if (snap)
      L.circleMarker(snap, { radius: 8, color: '#fff', weight: 2, fillColor: '#2ed9ca', fillOpacity: 0.95 }).addTo(
        snapLayer,
      );
  };
  const status = $('#boundarySnapStatus'),
    nearStart = (latlng) => {
      if (points.length < 3) return false;
      const a = targetMap.latLngToContainerPoint(points[0]),
        b = targetMap.latLngToContainerPoint(latlng);
      return a.distanceTo(b) <= 18;
    };
  targetMap.on('mousemove', (e) => {
    if (closed || !points.length) {
      paint();
      if (status)
        status.textContent = closed ? 'Outline closed — ready to save.' : 'Click the map to add the first corner.';
      return;
    }
    if (nearStart(e.latlng)) {
      paint(points[0], points[0]);
      if (status) status.textContent = 'Snap: close to the first corner';
      return;
    }
    const snapped = nearestBoundarySnap(targetMap, e.latlng, exclude);
    paint(snapped || e.latlng, snapped);
    if (status)
      status.textContent = snapped
        ? 'Snap: aligned to a nearby saved boundary'
        : 'Snap on · move closer to an existing boundary to align';
  });
  targetMap.on('click', (e) => {
    if (closed) {
      if (status) status.textContent = 'Outline closed. Use Redraw boundary to start again.';
      return;
    }
    if (nearStart(e.latlng)) {
      closed = true;
      paint();
      if (status) status.textContent = 'Outline snapped closed — ready to save.';
      return;
    }
    const snapped = nearestBoundarySnap(targetMap, e.latlng, exclude),
      point = snapped || e.latlng;
    points.push([point.lat, point.lng]);
    paint();
    if (status)
      status.textContent = snapped
        ? `Corner ${points.length} snapped to an existing boundary.`
        : `${points.length} corner${points.length === 1 ? '' : 's'} placed · add at least 3.`;
  });
  const undo = $('#boundaryUndo'),
    finish = $('#boundaryClose'),
    redraw = $('#boundaryRedraw');
  undo.onclick = () => {
    if (points.length) {
      closed = false;
      points.pop();
      paint();
      if (status) status.textContent = `${points.length} corner${points.length === 1 ? '' : 's'} remain.`;
    }
  };
  finish.onclick = () => {
    if (points.length < 3) {
      toast('Add at least three boundary corners first.', true);
      return;
    }
    closed = true;
    paint();
    if (status) status.textContent = 'Outline closed — ready to save.';
  };
  redraw.onclick = () => {
    points = [];
    closed = false;
    paint();
    if (status) status.textContent = 'Boundary cleared · click the map to draw a new outline.';
  };
  if (points.length >= 3) {
    const bounds = L.latLngBounds(points);
    if (bounds.isValid()) targetMap.fitBounds(bounds.pad(0.25), { maxZoom: 17 });
  } else if (center && Number.isFinite(Number(center.lat)) && Number.isFinite(Number(center.lng)))
    targetMap.setView(center, Math.max(14, targetMap.getZoom()));
  paint();
  setTimeout(() => targetMap.invalidateSize(), 100);
  boundaryEditor = {
    getCoordinates: () => {
      if (!closed || points.length < 3) return [];
      const result = points.map((p) => [Number(p[0]), Number(p[1])]);
      if (result.length > 3 && targetMap.distance(result[0], result.at(-1)) < 1) result.pop();
      return result;
    },
    destroy: () => {
      targetMap.off();
      targetMap.remove();
      boundaryEditor = null;
    },
  };
}
function siteForm(s = null, coords = null, center = null) {
  const initial = coords || s?.coordinates || [],
    assigned = s?.assigned || [];
  openModal(
    s ? 'Edit site' : 'Create geofence site',
    `<div class="form-grid">${fld('Site name', 'name', s?.name || 'New post')}<div class="form-field"><label>Area type</label><select class="select" name="areaType"><option value="work" ${s?.areaType !== 'restricted' ? 'selected' : ''}>Work site</option><option value="restricted" ${s?.areaType === 'restricted' ? 'selected' : ''}>Restricted area</option></select></div>${fld('Boundary tolerance (metres)', 'tolerance', s?.tolerance || 40, 'number')}<div class="form-field"><label>Colour</label><input class="input" name="color" type="color" value="${esc(s?.color || '#648b73')}"></div><div class="form-field full"><label>Assigned officers (optional)</label><select class="select" name="assigned" multiple style="height:85px">${S.officers.map((o) => `<option value="${o.id}" ${assigned.includes(o.id) ? 'selected' : ''}>${esc(o.callSign)} · ${esc(o.name)}</option>`).join('')}</select></div></div>${boundaryDrawMarkup(initial.length ? 'Current boundary is shown. Use Redraw boundary to replace it.' : 'Click the map to add boundary corners. Snap is on: points align to nearby boundaries; click near your first point to close.')}`,
    'Save site',
    async (fd) => {
      const coordinates = boundaryEditor?.getCoordinates() || [];
      if (coordinates.length < 3) {
        toast('Add at least three corners and close the outline before saving.', true);
        return;
      }
      await action('site-save', {
        id: s?.id,
        name: fd.get('name'),
        areaType: fd.get('areaType'),
        tolerance: +fd.get('tolerance'),
        color: fd.get('color'),
        coordinates,
        assigned: [...$('#modalRoot [name=assigned]').selectedOptions].map((x) => x.value),
      });
      closeBoundaryEditor();
      $('#modalRoot').innerHTML = '';
    },
  );
  initBoundaryEditor(initial, { kind: 'site', id: s?.id }, center);
}

function regionForm(r = null) {
  openModal(
    r ? 'Edit geofenced zone' : 'Add geofenced zone',
    `<div class="form-grid">${fld('Zone name', 'name', r?.name || 'Restricted area')}<div class="form-field"><label>Type</label><select class="select" name="areaType"><option value="work" ${r?.areaType !== 'restricted' ? 'selected' : ''}>Working area</option><option value="restricted" ${r?.areaType === 'restricted' ? 'selected' : ''}>Restricted area</option></select></div></div>${boundaryDrawMarkup(r?.coordinates?.length ? 'Current boundary is shown. Use Redraw boundary to replace it.' : 'Click the map to add boundary corners. Snap is on: points align to nearby boundaries; click near your first point to close.')}`,
    'Save zone',
    async (fd) => {
      const coordinates = boundaryEditor?.getCoordinates() || [];
      if (coordinates.length < 3) {
        toast('Add at least three corners and close the outline before saving.', true);
        return;
      }
      await action('region-save', {
        id: r?.id,
        name: fd.get('name'),
        areaType: fd.get('areaType'),
        coordinates,
        assigned: r?.assigned || [],
      });
      closeBoundaryEditor();
      $('#modalRoot').innerHTML = '';
    },
  );
  initBoundaryEditor(r?.coordinates || [], { kind: 'region', id: r?.id }, siteMap?.getCenter() || map?.getCenter());
}

function messageForm(to = '') {
  openModal(
    'Compose dispatch message',
    `<div class="form-grid"><div class="form-field"><label>Recipient</label><select class="select" name="to"><option value="all">All terminals · broadcast</option><option value="group">Radio group…</option>${officerOpts(to)}</select></div><div class="form-field"><label>Group</label><select class="select" name="group">${groupOpts()}</select></div><div class="form-field full"><label>Message</label><textarea class="textarea" name="body" maxlength="1500" required placeholder="Dispatch message…"></textarea></div><div class="form-field full"><label>Delivery</label><select class="select" name="schedule"><option value="">Send now</option><option value="5">Schedule in 5 minutes</option><option value="60">Schedule in 1 hour</option><option value="1440">Schedule in 1 day</option></select></div></div><p class="form-help">Offline recipients are queued; delivery resumes when they reconnect.</p>`,
    'Send message',
    async (fd) => {
      const choice = fd.get('to'),
        to = choice === 'group' ? 'all' : choice,
        group = choice === 'group' ? fd.get('group') : null;
      const scheduledAt = fd.get('schedule')
        ? new Date(Date.now() + Number(fd.get('schedule')) * 60000).toISOString()
        : null;
      await action('message', { to, group, body: fd.get('body'), scheduledAt });
      $('#modalRoot').innerHTML = '';
    },
  );
}
function sosForm() {
  const options = S.officers.filter((o) => o.shiftId);
  if (!options.length) {
    toast('Clock an officer in before raising SOS', true);
    return;
  }
  openModal(
    'Raise emergency alert',
    `<div class="form-field"><label>Officer / terminal</label><select class="select" name="officerId">${options.map((o) => `<option value="${o.id}">${esc(o.callSign)} · ${esc(o.name)} · ${esc(status(o))}</option>`).join('')}</select></div><p class="form-help" style="color:#bd6253">SOS immediately interrupts the control room, including when an officer is offline.</p>`,
    'Raise SOS',
    async (fd) => {
      await action('sos', { officerId: fd.get('officerId') });
      $('#modalRoot').innerHTML = '';
    },
  );
}
function callForm(kind = 'private') {
  const activeUnits = S.officers.filter((o) => o.shiftId && !o.stunned),
    unitOptions = activeUnits
      .map((o) => `<option value="${esc(o.id)}">${esc(o.callSign)} · ${esc(o.name)}</option>`)
      .join('');
  const unitField = `<div class="form-field" id="voiceUnitField"><label>On-shift terminal</label><select class="select" name="to"><option value="" selected>Select an active unit</option>${unitOptions}</select></div>`;
  const groupField = `<div class="form-field" id="voiceGroupField"><label>Talk group</label><select class="select" name="group">${groupOpts()}</select></div>`;
  openModal(
    'Start live voice call',
    `<div class="form-grid"><div class="form-field"><label>Call type</label><select class="select" name="callType"><option value="private" ${kind === 'private' ? 'selected' : ''}>Private · one-to-one</option><option value="group">Group call</option><option value="all">All-call</option><option value="intercom" ${kind === 'intercom' ? 'selected' : ''}>Dispatcher intercom</option></select></div><div class="form-field"><label>Channel</label><select class="select" name="channel">${Array.from({ length: 8 }, (_, i) => `<option value="${i + 1}">Channel ${i + 1}</option>`).join('')}</select></div>${unitField}${groupField}</div><p id="voiceCallAvailability" class="form-help" role="status">Checking for another connected Dispatch voice endpoint…</p><p class="form-help">Calls connect live Dispatch browser sessions; they do not dial phone numbers. Keep the recipient’s Field view open, signed in, on shift, and allow microphone access. STUN discovery is enabled; restrictive networks may still need a TURN relay.</p>`,
    'Call',
    async (fd) => {
      const callType = fd.get('callType'),
        group = fd.get('group'),
        selected = String(fd.get('to') || '');
      const eligible = activeUnits.filter(
        (o) => callType === 'all' || callType === 'intercom' || callType === 'private' || o.group === group,
      );
      if (callType === 'private' && !eligible.some((o) => o.id === selected)) {
        toast('Select an on-shift terminal for a private call.', true);
        return;
      }
      const targetIds =
        callType === 'all'
          ? eligible.map((o) => o.id)
          : callType === 'group'
            ? eligible.map((o) => o.id)
            : callType === 'intercom'
              ? ['control']
              : [selected];
      if (callType !== 'intercom' && !targetIds.length) {
        toast('There are no on-shift terminals in that call group.', true);
        return;
      }
      const peers = [];
      try {
        for (const target of targetIds) {
          const path =
            target === 'control'
              ? `/api/rtc/peers?role=control&exclude=${encodeURIComponent(getVoicePeerId())}`
              : `/api/rtc/peers?officerId=${encodeURIComponent(target)}&exclude=${encodeURIComponent(getVoicePeerId())}`;
          const result = await api(path);
          peers.push(...(result.peers || []));
        }
        const uniquePeers = [...new Map(peers.map((peer) => [peer.peerId, peer])).values()];
        window.DispatchDiagnostics?.record('voice.call.preflight', {
          callType,
          eligibleCount: targetIds.length,
          connectedPeers: uniquePeers.length,
        });
        if (!uniquePeers.length) {
          const targetName =
            callType === 'private'
              ? officer(selected)?.callSign
              : callType === 'intercom'
                ? 'another control-room session'
                : callType === 'group'
                  ? `${group} group`
                  : 'the selected on-shift units';
          const message = `No live Dispatch endpoint is connected for ${targetName}. Open Field mode in another signed-in tab/device, select an on-shift unit, and allow microphone access.`;
          const status = $('#voiceCallAvailability');
          if (status) status.textContent = message;
          toast(message, true);
          return;
        }
        const d = await action('call-start', {
          callType,
          channel: +fd.get('channel'),
          from: currentPage === 'field' ? officer(fieldId)?.callSign : 'Control',
          to:
            callType === 'all' ? 'all' : callType === 'group' ? group : callType === 'intercom' ? 'control' : selected,
          group,
          participantIds: targetIds,
          live: true,
        });
        try {
          await startLiveVoiceCall(d.call, uniquePeers);
          $('#modalRoot').innerHTML = '';
          toast(`Ringing ${uniquePeers.length} live voice endpoint${uniquePeers.length === 1 ? '' : 's'}`);
        } catch (error) {
          await api('/api/action', {
            method: 'POST',
            body: JSON.stringify({ type: 'call-fail', id: d.call, reason: error.message }),
          }).catch(() => {});
          await refresh();
          throw error;
        }
      } catch (error) {
        const message = `Could not start call: ${error.message}`;
        const status = $('#voiceCallAvailability');
        if (status) status.textContent = message;
        if (!error.dispatchToastShown) toast(message, true);
        window.DispatchDiagnostics?.record(
          'voice.call.failed',
          { callType, status: error.status || 0, reason: String(error.message || '').slice(0, 120) },
          'warning',
        );
      }
    },
  );
  const form = $('#modalForm'),
    typeSelect = form?.elements.callType,
    unit = form?.querySelector('#voiceUnitField'),
    group = form?.querySelector('#voiceGroupField');
  const syncFields = () => {
    if (unit) unit.hidden = typeSelect?.value !== 'private';
    if (group) group.hidden = typeSelect?.value !== 'group';
  };
  typeSelect?.addEventListener('change', syncFields);
  syncFields();
  refreshVoiceAvailability();
}
async function refreshVoiceAvailability() {
  const status = $('#voiceCallAvailability');
  if (!status) return;
  try {
    const result = await api(`/api/rtc/peers?exclude=${encodeURIComponent(getVoicePeerId())}`),
      peers = result.peers || [],
      fieldPeers = peers.filter((peer) => peer.role === 'field'),
      controlPeers = peers.filter((peer) => peer.role === 'control'),
      labels = [
        ...new Set(
          fieldPeers.map((peer) => officer(peer.officerId)?.callSign || peer.label || 'Field terminal').filter(Boolean),
        ),
      ];
    window.DispatchDiagnostics?.record('voice.peers.available', {
      fieldEndpoints: fieldPeers.length,
      controlEndpoints: controlPeers.length,
    });
    status.textContent =
      fieldPeers.length || controlPeers.length
        ? `Connected now: ${labels.length ? labels.join(', ') : ''}${controlPeers.length ? `${labels.length ? ' · ' : ''}${controlPeers.length} control-room session${controlPeers.length === 1 ? '' : 's'}` : ''}`
        : 'No other live Dispatch voice session is connected yet. Open the recipient in Field mode on another signed-in tab/device.';
  } catch (error) {
    status.textContent = `Voice availability check failed: ${error.message}`;
  }
}
function startDrawing(page = false) {
  const source = page ? siteMap : mapMode === '2d' ? map : null;
  if (!window.L) return toast('The map is unavailable, so a boundary cannot be drawn.', true);
  siteForm(null, null, source?.getCenter() || L.latLng(-26.1037, 28.0585));
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia)
    return toast('Microphone recording requires a secure browser context and microphone permission.', true);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    return toast(`Microphone unavailable: ${e.message}`, true);
  }
  if (!confirm('Record this microphone locally for up to 30 seconds? Obtain participant consent before recording.')) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  const call = S.calls.find((c) => c.status === 'active' && c.live),
    mr = new MediaRecorder(stream),
    parts = [];
  mr.ondataavailable = (e) => {
    if (e.data.size) parts.push(e.data);
  };
  mr.onerror = () => toast('Audio recording failed', true);
  mr.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(parts, { type: mr.mimeType || 'audio/webm' });
    if (blob.size > 2e6) {
      toast('Recording exceeds the local demo 2 MB cap', true);
      return;
    }
    const rd = new FileReader();
    rd.onload = () =>
      action('recording-save', {
        callId: call?.id || null,
        name: `Microphone clip · ${new Date().toLocaleString()}`,
        mime: blob.type,
        data: rd.result,
        duration: Math.round((Date.now() - mr.startAt) / 1000),
        from: currentPage === 'field' ? officer(fieldId)?.callSign : 'Control',
      });
    rd.readAsDataURL(blob);
  };
  mr.startAt = Date.now();
  mr.start();
  toast('Local microphone recording started; automatic stop in 30 seconds.');
  setTimeout(() => {
    if (mr.state === 'recording') mr.stop();
  }, 30000);
}
function exportCsv(type) {
  const rows = currentPage === 'reports' && currentReportRows.length ? currentReportRows : null;
  if (!rows) {
    location.href = `/api/export?type=${encodeURIComponent(type)}&format=csv`;
    return;
  }
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))],
    cell = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return `"${s.replaceAll('"', '""')}"`;
    },
    csv = [keys.map(cell).join(','), ...rows.map((r) => keys.map((k) => cell(r[k])).join(','))].join('\r\n'),
    a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `dispatch-${type}-${dateKey(Date.now())}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
function downloadTemplate() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(
    new Blob(['name,callSign,group,phone\nAlex Nkosi,Unit 99,North Sector,Android terminal\n'], { type: 'text/csv' }),
  );
  a.download = 'dispatch-officer-import-template.csv';
  a.click();
}
function importCsv() {
  const i = document.createElement('input');
  i.type = 'file';
  i.accept = '.csv,text/csv';
  i.onchange = async () => {
    const lines = (await i.files[0].text()).trim().split(/\r?\n/),
      head = lines.shift().split(',');
    const officers = lines.map((l) => Object.fromEntries(l.split(',').map((x, j) => [head[j], x])));
    await action('import', { officers });
  };
  i.click();
}
function uploadAudio() {
  const i = document.createElement('input');
  i.type = 'file';
  i.accept = 'audio/*';
  i.onchange = () => {
    const f = i.files[0];
    if (f.size > 2e6) return toast('Audio must be less than 2 MB', true);
    const r = new FileReader();
    r.onload = () => action('recording-save', { name: f.name, mime: f.type, data: r.result });
    r.readAsDataURL(f);
  };
  i.click();
}
function downloadRec(id) {
  const r = S.recordings.find((x) => x.id === id);
  if (!r?.hasData) return toast('No audio attached', true);
  const a = document.createElement('a');
  a.href = `/api/recordings/${encodeURIComponent(id)}?download=1`;
  a.click();
}
function setTrafficStatus(message, kind = '') {
  const n = $('#trafficNotice');
  if (!n) return;
  clearTimeout(trafficStatusTimer);
  n.textContent = message;
  n.classList.remove('hidden', 'traffic-ok', 'traffic-loading', 'traffic-error');
  if (kind) n.classList.add(`traffic-${kind}`);
  if (kind === 'ok') trafficStatusTimer = setTimeout(() => n.classList.add('hidden'), 4500);
  if (kind === 'error') window.DispatchDiagnostics?.record('traffic.status.error', { message });
}
function syncTrafficButton() {
  $$('[data-action="traffic"]').forEach((b) => {
    b.classList.toggle('traffic-enabled', trafficOn);
    b.setAttribute('aria-pressed', String(trafficOn));
    b.title = trafficOn ? 'TomTom live traffic is on' : 'Turn on TomTom live traffic';
  });
}
function syncMapLibreTrafficLayer() {
  if (!mapLibre || !mapLibreReady) return;
  const wanted = trafficOn && trafficConfigured(S.settings) && S.settings.trafficProvider !== 'here',
    source = mapLibre.getSource('live-traffic');
  if (wanted && !source) {
    mapLibre.addSource('live-traffic', {
      type: 'raster',
      tiles: [trafficTilesUrl()],
      tileSize: 256,
      attribution: 'Traffic © TomTom',
    });
    const layer = {
        id: 'live-traffic-layer',
        type: 'raster',
        source: 'live-traffic',
        paint: { 'raster-opacity': 0.95 },
      },
      before = mapLibre.getLayer('site-fill') ? 'site-fill' : undefined;
    mapLibre.addLayer(layer, before);
  } else if (!wanted && source) {
    if (mapLibre.getLayer('live-traffic-layer')) mapLibre.removeLayer('live-traffic-layer');
    mapLibre.removeSource('live-traffic');
  }
}
function traffic(enable) {
  trafficOn = Boolean(enable);
  syncTrafficButton();
  if (trafficLayer) {
    trafficLayer.remove();
    trafficLayer = null;
  }
  if (!trafficOn) {
    if (mapMode === '3d' && mapLibreReady) {
      syncMapLibreTrafficLayer();
      refreshMapLibre();
    }
    setTrafficStatus(
      trafficConfigured(S.settings) ? 'Live traffic is off' : 'Traffic key required · Configure in Settings',
    );
    return;
  }
  if (!trafficConfigured(S.settings)) {
    trafficOn = false;
    syncTrafficButton();
    toast('Configure a TomTom API key in Settings for real traffic', true);
    setTrafficStatus('Traffic key required · Configure in Settings', 'error');
    return;
  }
  if (S.settings.trafficProvider === 'here') {
    trafficOn = false;
    syncTrafficButton();
    toast('HERE traffic overlay is not yet implemented; choose TomTom.', true);
    setTrafficStatus('Choose TomTom Traffic in Settings', 'error');
    return;
  }
  setTrafficStatus('Loading TomTom live traffic…', 'loading');
  sampleTraffic();
  const tiles = trafficTilesUrl();
  if (mapMode === '3d') {
    syncMapLibreTrafficLayer();
    if (mapLibreReady) refreshMapLibre();
  } else if (map) {
    trafficLayer = L.tileLayer(tiles, { opacity: 0.95, attribution: 'Traffic © TomTom', maxZoom: 20 });
    trafficLayer.on('tileload', () => setTrafficStatus('TomTom live traffic tiles loaded', 'ok'));
    trafficLayer.on('tileerror', () => {
      window.DispatchDiagnostics?.record('map.traffic.tile.error', { mode: '2d', provider: 'TomTom' });
      setTrafficStatus('TomTom traffic tiles failed · check API access and network', 'error');
    });
    trafficLayer.addTo(map);
  }
}
function captureSosLocation(o, alertId) {
  if (!navigator.geolocation) return;
  const capture = (pos) => {
    const timestamp = new Date(pos.timestamp || Date.now()).toISOString(),
      payload = {
        type: 'sos-location',
        officerId: o.id,
        alertId: alertId || null,
        battery: o.battery,
        signal: o.signal,
        point: {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp,
          eventId: `sos-${o.id}-${pos.timestamp || Date.now()}`,
        },
      };
    if (!navigator.onLine) {
      queueEvent({ kind: 'action', payload });
      return;
    }
    api('/api/action', { method: 'POST', body: JSON.stringify(payload) })
      .then((d) => {
        if (d.state) {
          S = d.state;
          if (currentPage !== 'review') render();
        }
      })
      .catch((error) => {
        if (!error.status || error.status >= 500) queueEvent({ kind: 'action', payload });
      });
  };
  try {
    navigator.geolocation.getCurrentPosition(capture, () => {}, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 8000,
    });
  } catch {}
}
async function fieldSOS() {
  const o = officer(fieldId);
  if (!o?.shiftId) return toast('Clock in first', true);
  if (o.stunned) return toast('This terminal is stunned and cannot transmit', true);
  const pressedAt = new Date().toISOString(),
    location = {
      lat: o.lat ?? null,
      lng: o.lng ?? null,
      accuracy: o.accuracy ?? null,
      locationAt: o.lastSeen || null,
      battery: o.battery ?? null,
      signal: o.signal ?? null,
    },
    payload = { type: 'sos', officerId: o.id, raisedAt: pressedAt, offline: !navigator.onLine || !o.online, location };
  if (!navigator.onLine) {
    queueEvent({ kind: 'action', payload });
    toast('SOS saved in the device queue; it will send with the last known position when connection returns.');
    captureSosLocation(o, null);
    return;
  }
  try {
    const result = await action('sos', { officerId: o.id, raisedAt: pressedAt, offline: payload.offline, location });
    captureSosLocation(o, result?.alert);
  } catch (error) {
    if (!navigator.onLine) {
      queueEvent({ kind: 'action', payload });
      toast('SOS saved in the device queue for delivery when connection returns.');
      captureSosLocation(o, null);
    } else throw error;
  }
}

function fieldLocation() {
  const o = officer(fieldId);
  if (!o?.shiftId) return toast('Clock in first', true);
  if (o.stunned) return toast('This terminal is stunned and cannot transmit', true);
  if (!navigator.geolocation) return toast('GPS not available', true);
  navigator.geolocation.getCurrentPosition(
    (p) => {
      clearLocationError();
      queueEvent({
        kind: 'location',
        payload: {
          officerId: o.id,
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy,
          timestamp: new Date().toISOString(),
          eventId: `${o.id}-${p.timestamp}`,
        },
      });
      toast('Position sent');
    },
    reportLocationError,
    { enableHighAccuracy: true, timeout: 12000 },
  );
}
async function fieldReply() {
  const f = officer(fieldId);
  if (!f?.shiftId || f.stunned) return toast('Clock in and be active before messaging', true);
  let b = $('#fieldReply').value.trim();
  if (!b) return;
  await action('message', { from: f.callSign, to: 'all', group: officer(fieldId).group, body: b });
  $('#fieldReply').value = '';
}
async function doAction(a, id = '', el = null) {
  const o = officer(id);
  switch (a) {
    case 'add-officer':
      officerForm();
      break;
    case 'delete-unit-login':
      if (
        confirm(
          `Revoke the field login for ${el?.dataset.name || 'this unit'}? The unit and its real GPS history will remain.`,
        )
      ) {
        await api('/api/auth/users', { method: 'DELETE', body: JSON.stringify({ userId: id }) });
        await renderUsers();
        toast('Field login revoked');
      }
      break;
    case 'edit-officer':
      officerForm(o);
      break;
    case 'clock-in':
      clockInModal(o);
      break;
    case 'clock-out':
      if (confirm(`Clock ${o.callSign} out and stop tracking?`)) {
        if (currentPage === 'field') stopGPS();
        await action('clock-out', { officerId: id });
      }
      break;
    case 'unit-menu':
      openModal(
        `${esc(o.callSign)} · ${esc(o.name)}`,
        `<div class="detail-list"><div class="detail-row"><span>Status</span><b>${esc(status(o))}</b></div><div class="detail-row"><span>Position</span><b>${Number(o.lat).toFixed(5)}, ${Number(o.lng).toFixed(5)}</b></div><div class="detail-row"><span>GPS accuracy</span><b>±${o.accuracy}m</b></div><div class="detail-row"><span>Last seen</span><b>${ago(o.lastSeen)}</b></div></div><div class="toolbar"><button class="button ghost small" type="button" data-action="edit-officer" data-id="${o.id}">Edit</button><button class="button ghost small" type="button" data-action="message-unit" data-id="${o.id}">Message</button><button class="button ghost small" type="button" data-action="focus-unit" data-id="${o.id}">Locate</button>${!o.shiftId ? `<button class="button danger small" type="button" data-action="delete-officer" data-id="${o.id}">Remove</button>` : ''}</div>`,
        'Close',
        async () => {
          $('#modalRoot').innerHTML = '';
        },
      );
      break;
    case 'message-unit':
      messageForm(id);
      break;
    case 'compose-message':
      messageForm();
      break;
    case 'add-site':
      siteForm();
      break;
    case 'edit-site':
      siteForm(site(id));
      break;
    case 'delete-site':
      if (confirm('Delete this site?')) await action('site-delete', { id });
      break;
    case 'add-region':
      regionForm();
      break;
    case 'region-delete':
      if (confirm('Remove this geofence region?')) await action('region-delete', { id });
      break;
    case 'draw-site':
      startDrawing(false);
      break;
    case 'draw-site-page':
      startDrawing(true);
      break;
    case 'finish-draw':
      drawMode = false;
      $('#drawHint')?.classList.add('hidden');
      mapLibre?.getSource('site-draw')?.setData({ type: 'FeatureCollection', features: [] });
      if (drawPoints.length >= 3) siteForm(null, [...drawPoints]);
      else toast('Draw at least three boundary points', true);
      break;
    case 'cancel-draw':
      drawMode = false;
      drawPoints = [];
      $('#drawHint')?.classList.add('hidden');
      if (siteLayer) siteLayer.clearLayers();
      mapLibre?.getSource('site-draw')?.setData({ type: 'FeatureCollection', features: [] });
      break;
    case 'zoom-in':
      if (mapMode === '3d' && mapLibre) mapLibre.zoomIn();
      else map?.zoomIn();
      break;
    case 'zoom-out':
      if (mapMode === '3d' && mapLibre) mapLibre.zoomOut();
      else map?.zoomOut();
      break;
    case 'edit-site-map':
      startZoneMapEdit('site', id);
      break;
    case 'edit-region-map':
      startZoneMapEdit('region', id);
      break;
    case 'edit-region':
      regionForm(S.regions.find((x) => x.id === id));
      break;
    case 'save-site-edit':
      await saveSiteMapEdit();
      break;
    case 'cancel-site-edit':
      cancelSiteMapEdit();
      break;
    case 'fit':
      if (mapMode === '3d' && mapLibre) {
        const ps = S.officers.filter((o) => o.shiftId).map((o) => [o.lng, o.lat]);
        if (ps.length) mapLibre.fitBounds(ps, { padding: 45, maxZoom: 16 });
      } else if (map) {
        let ps = S.officers.filter((o) => o.shiftId).map((o) => [o.lat, o.lng]);
        if (ps.length) map.fitBounds(ps, { padding: [25, 25], maxZoom: 15 });
      }
      break;
    case 'map-2d':
      setMapMode('2d');
      break;
    case 'map-3d':
      setMapMode('3d');
      break;
    case 'locate-me':
      locateController();
      break;
    case 'measure':
      startMeasure();
      break;
    case 'measure-cancel':
      cancelMeasure();
      break;
    case 'measure-edit':
      editMeasurement(id);
      break;
    case 'measure-done':
      editingMeasureId = null;
      renderMeasurements();
      break;
    case 'measure-remove':
      removeMeasurement(id);
      break;
    case 'measure-clear':
      clearMeasurements();
      break;
    case 'fullscreen': {
      const box = document.querySelector('.map-panel');
      if (!document.fullscreenElement) box?.requestFullscreen?.();
      else document.exitFullscreen?.();
      setTimeout(() => {
        map?.invalidateSize();
        mapLibre?.resize();
      }, 250);
      break;
    }
    case 'traffic':
      traffic(!trafficOn);
      break;
    case 'sos-modal':
      sosForm();
      break;
    case 'view-sos':
      focusSosAlert(id);
      break;
    case 'start-call':
      callForm();
      break;
    case 'intercom':
      callForm('intercom');
      break;
    case 'end-call':
      await endVoiceCall(id, true);
      await action('call-end', { id });
      break;
    case 'voice-end':
      await endVoiceCall(id, true);
      await action('call-end', { id });
      break;
    case 'voice-decline':
      if (el?.dataset.peer) sendVoiceSignal(el.dataset.peer, id, 'reject', {}).catch(() => {});
      rtcPendingOffers.delete(`${id}:${el?.dataset.peer || ''}`);
      $('#modalRoot').innerHTML = '';
      break;
    case 'new-patch':
      openModal(
        'Create patch preset',
        `<div class="form-field">${fld('Patch name', 'name', 'Operations link')}</div><div class="form-field"><label>Talk group</label><select class="select" name="group">${groupOpts()}</select></div>`,
        'Patch groups',
        async (fd) => {
          await action('patch-save', { name: fd.get('name'), members: [fd.get('group')] });
          $('#modalRoot').innerHTML = '';
        },
      );
      break;
    case 'stop-patch':
      await action('patch-stop', { id });
      break;
    case 'upload-recording':
      uploadAudio();
      break;
    case 'record-call':
      startRecording();
      break;
    case 'remote-monitor': {
      const opts = officerOpts();
      openModal(
        'Request live voice monitor',
        `<div class="form-field"><label>Terminal</label><select class="select" name="officerId">${opts}</select></div><p class="form-help">This sends a one-way live-audio request. The field terminal must accept it and grant microphone permission. Audio is not recorded.</p>`,
        'Send request',
        async (fd) => {
          const uid = fd.get('officerId');
          $('#modalRoot').innerHTML = '';
          try {
            await requestRemoteVoiceMonitor(uid);
          } catch (e) {
            toast(e.message, true);
          }
        },
      );
      break;
    }
    case 'download-rec':
      downloadRec(id);
      break;
    case 'add-group':
      openModal('Create radio group', fld('Group name', 'name', '', 'text', 'required'), 'Create group', async (fd) => {
        await action('group-save', { name: fd.get('name') });
        $('#modalRoot').innerHTML = '';
      });
      break;
    case 'delete-group':
      if (confirm(`Remove ${el.dataset.name}?`)) await action('group-delete', { name: el.dataset.name });
      break;
    case 'add-relay':
      openModal(
        'Add relay node',
        `<div class="form-grid">${fld('Node name', 'name', 'Relay node')}${fld('Host / address', 'host', '127.0.0.1')}<div class="form-field"><label>Mode</label><select class="select" name="mode"><option>relay</option><option>gateway</option></select></div></div>`,
        'Add node',
        async (fd) => {
          await action('relay-save', { name: fd.get('name'), host: fd.get('host'), mode: fd.get('mode') });
          $('#modalRoot').innerHTML = '';
        },
      );
      break;
    case 'status-query':
    case 'status-one': {
      const r = await action('status-query', { officerId: id || undefined }),
        u = r.units || [];
      toast(
        u.length === 1
          ? `${u[0].callSign}: ${u[0].online ? 'online' : 'offline'} · ${u[0].status} · last update ${ago(u[0].lastSeen)}`
          : `${u.length} terminal status records received`,
      );
      break;
    }
    case 'stun':
      await action('stun', { officerId: id, stunned: !o.stunned });
      break;
    case 'backup':
      await api('/api/backup', { method: 'POST', body: '{}' });
      await renderBackups();
      toast('Backup created');
      break;
    case 'restore':
      if (confirm(`Restore ${el.dataset.file}? Current data will be replaced.`)) {
        await api('/api/restore', { method: 'POST', body: JSON.stringify({ file: el.dataset.file }) });
        await refresh();
        toast('Backup restored');
      }
      break;
    case 'save-settings': {
      const d = new FormData($('#settingsForm')),
        settings = Object.fromEntries(d);
      $$('.setting-field').forEach((x) => (settings[x.name] = x.value));
      for (const k of [
        'absenceMinutes',
        'offlineMinutes',
        'gpsAccuracy',
        'geofenceReadings',
        'locationInterval',
        'sosEscalationMinutes',
        'speedLimit',
        'retentionDays',
        'backupRetention',
      ])
        settings[k] = Number(settings[k] || 0);
      settings.trafficEnabled = settings.trafficEnabled === 'true';
      await action('settings', { settings });
      if (currentPage === 'overview' && settings.trafficEnabled) traffic(true);
      if (settings.trafficKey && trafficOn) sampleTraffic(true);
      break;
    }
    case 'mark-read':
      await action('mark-read', { id });
      break;
    case 'run-report':
      runReport();
      break;
    case 'export-report':
      exportCsv($('#reportType')?.value || 'officers');
      break;
    case 'export-review':
      exportCsv('locations');
      break;
    case 'export-excel':
      exportCsv($('#reportType')?.value || 'officers');
      toast('Excel-ready CSV downloaded');
      break;
    case 'print':
      window.print();
      break;
    case 'load-review':
      loadReview();
      break;
    case 'replay-play':
      if (!replayEvents.length) {
        showReplay(0);
        toast('No saved traffic or GPS fixes are available on this date', true);
        break;
      }
      stopReplay();
      {
        let cursor = Number($('#replayRange').value) || 0;
        if (cursor >= replayEvents.length - 1) cursor = replayStartIndex;
        let previousFrame = 0,
          lastShown = Math.floor(cursor);
        const speed = Math.max(1, Number($('#replaySpeed').value) || 1),
          lastIndex = replayEvents.length - 1;
        const tick = (timestamp) => {
          if (!previousFrame) previousFrame = timestamp;
          const elapsed = Math.min(100, timestamp - previousFrame);
          previousFrame = timestamp;
          cursor = Math.min(lastIndex, cursor + (elapsed * speed) / 50);
          const next = Math.floor(cursor);
          if (next !== lastShown) {
            $('#replayRange').value = next;
            showReplay(next);
            lastShown = next;
          }
          if (cursor < lastIndex) replayTimer = requestAnimationFrame(tick);
          else replayTimer = null;
        };
        replayTimer = requestAnimationFrame(tick);
      }
      break;
    case 'replay-pause':
      stopReplay();
      break;
    case 'import':
      importCsv();
      break;
    case 'template':
      downloadTemplate();
      break;
    case 'field-clock': {
      const f = officer(fieldId);
      if (f.shiftId) {
        if (confirm('Clock out and stop GPS tracking?')) {
          for (const cid of [...rtcSessions.keys()]) {
            await endVoiceCall(cid, true);
            await api('/api/action', { method: 'POST', body: JSON.stringify({ type: 'call-end', id: cid }) }).catch(
              () => {},
            );
          }
          stopGPS();
          await action('clock-out', { officerId: f.id });
        }
      } else clockInModal(f);
      break;
    }
    case 'field-sos':
      await fieldSOS();
      break;
    case 'field-gps':
      fieldLocation();
      break;
    case 'field-reply':
      await fieldReply();
      break;
    case 'field-ptt':
      await togglePushToTalk();
      break;
    case 'field-break': {
      const f = officer(fieldId);
      await action('break', { officerId: f.id, enabled: f.status !== 'on-break' });
      break;
    }
    case 'select-map-unit':
      selectMapUnit(id);
      break;
    case 'close-map-unit':
      selectedMapOfficerId = null;
      renderMapUnitHud();
      break;
    case 'focus-unit':
      if (o) {
        $('#modalRoot').innerHTML = '';
        selectedMapOfficerId = o.id;
        go('overview');
        setTimeout(() => selectMapUnit(o.id), 220);
      }
      break;
    case 'delete-officer':
      if (confirm(`Remove ${o.callSign}?`)) await action('officer-delete', { officerId: id });
      $('#modalRoot').innerHTML = '';
      break;
  }
}
$('#mainNav').addEventListener('click', (e) => {
  const n = e.target.closest('[data-page]');
  if (n) go(n.dataset.page);
});
$('.top-nav').addEventListener('click', (e) => {
  const n = e.target.closest('[data-page]');
  if (n) go(n.dataset.page);
});
$('#topSos').onclick = () => sosForm();
$('#pageContent').addEventListener('click', async (e) => {
  const pg = e.target.closest('[data-page-link]');
  if (pg) {
    go(pg.dataset.pageLink);
    return;
  }
  const alertBtn = e.target.closest('[data-alert]');
  if (alertBtn) {
    let note = 'Controller response';
    if (alertBtn.dataset.status === 'handled') {
      note = prompt('Resolution note (required):');
      if (!note) return;
    }
    try {
      await action('alert-status', { id: alertBtn.dataset.alert, status: alertBtn.dataset.status, note });
    } catch (error) {
      toast(error?.message || 'Could not update the alert.', true);
    }
    return;
  }
  const focus = e.target.closest('[data-focus]');
  if (focus) {
    selectMapUnit(focus.dataset.focus);
    return;
  }
  const b = e.target.closest('[data-action]');
  if (b) {
    e.preventDefault();
    b.closest('.map-tools-more')?.removeAttribute('open');
    try {
      await doAction(b.dataset.action, b.dataset.id, b);
    } catch {}
    return;
  }
});
$('#pageContent').addEventListener('submit', async (e) => {
  if (e.target.id === 'userCreateForm') {
    e.preventDefault();
    const b = e.target.querySelector('button[type=submit]');
    b.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(e.target));
      await api('/api/auth/users', { method: 'POST', body: JSON.stringify(data) });
      e.target.reset();
      await renderUsers();
      toast('Account created');
    } catch (error) {
      toast(error.message, true);
    } finally {
      b.disabled = false;
    }
  } else if (e.target.id === 'passwordChangeForm') {
    e.preventDefault();
    const b = e.target.querySelector('button[type=submit]');
    b.disabled = true;
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
      });
      e.target.reset();
      toast('Password changed');
    } catch (error) {
      toast(error.message, true);
    } finally {
      b.disabled = false;
    }
  }
});
$('#pageContent').addEventListener('input', (e) => {
  if (e.target.id === 'unitSearch') unitsTable();
});
$('#pageContent').addEventListener('change', (e) => {
  if (e.target.id === 'unitFilter') unitsTable();
  if (['reportType', 'reportGroup', 'reportStart', 'reportEnd'].includes(e.target.id)) runReport();
  if (e.target.id === 'userRole') {
    const wrap = $('#unitLoginOfficerWrap'),
      select = $('#unitLoginOfficer'),
      isField = e.target.value === 'field';
    if (wrap) wrap.hidden = !isField;
    if (select) select.required = isField;
  }
  if (e.target.id === 'mapStyleSelect') changeMapStyle(e.target.value);
});
$('#modalRoot').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-action]');
  if (b)
    try {
      await doAction(b.dataset.action, b.dataset.id, b);
    } catch {}
});
$('#openNav').onclick = () => $('#sidebar').classList.add('open');
$('#closeNav').onclick = () => $('#sidebar').classList.remove('open');
$('#railToggle').onclick = () => {
  const expanded = $('.app-shell').classList.toggle('sidebar-expanded');
  $('#railToggle').setAttribute('aria-label', expanded ? 'Collapse navigation' : 'Expand navigation');
  $('#railToggle').title = expanded ? 'Collapse navigation' : 'Expand navigation';
  setTimeout(() => {
    map?.invalidateSize();
    mapLibre?.resize();
    siteMap?.invalidateSize({ pan: false });
    reviewMap?.invalidateSize({ pan: false });
  }, 260);
};
document.addEventListener('click', (e) => {
  const menu = $('.map-tools-more');
  if (menu?.open && !menu.contains(e.target)) menu.open = false;
});
$('#fieldMode').onclick = () => {
  const target = S.officers.find((o) => o.shiftId && !o.stunned) || S.officers[0];
  const w = window.open(`/?view=field&officer=${encodeURIComponent(target?.id || '')}`, '_blank');
  if (!w) {
    fieldId = target?.id;
    go('field');
  }
};
$('#helpButton').onclick = () =>
  openModal(
    'About this Dispatch system',
    `<p>Sign-in is required. Accounts are provisioned by signed-in operators; public registration is disabled.</p><p class="form-help">Operational state and snapshots are persisted in Supabase. Browser requests go through this server; the service-role key is never sent to the browser.</p><p class="form-help">Map styles include Street, Satellite and Terrain, with 2D and pitched 3D perspectives; external basemap tiles can fail; the map switches to another provider or reports a connection issue, while dispatch overlays remain available. Live traffic needs a TomTom API key configured server-side or in Settings. Local WebRTC calls and consented local-microphone clips work between connected browser clients. SIP/PSTN, physical radios, hardware controls and external email delivery need gateways; saved audio-patch presets are configuration only.</p>`,
    'Close',
  );
$('#soundToggle').onclick = () => {
  soundEnabled = !soundEnabled;
  $('#soundToggle').style.color = soundEnabled ? '' : '#c45e52';
  if (soundEnabled) {
    try {
      window.dispatchAudio = window.dispatchAudio || new AudioContext();
      window.dispatchAudio.resume();
    } catch {}
  }
  toast(soundEnabled ? 'Alarm sound enabled' : 'Alarm sound muted');
};
$('#dismissAlarm').onclick = async () => {
  const button = $('#dismissAlarm'),
    a = S.alerts.find((x) => x.type === 'sos' && x.status === 'raised');
  if (!a) {
    $('#alarmLayer').classList.add('hidden');
    return;
  }
  focusSosAlert(a.id);
  button.disabled = true;
  try {
    await action('alert-status', { id: a.id, status: 'taken', note: 'Viewed on map and acknowledged' });
    $('#alarmLayer').classList.add('hidden');
  } catch (error) {
    toast(error?.message || 'Could not acknowledge the SOS; the alarm stays on until dispatch confirms.', true);
  } finally {
    button.disabled = false;
  }
};
$('#pageContent').addEventListener('click', (e) => {
  if (e.target.closest('#finishDraw')) {
    doAction('finish-draw');
  }
  if (e.target.closest('#cancelDraw')) doAction('cancel-draw');
});
let stateRetryAt = 0,
  stateFailureCount = 0,
  statePollBusy = false;
async function refresh() {
  if (!navigator.onLine) {
    $('#connectionText').textContent = 'Offline';
    return;
  }
  if (statePollBusy || Date.now() < stateRetryAt) return;
  statePollBusy = true;
  try {
    const since = S?.updatedAt ? `?since=${encodeURIComponent(S.updatedAt)}` : '';
    const d = await api(`/api/state${since}`);
    stateFailureCount = 0;
    stateRetryAt = 0;
    $('#connectionText').textContent = 'Connected';
    $('#connectionText').title = 'Connected to the Dispatch server';
    if (d && d.updatedAt !== S?.updatedAt) {
      const enableTraffic =
        !S?.settings?.trafficEnabled &&
        d.settings?.trafficEnabled &&
        trafficConfigured(d.settings) &&
        d.settings?.trafficProvider === 'tomtom';
      S = d;
      clearAnsweredIncomingOffers();
      if (currentPage !== 'review') render();
      if (enableTraffic && currentPage === 'overview') traffic(true);
    }
  } catch (error) {
    if (error.status === 401) {
      stopDashboardTimers();
      return;
    }
    stateFailureCount++;
    const storageDown = error.status === 503 && /supabase|storage|database/i.test(error.message);
    const delay = storageDown
      ? Math.min(30000, 2000 * 2 ** Math.min(stateFailureCount - 1, 4))
      : Math.min(4000, 500 * 2 ** Math.min(stateFailureCount - 1, 3));
    stateRetryAt = Date.now() + delay;
    // One missed poll is normal (a slow sample request); only flag a disconnect after two.
    if (stateFailureCount >= 2) {
      $('#connectionText').textContent = storageDown ? 'Storage unavailable' : 'Reconnecting';
      $('#connectionText').title =
        `${storageDown ? error.message : 'Dispatch server connection is unavailable'}; retrying in about ${Math.max(1, Math.ceil(delay / 1000))} seconds.`;
    }
  } finally {
    statePollBusy = false;
  }
}
window.addEventListener('online', () => {
  flushQueue();
  refresh();
});
window.addEventListener('offline', () => {
  $('#connectionText').textContent = 'Offline';
});
document.addEventListener('fullscreenchange', () => {
  map?.invalidateSize();
  mapLibre?.resize();
});
function showAuthGate(message = '', locked = false) {
  $('#appShell').hidden = true;
  document.body.classList.remove('authenticated');
  $('#authGate').hidden = false;
  $('#authSetupNotice').hidden = !message;
  $('#authSetupNotice').textContent = message;
  $('#authError').hidden = true;
  $('#loginButton').disabled = locked;
  const retry = $('#authRetry');
  if (retry) retry.hidden = !locked;
}
function showAuthenticatedShell(user) {
  currentUser = user;
  $('#authGate').hidden = true;
  $('#appShell').hidden = false;
  document.body.classList.add('authenticated');
  $('#authUserName').textContent = user.name || user.email?.split('@')[0] || 'Dispatch user';
  $('#authUserEmail').textContent = `${user.email || ''} · ${user.role}`;
  $('#authAvatar').textContent = initials(user.name || user.email) || 'U';
}
async function startAuthenticatedApp() {
  if (currentUser?.role === 'field') {
    try {
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
    } catch {}
    currentUser = null;
    showAuthGate(
      'This login is scoped to one field unit. Sign in through the Dispatch Field app, or use an operator account for this dashboard.',
    );
    return;
  }
  stopDashboardTimers();
  showAuthenticatedShell(currentUser);
  try {
    S = await api('/api/state');
    loadTrafficLog().catch(() => {});
    trafficOn = Boolean(
      S.settings.trafficEnabled && trafficConfigured(S.settings) && S.settings.trafficProvider !== 'here',
    );
    try {
      mapStyle = localStorage.getItem('dispatch-map-style') || 'street';
    } catch {}
    const params = new URLSearchParams(location.search);
    if (params.get('view') === 'field') {
      currentPage = 'field';
      fieldId = params.get('officer') || S.officers.find((o) => o.shiftId && !o.stunned)?.id || S.officers[0]?.id;
    }
    render();
    startRtcAgent();
    clockTimer = setInterval(() => {
      $('#clock').textContent = fmt(Date.now(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      checkSOS();
    }, 1000);
    pollTimer = setInterval(refresh, 2000);
    trafficTimer = setInterval(() => {
      if (trafficOn) sampleTraffic();
    }, 60000);
    if (trafficOn) sampleTraffic();
    flushQueue();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  } catch (e) {
    stopDashboardTimers();
    showAuthGate(`The secure session could not load Dispatch data: ${e.message}`);
  }
}
async function boot(forceCheck = false) {
  try {
    const status = await api(`/api/auth/status${forceCheck ? '?refresh=1' : ''}`);
    if (!status.configured) {
      showAuthGate(status.message || 'Server Supabase credentials are not configured.', true);
      return;
    }
    if (!status.ready) {
      showAuthGate(status.message || 'Supabase storage is not ready.', true);
      return;
    }
    // Non-blocking setup warning (for example, public sign-up still enabled).
    if (status.message) showAuthGate(status.message);
    const session = await api('/api/auth/me');
    currentUser = session.user;
    await startAuthenticatedApp();
  } catch {
    showAuthGate('Sign in to access the operations system.');
  }
}

$('#authRetry')?.addEventListener('click', () => boot(true));
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('#loginButton');
  button.disabled = true;
  $('#authError').hidden = true;
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#loginEmail').value, password: $('#loginPassword').value }),
    });
    currentUser = data.user;
    $('#loginPassword').value = '';
    await startAuthenticatedApp();
  } catch (error) {
    $('#authError').textContent = error.message;
    $('#authError').hidden = false;
  } finally {
    button.disabled = false;
  }
});
$('#logoutButton').onclick = async () => {
  try {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
  } finally {
    location.reload();
  }
};
window.DispatchDiagnostics?.instrumentGlobals();
boot();
let trafficSampling = false,
  lastTrafficErrorAt = 0,
  trafficRetryAt = 0,
  trafficFailureCount = 0;
async function sampleTraffic(force = false) {
  if (
    trafficSampling ||
    (!trafficOn && !force) ||
    (!force && Date.now() < trafficRetryAt) ||
    !trafficConfigured(S?.settings) ||
    S.settings.trafficProvider === 'here'
  )
    return;
  trafficSampling = true;
  try {
    const result = await api('/api/traffic/sample', { method: 'POST', body: JSON.stringify({ force }) });
    trafficFailureCount = 0;
    trafficRetryAt = 0;
    if (result.sampled) {
      await loadTrafficLog({ force: true });
      refresh();
    }
    if (result.failedCount) {
      const message = `Live flow sampled at ${result.sampledCount || 0} sites; ${result.failedCount} failed.`;
      setTrafficStatus(message, result.sampled ? '' : 'error');
    }
  } catch (error) {
    trafficFailureCount++;
    const delay = Math.min(30 * 60 * 1000, 60000 * 2 ** Math.min(trafficFailureCount - 1, 5));
    trafficRetryAt = Date.now() + delay;
    if (Date.now() - lastTrafficErrorAt > 60000) {
      toast(`Live traffic unavailable: ${error.message}`, true);
      lastTrafficErrorAt = Date.now();
      setTrafficStatus(
        `TomTom flow unavailable · ${error.message}. Retrying in ${Math.ceil(delay / 60000)} min.`,
        'error',
      );
    }
  } finally {
    trafficSampling = false;
  }
}
function geojsonSites() {
  const feature = (zone, kind) => {
    let ring = zone.coordinates.map((p) => [p[1], p[0]]);
    if (ring.length && !(ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1])) ring = [...ring, ring[0]];
    const t = kind === 'site' ? latestTraffic(zone.id) : null,
      color =
        zone.areaType === 'restricted' ? zone.color || '#c65b51' : t ? trafficColor(t.level) : zone.color || '#648b73';
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        id: zone.id,
        kind,
        name: zone.name,
        type: zone.areaType,
        color,
        traffic: t?.level || '',
        speed: t?.currentSpeed ?? '',
        free: t?.freeFlowSpeed ?? '',
      },
    };
  };
  return {
    type: 'FeatureCollection',
    features: [...S.sites.map((s) => feature(s, 'site')), ...S.regions.map((r) => feature(r, 'region'))],
  };
}

function libreStyle() {
  const raster =
    mapStyle === 'satellite'
      ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
      : mapStyle === 'topo'
        ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'
        : mapLibreBaseTileUrl();
  const sources = {
    base: { type: 'raster', tiles: [raster], tileSize: 256, attribution: mapAttribution() },
    sites: { type: 'geojson', data: geojsonSites() },
    'site-draw': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    'measure-line': { type: 'geojson', data: measurementFeatureCollection() },
  };
  const layers = [
    { id: 'background', type: 'background', paint: { 'background-color': '#0b0f17' } },
    { id: 'base-raster', type: 'raster', source: 'base', paint: { 'raster-opacity': 1 } },
    { id: 'site-fill', type: 'fill', source: 'sites', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.2 } },
    { id: 'site-outline', type: 'line', source: 'sites', paint: { 'line-color': ['get', 'color'], 'line-width': 2 } },
    {
      id: 'site-draw-line',
      type: 'line',
      source: 'site-draw',
      paint: { 'line-color': '#38bdf8', 'line-width': 3, 'line-dasharray': [2, 1] },
    },
    {
      id: 'measure-line',
      type: 'line',
      source: 'measure-line',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#38bdf8', 'line-width': 3, 'line-dasharray': [2, 1] },
    },
  ];
  if (mapStyle === 'satellite') {
    sources.labels = {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution: 'Labels © Esri',
    };
    layers.splice(2, 0, { id: 'imagery-labels', type: 'raster', source: 'labels', paint: { 'raster-opacity': 0.9 } });
  }
  if (trafficOn && trafficConfigured(S.settings) && S.settings.trafficProvider !== 'here') {
    sources['live-traffic'] = {
      type: 'raster',
      tiles: [trafficTilesUrl()],
      tileSize: 256,
      attribution: 'Traffic © TomTom',
    };
    layers.splice(mapStyle === 'satellite' ? 3 : 2, 0, {
      id: 'live-traffic-layer',
      type: 'raster',
      source: 'live-traffic',
      paint: { 'raster-opacity': 0.95 },
    });
  }
  return { version: 8, sources, layers };
}

function fallbackTo2DMap(message = '3D map unavailable · using 2D') {
  mapMode = '2d';
  mapTransition = false;
  $('#map3dBtn')?.classList.remove('active');
  $('#map2dBtn')?.classList.add('active');
  $('#map3d')?.classList.add('hidden');
  $('#map')?.classList.remove('hidden');
  if (!map) initMap();
  else map.invalidateSize();
  if (message) toast(message);
}
function initMapLibre() {
  mapLibreMarkers = new Map();
  mapLibreDataSignatures = { units: '', sites: '' };
  if (!window.maplibregl) {
    $('#map3d').innerHTML =
      '<div class="empty-state">3D renderer did not load. Use the 2D map or check MapLibre assets.</div>';
    return;
  }
  try {
    const center = map3dView?.center || (map ? map.getCenter() : { lat: -26.1037, lng: 28.0585 }),
      zoom = map3dView?.zoom || (map ? map.getZoom() : 14);
    mapLibreReady = false;
    mapLibre = new maplibregl.Map({
      container: 'map3d',
      style: libreStyle(),
      center: [center.lng, center.lat],
      zoom,
      pitch: map3dView?.pitch ?? 58,
      bearing: map3dView?.bearing ?? -18,
      maxPitch: 75,
      attributionControl: false,
      renderWorldCopies: false,
      fadeDuration: 0,
      maxTileCacheSize: 128,
      maxTileCacheZoomLevels: 4,
      refreshExpiredTiles: true,
      collectResourceTiming: false,
    });
    mapLibre.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    mapLibre.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'top-left');
    mapLibre.on('mousemove', (e) => {
      $('#mapCoordinates').textContent = `LAT ${e.lngLat.lat.toFixed(5)} · LNG ${e.lngLat.lng.toFixed(5)}`;
    });
    mapLibre.on('moveend', () => {
      if (mapLibre) {
        const c = mapLibre.getCenter();
        map3dView = {
          center: { lat: c.lat, lng: c.lng },
          zoom: mapLibre.getZoom(),
          pitch: mapLibre.getPitch(),
          bearing: mapLibre.getBearing(),
        };
      }
    });
    mapLibre.on('sourcedata', (e) => {
      if (e.sourceId === 'live-traffic' && e.sourceDataType === 'content' && trafficOn)
        setTrafficStatus('TomTom live traffic tiles loaded', 'ok');
    });
    let baseErrors = 0,
      baseFallback = false;
    mapLibre.on('error', (e) => {
      window.DispatchDiagnostics?.record(
        'maplibre.error',
        { source: e.sourceId || '', message: e.error?.message || 'MapLibre error' },
        'error',
      );
      if (e.sourceId === 'base') {
        baseErrors++;
        if (
          !baseFallback &&
          mapStyle === 'street' &&
          S.settings.mapProvider === 'Esri World Street Map' &&
          baseErrors >= 4
        ) {
          baseFallback = true;
          const source = mapLibre.getSource('base');
          source?.setTiles?.(['https://tile.openstreetmap.org/{z}/{x}/{y}.png']);
          mapLibre.addControl(
            new maplibregl.AttributionControl({ compact: true, customAttribution: '© OpenStreetMap contributors' }),
            'bottom-right',
          );
          setTrafficStatus('Primary basemap unavailable · switched to OpenStreetMap', 'error');
        } else if (baseFallback && baseErrors >= 8)
          setTrafficStatus('Basemap tiles unavailable · check your connection', 'error');
      }
      if (e.sourceId === 'live-traffic' && trafficOn) {
        window.DispatchDiagnostics?.record('map.traffic.tile.error', { mode: '3d', provider: 'TomTom' });
        setTrafficStatus('TomTom traffic tiles failed · check API access and network', 'error');
      }
    });
    mapLibre.on('load', () => {
      mapLibreReady = true;
      syncMapLibreTrafficLayer();
      refreshMapLibre();
      renderMeasurements();
      if (mapTransition && mapMode === '3d') beginMapModeTransition('3d', mapTransitionTarget);
      mapLibre.on('click', 'site-fill', (e) => {
        const p = e.features?.[0]?.properties,
          target = p && (p.kind === 'region' ? S.regions.find((x) => x.id === p.id) : site(p.id));
        if (target)
          new maplibregl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(p.kind === 'region' ? regionMapPopup(target) : siteMapPopup(target))
            .addTo(mapLibre);
      });
      mapLibre.on('mouseenter', 'site-fill', () => (mapLibre.getCanvas().style.cursor = 'pointer'));
      mapLibre.on('mouseleave', 'site-fill', () => (mapLibre.getCanvas().style.cursor = ''));
    });
    mapLibre.on('click', (e) => {
      if (drawMode) {
        drawPoints.push([e.lngLat.lat, e.lngLat.lng]);
        const src = mapLibre.getSource('site-draw');
        if (src && drawPoints.length > 1)
          src.setData({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: drawPoints.map((p) => [p[1], p[0]]) },
            properties: {},
          });
      } else if (measureMode) measurePoint(e.lngLat.lat, e.lngLat.lng);
    });
  } catch (e) {
    window.DispatchDiagnostics?.record(
      'map3d.init.failed',
      { message: e?.message || String(e), webglSupported: MAPLIBRE_3D_SUPPORTED },
      'error',
    );
    console.error('3D map init failed', e);
    try {
      mapLibre?.remove();
    } catch {}
    mapLibre = null;
    mapLibreReady = false;
    $('#map3d').innerHTML =
      `<div class="empty-state"><strong>3D view unavailable</strong>${esc(e.message || e)}<br>Using the 2D map instead.</div>`;
  }
}
function refreshMapLibre() {
  if (!mapLibre || !mapLibreReady) return;
  const updateSource = (id, key, data) => {
    const src = mapLibre.getSource(id);
    if (!src) return;
    const signature = JSON.stringify(data);
    if (mapLibreDataSignatures[key] !== signature) {
      src.setData(data);
      mapLibreDataSignatures[key] = signature;
    }
  };
  updateSource('sites', 'sites', geojsonSites());
  const used = new Set();
  const upsert = (key, coordinates, anchor, className, update, popupHtml = null, onClick = null) => {
    let item = mapLibreMarkers.get(key);
    if (!item) {
      const element = document.createElement('div');
      element.className = className;
      const marker = new maplibregl.Marker({ element, anchor }).setLngLat(coordinates).addTo(mapLibre);
      item = { marker, element, coordinates: null, popup: null, popupHtml: null };
      mapLibreMarkers.set(key, item);
      if (onClick) element.addEventListener('click', onClick);
      if (popupHtml) {
        item.popup = new maplibregl.Popup({ offset: 18 }).setHTML(popupHtml);
        item.marker.setPopup(item.popup);
        item.popupHtml = popupHtml;
      }
    }
    if (!item.coordinates || item.coordinates[0] !== coordinates[0] || item.coordinates[1] !== coordinates[1]) {
      item.marker.setLngLat(coordinates);
      item.coordinates = [coordinates[0], coordinates[1]];
    }
    if (item.element.className !== className) item.element.className = className;
    update(item.element);
    if (popupHtml !== null && item.popupHtml !== popupHtml) {
      if (item.popup) item.popup.setHTML(popupHtml);
      else {
        item.popup = new maplibregl.Popup({ offset: 18 }).setHTML(popupHtml);
        item.marker.setPopup(item.popup);
      }
      item.popupHtml = popupHtml;
    }
    used.add(key);
    return item;
  };
  for (const siteRecord of S.sites) {
    const pts = siteRecord.coordinates,
      mid = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
    upsert(`site:${siteRecord.id}`, [mid[1], mid[0]], 'center', 'site-label libre-site-label', (el) => {
      if (el.textContent !== siteRecord.name) el.textContent = siteRecord.name;
    });
  }
  for (const region of S.regions) {
    const pts = region.coordinates,
      mid = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]),
      label = `${region.name} · ZONE`;
    upsert(`region:${region.id}`, [mid[1], mid[0]], 'center', 'site-label libre-site-label', (el) => {
      if (el.textContent !== label) el.textContent = label;
    });
  }
  for (const o of S.officers) {
    if (!Number.isFinite(o.lat) || !Number.isFinite(o.lng)) continue;
    const color = !o.shiftId
        ? '#949e99'
        : o.stunned
          ? '#c65b51'
          : o.status === 'on-site'
            ? '#4b9267'
            : o.status === 'left-site'
              ? '#c65b51'
              : '#d59a39',
      html = `<b>${esc(initials(o.callSign))}</b><small>${esc(o.callSign)}</small>`,
      popupHtml = `<b>${esc(o.callSign)} · ${esc(o.name)}</b><br>${esc(status(o))} · ${esc(site(o.siteId)?.name || 'No site')}<br>${o.online ? 'Online' : 'Offline'} · GPS ±${Math.round(o.accuracy || 0)}m<br><button onclick="window.quickMessage('${esc(o.id)}')">Message unit</button>`;
    upsert(
      `unit:${o.id}`,
      [o.lng, o.lat],
      'bottom',
      'libre-unit',
      (el) => {
        if (el.style.background !== color) el.style.background = color;
        if (el.innerHTML !== html) el.innerHTML = html;
      },
      popupHtml,
      () => selectMapUnit(o.id, false),
    );
  }
  for (const [key, item] of mapLibreMarkers)
    if (!used.has(key)) {
      item.marker.remove();
      mapLibreMarkers.delete(key);
    }
  if (trafficOn && trafficConfigured(S.settings) && S.settings.trafficProvider !== 'here') {
    if (!mapLibre.getSource('live-traffic'))
      mapLibre.addSource('live-traffic', {
        type: 'raster',
        tiles: [trafficTilesUrl()],
        tileSize: 256,
        attribution: 'Traffic © TomTom',
      });
    if (!mapLibre.getLayer('live-traffic-layer'))
      mapLibre.addLayer(
        { id: 'live-traffic-layer', type: 'raster', source: 'live-traffic', paint: { 'raster-opacity': 0.95 } },
        'site-fill',
      );
  } else if (mapLibre.getLayer('live-traffic-layer')) {
    mapLibre.removeLayer('live-traffic-layer');
    mapLibre.removeSource('live-traffic');
  }
}
function finishMapModeTransition() {
  if (mapSwitchTimer) {
    clearTimeout(mapSwitchTimer);
    mapSwitchTimer = null;
  }
  mapTransition = false;
  const wrap = document.querySelector('.dashboard-map .map-wrap');
  wrap?.classList.remove('map-switching', 'switch-to-2d', 'switch-to-3d', 'map-transition-active');
  if (mapMode === '3d') {
    $('#map').classList.add('hidden');
    $('#map3d').classList.remove('hidden');
    mapLibre?.resize();
    if (mapLibreReady) refreshMapLibre();
  } else {
    $('#map3d').classList.add('hidden');
    $('#map').classList.remove('hidden');
    map?.invalidateSize();
    if (map) refreshMap();
  }
  if (trafficOn) traffic(true);
}
function beginMapModeTransition(next, target) {
  const wrap = document.querySelector('.dashboard-map .map-wrap');
  if (!wrap) return finishMapModeTransition();
  const duration = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 1250;
  wrap.classList.add('map-switching', next === '3d' ? 'switch-to-3d' : 'switch-to-2d');
  requestAnimationFrame(() => {
    wrap.classList.add('map-transition-active');
    if (next === '3d' && mapLibreReady)
      mapLibre?.easeTo({
        pitch: target.pitch,
        bearing: target.bearing,
        duration,
        essential: true,
        easing: (t) => t * (2 - t),
      });
    else if (next === '2d' && mapLibreReady)
      mapLibre?.easeTo({ pitch: 0, bearing: 0, duration, essential: true, easing: (t) => t * (2 - t) });
  });
  mapSwitchTimer = setTimeout(finishMapModeTransition, duration + 160);
}
async function setMapMode(mode) {
  const next = mode === '3d' ? '3d' : '2d';
  if (next === '3d')
    try {
      await loadOptionalMapLibre();
    } catch (error) {
      const button = $('#map3dBtn');
      if (button) {
        button.disabled = true;
        button.title = error.message;
      }
      window.DispatchDiagnostics?.record('map3d.unsupported', { reason: error.message }, 'warn');
      fallbackTo2DMap(error.message);
      return;
    }
  if (next === mapMode && !mapTransition) return;
  if (mapSwitchTimer) {
    clearTimeout(mapSwitchTimer);
    mapSwitchTimer = null;
  }
  document
    .querySelector('.dashboard-map .map-wrap')
    ?.classList.remove('map-switching', 'switch-to-2d', 'switch-to-3d', 'map-transition-active');
  mapTransition = true;
  const target = { pitch: map3dView?.pitch ?? 58, bearing: map3dView?.bearing ?? -18 };
  mapTransitionTarget = target;
  if (next === '3d') {
    if (map) {
      const center = map.getCenter();
      map3dView = { center: { lat: center.lat, lng: center.lng }, zoom: map.getZoom(), pitch: 0, bearing: 0 };
    }
    $('#map').classList.remove('hidden');
    $('#map3d').classList.remove('hidden');
    if (!mapLibre) initMapLibre();
    else {
      mapLibre.resize();
      if (map && map3dView)
        mapLibre.jumpTo({
          center: [map3dView.center.lng, map3dView.center.lat],
          zoom: map3dView.zoom,
          pitch: 0,
          bearing: 0,
        });
      if (mapLibreReady) refreshMapLibre();
    }
    if (!mapLibre) {
      mapMode = '2d';
      $('#map2dBtn')?.classList.toggle('active', true);
      $('#map3dBtn')?.classList.toggle('active', false);
      if (!map) initMap();
      finishMapModeTransition();
      toast('3D map is unavailable; staying in 2D.', true);
      return;
    }
    mapMode = '3d';
    $('#map2dBtn')?.classList.toggle('active', false);
    $('#map3dBtn')?.classList.toggle('active', true);
    if (mapLibreReady) beginMapModeTransition(next, target);
  } else {
    if (mapLibre) {
      const center = mapLibre.getCenter();
      if (!map) initMap();
      map?.setView([center.lat, center.lng], mapLibre.getZoom(), { animate: false });
    }
    $('#map3d').classList.remove('hidden');
    $('#map').classList.remove('hidden');
    map?.invalidateSize();
    mapMode = '2d';
    $('#map2dBtn')?.classList.toggle('active', true);
    $('#map3dBtn')?.classList.toggle('active', false);
    if (mapLibreReady) beginMapModeTransition(next, target);
    else finishMapModeTransition();
  }
  if (trafficOn) traffic(true);
}
function changeMapStyle(style) {
  mapStyle = ['street', 'satellite', 'topo'].includes(style) ? style : 'street';
  try {
    localStorage.setItem('dispatch-map-style', mapStyle);
  } catch {}
  if (currentPage !== 'overview') return;
  if (mapMode === '3d') {
    if (mapLibre) {
      clearMapLibreMeasurementMarkers();
      mapLibre.remove();
      mapLibre = null;
      mapLibreReady = false;
    }
    initMapLibre();
  } else if (map) {
    const c = map.getCenter(),
      z = map.getZoom();
    map.remove();
    map = null;
    markerLayer = siteLayer = sitePolygonLayer = measureLayer = null;
    leafletOfficerMarkers = new Map();
    leafletSitePolygons = new Map();
    leafletSosMarkers = new Map();
    initMap();
    map.setView(c, z);
    refreshMap();
  }
}
function measureDistance(points) {
  if (!points || points.length < 2) return 0;
  const [a, b] = points,
    R = 6371000,
    toRad = (x) => (x * Math.PI) / 180,
    dLat = toRad(b[0] - a[0]),
    dLng = toRad(b[1] - a[1]),
    q = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}
function formatMeasureDistance(points) {
  const metres = measureDistance(points);
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${Math.round(metres)} m`;
}
function measureId() {
  return `measure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function startMeasure() {
  measureMode = true;
  measurePoints = [];
  editingMeasureId = null;
  renderMeasurePanel();
  toast('Click two map points to draw a measured line.');
}
function cancelMeasure() {
  measureMode = false;
  measurePoints = [];
  renderMeasurePanel();
}
function editMeasurement(id) {
  const item = measurements.find((m) => m.id === id);
  if (!item) return;
  measureMode = false;
  measurePoints = [];
  editingMeasureId = editingMeasureId === id ? null : id;
  renderMeasurements();
  if (editingMeasureId) toast('Drag either endpoint to edit the line; its distance updates as you move it.');
}
function removeMeasurement(id) {
  measurements = measurements.filter((m) => m.id !== id);
  if (editingMeasureId === id) editingMeasureId = null;
  renderMeasurements();
}
function clearMeasurements() {
  measurements = [];
  editingMeasureId = null;
  measureMode = false;
  measurePoints = [];
  renderMeasurements();
}
function measurementFeatureCollection() {
  return {
    type: 'FeatureCollection',
    features: measurements
      .filter((item) => item.points?.length === 2)
      .map((item) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: item.points.map(([lat, lng]) => [lng, lat]) },
        properties: { id: item.id },
      })),
  };
}
function updateMeasurementSource() {
  if (mapLibreReady) mapLibre?.getSource('measure-line')?.setData(measurementFeatureCollection());
}
function clearMapLibreMeasurementMarkers() {
  for (const marker of mapLibreMeasureMarkers.values()) marker.remove();
  mapLibreMeasureMarkers.clear();
}
function syncMapLibreMeasurementMarkers() {
  if (!mapLibre || !mapLibreReady || !window.maplibregl) return;
  const needed = new Set();
  for (const item of measurements) {
    if (item.points?.length !== 2) continue;
    const labelKey = `${item.id}:label`,
      mid = [(item.points[0][0] + item.points[1][0]) / 2, (item.points[0][1] + item.points[1][1]) / 2];
    needed.add(labelKey);
    let labelMarker = mapLibreMeasureMarkers.get(labelKey);
    if (!labelMarker) {
      const element = document.createElement('div');
      element.className = 'measure-distance-badge';
      labelMarker = new maplibregl.Marker({ element, anchor: 'bottom' }).setLngLat([mid[1], mid[0]]).addTo(mapLibre);
      mapLibreMeasureMarkers.set(labelKey, labelMarker);
    } else labelMarker.setLngLat([mid[1], mid[0]]);
    labelMarker.getElement().textContent = formatMeasureDistance(item.points);
    if (item.id !== editingMeasureId) continue;
    item.points.forEach((point, index) => {
      const key = `${item.id}:${index}`;
      needed.add(key);
      let marker = mapLibreMeasureMarkers.get(key);
      if (!marker) {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'measure-handle';
        element.setAttribute('aria-label', `Drag ${index === 0 ? 'start' : 'end'} of measured line`);
        marker = new maplibregl.Marker({ element, draggable: true }).setLngLat([point[1], point[0]]).addTo(mapLibre);
        marker.on('drag', () => {
          const p = marker.getLngLat();
          item.points[index] = [p.lat, p.lng];
          updateMeasurementSource();
          syncMapLibreMeasurementMarkers();
          renderMeasurePanel();
        });
        marker.on('dragend', () => renderMeasurements());
        mapLibreMeasureMarkers.set(key, marker);
      } else marker.setLngLat([point[1], point[0]]);
    });
  }
  for (const [key, marker] of [...mapLibreMeasureMarkers])
    if (!needed.has(key)) {
      marker.remove();
      mapLibreMeasureMarkers.delete(key);
    }
}
function renderLeafletMeasurements() {
  if (!measureLayer || !window.L) return;
  measureLayer.clearLayers();
  for (const item of measurements) {
    if (item.points?.length !== 2) continue;
    const editing = item.id === editingMeasureId,
      line = L.polyline(item.points, {
        color: editing ? '#f59e0b' : '#0ea5e9',
        weight: 4,
        dashArray: '7 5',
        opacity: 0.95,
      }).addTo(measureLayer);
    line.bindTooltip(formatMeasureDistance(item.points), {
      permanent: true,
      direction: 'center',
      className: 'measure-distance-label',
      offset: [0, -9],
    });
    if (editing)
      item.points.forEach((point, index) => {
        const handle = L.marker(point, {
          draggable: true,
          keyboard: true,
          icon: L.divIcon({
            className: 'measure-handle-icon',
            html: `<span>${index === 0 ? 'A' : 'B'}</span>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          }),
        }).addTo(measureLayer);
        handle.on('drag', () => {
          const p = handle.getLatLng();
          item.points[index] = [p.lat, p.lng];
          line.setLatLngs(item.points);
          line.setTooltipContent(formatMeasureDistance(item.points));
          syncMapLibreMeasurementMarkers();
          renderMeasurePanel();
        });
        handle.on('dragend', () => renderMeasurements());
      });
  }
}
function renderMeasurePanel() {
  const panel = $('#measurePanel');
  if (!panel) return;
  const visible = measureMode || measurements.length > 0;
  panel.classList.toggle('hidden', !visible);
  if (!visible) {
    panel.innerHTML = '';
    return;
  }
  const editing = measurements.find((m) => m.id === editingMeasureId);
  panel.innerHTML = `<div class="measure-panel-heading"><b>${measureMode ? 'Draw a distance' : 'Map measurements'}</b>${measureMode ? '<button class="measure-cancel" type="button" data-action="measure-cancel">Cancel</button>' : editing ? '<button class="measure-cancel" type="button" data-action="measure-done">Done editing</button>' : ''}</div>${measureMode ? `<p class="measure-hint">${measurePoints.length ? 'Choose the second endpoint.' : 'Click the first endpoint on the map.'}</p>` : ''}${editing ? '<p class="measure-hint">Drag either endpoint on the map. The length updates as you edit.</p>' : ''}<div class="measure-list">${measurements.map((item, index) => `<div class="measure-row ${item.id === editingMeasureId ? 'editing' : ''}"><span><b>${esc(formatMeasureDistance(item.points))}</b><small>Line ${index + 1}</small></span><button type="button" class="measure-action" data-action="measure-edit" data-id="${esc(item.id)}">${item.id === editingMeasureId ? 'Editing' : 'Edit'}</button><button type="button" class="measure-action remove" data-action="measure-remove" data-id="${esc(item.id)}" aria-label="Remove line ${index + 1}" title="Remove line">×</button></div>`).join('')}</div>${measurements.length ? '<button type="button" class="measure-clear" data-action="measure-clear">Remove all lines</button>' : ''}`;
}
function renderMeasurements() {
  renderLeafletMeasurements();
  updateMeasurementSource();
  syncMapLibreMeasurementMarkers();
  renderMeasurePanel();
}
function measurePoint(lat, lng) {
  if (!measureMode) return;
  if (measurePoints.length === 0) {
    measurePoints = [[lat, lng]];
    renderMeasurePanel();
    return;
  }
  measurePoints.push([lat, lng]);
  const item = { id: measureId(), points: measurePoints.slice(0, 2) };
  measurements.push(item);
  measureMode = false;
  measurePoints = [];
  editingMeasureId = null;
  renderMeasurements();
  toast(`Measured ${formatMeasureDistance(item.points)}. Use Edit to drag either endpoint or remove the line.`);
}
function locateController() {
  if (!navigator.geolocation) return toast('Browser location is unavailable', true);
  navigator.geolocation.getCurrentPosition(
    (p) => {
      if (mapMode === '3d' && mapLibre)
        mapLibre.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: 16, pitch: 55 });
      else if (map) map.setView([p.coords.latitude, p.coords.longitude], 16);
      toast('Centered on your current location');
    },
    reportLocationError,
    { enableHighAccuracy: true, timeout: 10000 },
  );
}
