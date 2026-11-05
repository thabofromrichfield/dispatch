(() => {
  const native = window.DispatchNative;
  if (!native || window.__dispatchNativeFetchInstalled) return;
  window.__dispatchNativeFetchInstalled = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = function(input, init = {}) {
    let url;
    try {
      url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    } catch (_) {
      return realFetch(input, init);
    }
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const body = init.body !== undefined ? init.body : null;
    if (body != null && typeof body !== 'string' && !(body instanceof URLSearchParams)) return realFetch(input, init);
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    const headerObject = {};
    headers.forEach((value, key) => headerObject[key] = value);
    try {
      const raw = native.request(url.pathname + url.search, method, JSON.stringify(headerObject), body == null ? '' : String(body));
      const result = JSON.parse(raw);
      return Promise.resolve(new Response(result.body || '', {
        status: result.status || 200,
        headers: result.headers || {}
      }));
    } catch (error) {
      return Promise.reject(error);
    }
  };
})();
