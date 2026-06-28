// Cookie Share — ISOLATED-world bridge
//
// Receives Authorization header captures from the MAIN-world interceptor
// via window.postMessage and forwards them to the service worker over
// chrome.runtime.sendMessage (which is not available from MAIN world).

(() => {
  if (window.__cookieshareAuthBridge) return;
  window.__cookieshareAuthBridge = true;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'cookieshare-auth-interceptor') return;
    if (!data.authValue) return;

    try {
      chrome.runtime.sendMessage({
        type: 'capturedAuth',
        url: data.url,
        authValue: data.authValue,
      }).catch(() => {});
    } catch {}
  });
})();
