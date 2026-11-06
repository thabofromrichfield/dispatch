(() => {
  const native = window.DispatchNative;
  const pending = new Map();
  let sequence = 0;

  window.DispatchNativeResolve = (id, raw) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    try { request.resolve(JSON.parse(raw)); }
    catch (_) { request.resolve({ status: 503, body: JSON.stringify({ error: 'Invalid server response' }) }); }
  };

  window.DispatchAPI = {
    request(path, method = 'GET', body = '') {
      if (native?.requestAsync) {
        const id = `field-${Date.now()}-${++sequence}`;
        return new Promise(resolve => {
          const timer = setTimeout(() => {
            const request = pending.get(id);
            if (!request) return;
            pending.delete(id);
            request.resolve({ status: 504, body: JSON.stringify({ error: 'The server took too long to respond' }) });
          }, 50000);
          pending.set(id, { resolve, timer });
          native.requestAsync(path, method, JSON.stringify({
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {})
          }), body, id);
        });
      }
      return fetch(path, {
        method,
        credentials: 'same-origin',
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body } : {})
      }).then(async response => ({ status: response.status, body: await response.text() }));
    }
  };
})();
