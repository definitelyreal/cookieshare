// Cookie Share — MAIN-world auth interceptor
//
// Runs in the page's own JavaScript context (MAIN world) so it can
// monkey-patch window.fetch and XMLHttpRequest BEFORE the page's own
// code uses them. Intercepts Authorization headers on outgoing requests
// and forwards them to the ISOLATED-world bridge via window.postMessage.
//
// This captures tokens that chrome.webRequest in an MV3 service worker
// can miss when the SW is dormant.

(() => {
  if (window.__cookieshareAuthInterceptor) return;
  window.__cookieshareAuthInterceptor = true;

  function report(url, authValue) {
    try {
      window.postMessage(
        {
          source: 'cookieshare-auth-interceptor',
          url: String(url),
          authValue: String(authValue),
        },
        window.location.origin
      );
    } catch {}
  }

  // --- XMLHttpRequest ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const xhrUrls = new WeakMap();

  XMLHttpRequest.prototype.open = function (method, url) {
    try { xhrUrls.set(this, url); } catch {}
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (String(name).toLowerCase() === 'authorization' && value) {
        report(xhrUrls.get(this) || window.location.href, value);
      }
    } catch {}
    return origSetHeader.apply(this, arguments);
  };

  // --- fetch ---
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        let url = '';
        if (typeof input === 'string') url = input;
        else if (input && typeof input === 'object' && 'url' in input) url = input.url;

        let authValue = null;

        // Request object's own headers
        if (typeof Request !== 'undefined' && input instanceof Request) {
          try { authValue = input.headers.get('authorization'); } catch {}
        }

        // init.headers can be Headers | [[k,v]] | {k:v}
        if (!authValue && init && init.headers) {
          const h = init.headers;
          if (typeof Headers !== 'undefined' && h instanceof Headers) {
            authValue = h.get('authorization');
          } else if (Array.isArray(h)) {
            for (const pair of h) {
              if (pair && String(pair[0]).toLowerCase() === 'authorization') {
                authValue = pair[1];
                break;
              }
            }
          } else if (typeof h === 'object') {
            for (const k of Object.keys(h)) {
              if (k.toLowerCase() === 'authorization') {
                authValue = h[k];
                break;
              }
            }
          }
        }

        if (authValue) report(url || window.location.href, authValue);
      } catch {}
      return origFetch.apply(this, arguments);
    };
  }
})();
