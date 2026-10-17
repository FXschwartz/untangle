// Tells untangle when this page opens and when it closes. With -autoclose (the default), untangle
// stops a moment after its last open page closes; a reload opens the next page in time. A page
// the browser discards to save memory says nothing, so untangle keeps serving it.
(function () {
  'use strict';
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const tell = (open) => {
    const body = JSON.stringify({ id, open });
    // A beacon still goes as the page closes.
    if (!open && navigator.sendBeacon && navigator.sendBeacon('api/presence', body)) return;
    fetch('api/presence', { method: 'POST', body, keepalive: true }).catch(() => {});
  };
  // A page the browser renders ahead of time opens only when it's shown.
  if (document.prerendering) document.addEventListener('prerenderingchange', () => tell(true), { once: true });
  else tell(true);
  addEventListener('pagehide', () => tell(false));
  // Back from the browser's back-forward cache, it's open again.
  addEventListener('pageshow', (e) => { if (e.persisted) tell(true); });
})();
