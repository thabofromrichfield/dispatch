/* Local-only diagnostic capture for Dispatch. Never upload logs or record form values. */
(() => {
  const STORAGE_KEY = 'dispatch-diagnostics-events-v1';
  const ENABLED_KEY = 'dispatch-diagnostics-enabled-v1';
  const MAX_EVENTS = 12000;
  const FLUSH_MS = 2000;
  const sensitiveKey = /(password|passwd|secret|token|authorization|api[_-]?key|service[_-]?role|cookie|credential)/i;
  const initialGlobals = new Set(Object.getOwnPropertyNames(window));
  let events = [];
  let enabled = true;
  let flushTimer = null;
  let panelOpen = false;
  let countUpdatePending = false;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) events = parsed.slice(-MAX_EVENTS);
    }
    if (localStorage.getItem(ENABLED_KEY) === 'false') enabled = false;
  } catch {}
  function redactText(value) {
    return String(value ?? '')
      .slice(0, 1600)
      .replace(/(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
      .replace(
        /((?:password|passwd|secret|token|authorization|api[_-]?key|service[_-]?role|cookie|credential)\s*[=:]\s*)[^\s&,;]+/gi,
        '$1[redacted]',
      )
      .replace(/([?&](?:key|token|apikey|api_key|access_token|password|secret)=)[^&#\s]*/gi, '$1[redacted]');
  }
  function clean(value, key = '', depth = 0) {
    if (sensitiveKey.test(key)) return '[redacted]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return redactText(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
    if (depth > 3) return `[${Array.isArray(value) ? 'array' : 'object'}]`;
    if (Array.isArray(value)) return value.slice(0, 16).map((v) => clean(v, '', depth + 1));
    if (typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value).slice(0, 32)) out[k] = clean(value[k], k, depth + 1);
      return out;
    }
    return String(value);
  }
  function persistSoon() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
      } catch {}
    }, FLUSH_MS);
  }
  function record(name, details = {}, level = 'info') {
    if (!enabled) return null;
    const event = {
      at: new Date().toISOString(),
      source: 'browser',
      level: String(level).slice(0, 16),
      name: String(name || 'event').slice(0, 100),
      details: clean(details),
    };
    events.push(event);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    persistSoon();
    updateCount();
    return event;
  }
  function describeArg(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return `string(${value.length})`;
    if (typeof value === 'number' || typeof value === 'boolean') return typeof value;
    if (typeof value === 'function') return `function(${value.name || 'anonymous'})`;
    if (Array.isArray(value)) return `array(${value.length})`;
    if (value instanceof Element) return `element(${value.tagName.toLowerCase()})`;
    if (typeof value === 'object')
      return `object{${Object.keys(value)
        .filter((k) => !sensitiveKey.test(k))
        .slice(0, 12)
        .join(',')}}`;
    return typeof value;
  }
  function summarizeCall(name, args) {
    const summary = {
      arguments: Array.from(args || [])
        .slice(0, 8)
        .map(describeArg),
    };
    if (name === 'api' && typeof args?.[0] === 'string') {
      try {
        summary.route = new URL(args[0], location.origin).pathname;
      } catch {
        summary.route = String(args[0]).split('?')[0].slice(0, 120);
      }
      const opts = args[1];
      if (opts && typeof opts === 'object') summary.method = String(opts.method || 'GET').toUpperCase();
    }
    if (name === 'action' && args?.[0] && typeof args[0] === 'object')
      summary.action = String(args[0].type || 'unknown').slice(0, 80);
    return summary;
  }
  function instrumentGlobals() {
    const names = Object.getOwnPropertyNames(window);
    for (const name of names) {
      if (initialGlobals.has(name) || name === 'DispatchDiagnostics') continue;
      let original;
      try {
        original = window[name];
      } catch {
        continue;
      }
      if (typeof original !== 'function' || original.__dispatchDiagnosticWrapped) continue;
      const wrapped = function (...args) {
        const started = performance.now(),
          event = record('function.call', { function: name, ...summarizeCall(name, args), outcome: 'running' });
        const finish = (outcome, error) => {
          if (!event) return;
          event.level = error ? 'error' : 'info';
          Object.assign(event.details, { outcome, durationMs: Math.round(performance.now() - started) });
          if (error) event.details.error = clean(error?.message || String(error), 'error');
          persistSoon();
        };
        let result;
        try {
          result = Reflect.apply(original, this, args);
        } catch (error) {
          finish('threw', error);
          throw error;
        }
        if (result && typeof result.then === 'function')
          return Promise.resolve(result).then(
            (value) => {
              finish('fulfilled');
              return value;
            },
            (error) => {
              finish('rejected', error);
              throw error;
            },
          );
        finish('returned');
        return result;
      };
      Object.defineProperty(wrapped, '__dispatchDiagnosticWrapped', { value: true });
      try {
        Object.defineProperty(window, name, { configurable: true, writable: true, value: wrapped });
      } catch {}
    }
    record('diagnostics.instrumented', {
      globalFunctions: names.filter((n) => !initialGlobals.has(n) && typeof window[n] === 'function').length,
      recording: enabled,
    });
  }
  function identifyControl(target) {
    return {
      tag: target.tagName?.toLowerCase() || '',
      id: target.id || '',
      className: typeof target.className === 'string' ? target.className.slice(0, 100) : '',
      action: target.dataset?.action || '',
      page: target.dataset?.page || '',
      pageLink: target.dataset?.pageLink || '',
      name: target.getAttribute?.('name') || '',
      ariaLabel: target.getAttribute?.('aria-label') || '',
      title: target.getAttribute?.('title') || '',
    };
  }
  function createPanel() {
    if (!document.body || document.getElementById('dispatchDiagnostics')) return;
    const root = document.createElement('aside');
    root.id = 'dispatchDiagnostics';
    root.className = 'dispatch-diagnostics';
    root.innerHTML =
      '<button class="dispatch-diagnostics-fab" id="diagFab" type="button" aria-label="Open local diagnostics" title="Open local diagnostics" aria-expanded="false" aria-controls="diagPanel"><span class="diag-status-dot" aria-hidden="true"></span><span class="diag-fab-label">Diagnostics</span><b id="diagCount">0</b></button><section class="dispatch-diagnostics-panel" id="diagPanel" hidden><header><div><b>Local diagnostics</b><small id="diagState">Recording in this browser</small></div><button type="button" id="diagClose" aria-label="Close diagnostics">×</button></header><p>Captures function calls, controls used, API status, and errors. Form values, passwords, and keys are excluded. Logs stay on this device until you download them.</p><div class="diag-actions"><button type="button" id="diagPause">Pause recording</button><button type="button" id="diagDownload">Download log</button><button type="button" id="diagClear">Clear browser log</button></div><small class="diag-count-label">Recent events are capped at 12,000. Attach the downloaded JSON when reporting a problem.</small></section>';
    document.body.appendChild(root);
    const fab = root.querySelector('#diagFab'),
      panel = root.querySelector('#diagPanel'),
      pause = root.querySelector('#diagPause');
    fab.addEventListener('click', () => {
      panelOpen = !panelOpen;
      panel.hidden = !panelOpen;
      fab.setAttribute('aria-expanded', String(panelOpen));
    });
    root.querySelector('#diagClose').addEventListener('click', () => {
      panelOpen = false;
      panel.hidden = true;
      fab.setAttribute('aria-expanded', 'false');
    });
    pause.addEventListener('click', () => {
      if (enabled) {
        record('diagnostics.paused', {});
        enabled = false;
      } else {
        enabled = true;
        record('diagnostics.resumed', {});
      }
      try {
        localStorage.setItem(ENABLED_KEY, String(enabled));
      } catch {}
      updatePanel();
    });
    root.querySelector('#diagClear').addEventListener('click', () => {
      if (!confirm('Clear the diagnostic history saved in this browser?')) return;
      events = [];
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {}
      record('diagnostics.cleared', {});
      updatePanel();
    });
    root.querySelector('#diagDownload').addEventListener('click', download);
    updatePanel();
  }
  function updateCount() {
    if (countUpdatePending) return;
    countUpdatePending = true;
    const draw = () => {
      countUpdatePending = false;
      const count = document.getElementById('diagCount');
      if (count) count.textContent = String(events.length);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(draw);
    else setTimeout(draw, 0);
  }
  function updatePanel() {
    const status = document.getElementById('diagState'),
      pause = document.getElementById('diagPause'),
      dot = document.querySelector('.diag-status-dot');
    if (status) status.textContent = enabled ? 'Recording locally in this browser' : 'Recording paused';
    if (pause) pause.textContent = enabled ? 'Pause recording' : 'Resume recording';
    if (dot) dot.classList.toggle('paused', !enabled);
    updateCount();
  }
  async function download() {
    const button = document.getElementById('diagDownload');
    if (button) button.disabled = true;
    try {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
        } catch {}
      }
      let serverEvents = [],
        serverLog = 'unavailable (no active authenticated server session)';
      try {
        if (typeof window.api === 'function') {
          const response = await window.api('/api/diagnostics/export');
          serverEvents = response.events || [];
          serverLog = 'included';
        }
      } catch (error) {
        serverLog = redactText(error?.message || 'unavailable');
      }
      const payload = {
        format: 'dispatch-diagnostics-v1',
        createdAt: new Date().toISOString(),
        privacy: {
          capturedFormValues: false,
          uploadedAutomatically: false,
          storage: 'browser localStorage plus local server data/diagnostics.ndjson',
        },
        runtime: {
          page: location.pathname,
          online: navigator.onLine,
          language: navigator.language,
          userAgent: navigator.userAgent,
          viewport: { width: innerWidth, height: innerHeight },
        },
        serverLog,
        counts: { browser: events.length, server: serverEvents.length },
        browserEvents: events,
        serverEvents,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
        url = URL.createObjectURL(blob),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `dispatch-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      record('diagnostics.downloaded', { browserEvents: events.length, serverEvents: serverEvents.length });
    } finally {
      if (button) button.disabled = false;
    }
  }
  window.DispatchDiagnostics = { record, instrumentGlobals, getEvents: () => events.slice(), isEnabled: () => enabled };
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target?.closest?.('button,[role="button"],a,summary,input[type="submit"]');
      if (target) record('ui.activate', identifyControl(target));
    },
    true,
  );
  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target;
      if (form instanceof HTMLFormElement)
        record('ui.submit', {
          id: form.id || '',
          name: form.getAttribute('name') || '',
          fields: Array.from(form.elements || [])
            .filter((x) => x.name)
            .map((x) => ({ name: x.name, type: x.type || x.tagName.toLowerCase() }))
            .slice(0, 40),
        });
    },
    true,
  );
  document.addEventListener(
    'input',
    (event) => {
      const input = event.target;
      if (
        input instanceof HTMLInputElement ||
        input instanceof HTMLTextAreaElement ||
        input instanceof HTMLSelectElement
      )
        record('ui.input', {
          id: input.id || '',
          name: input.name || '',
          type: input.type || input.tagName.toLowerCase(),
        });
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (
        ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Spacebar'].includes(
          event.key,
        )
      )
        record('ui.key', {
          key: event.key,
          target: identifyControl(
            event.target?.closest?.('button,[role="button"],input,select,textarea') || event.target,
          ),
        });
    },
    true,
  );
  window.addEventListener(
    'error',
    (event) => {
      const error = event.error;
      record(
        'browser.error',
        {
          message: event.message || error?.message || 'Resource load error',
          source: event.filename ? redactText(event.filename.split('?')[0]) : '',
          line: event.lineno || 0,
          column: event.colno || 0,
          stack: error?.stack || '',
        },
        'error',
      );
    },
    true,
  );
  window.addEventListener('unhandledrejection', (event) =>
    record(
      'browser.unhandledrejection',
      {
        reason: event.reason?.message || String(event.reason || 'Unknown rejection'),
        stack: event.reason?.stack || '',
      },
      'error',
    ),
  );
  window.addEventListener('online', () => record('browser.network', { state: 'online' }));
  window.addEventListener('offline', () => record('browser.network', { state: 'offline' }));
  window.addEventListener('pagehide', () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
    } catch {}
  });
  const originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    record(
      'console.error',
      {
        arguments: args
          .slice(0, 5)
          .map((x) => (typeof x === 'string' ? redactText(x) : x?.message ? redactText(x.message) : typeof x)),
      },
      'error',
    );
    originalConsoleError(...args);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', createPanel, { once: true });
  else createPanel();
})();
