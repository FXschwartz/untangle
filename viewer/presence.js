// Tells untangle when this page opens and when it closes. With -autoclose (the default), untangle
// stops a moment after its last open page closes; a reload opens the next page in time. The page
// also holds a socket while it's open, since some browsers drop a page without telling it (Orca's,
// as a tab closes): the socket drops with it. A page the browser freezes says it's asleep, since
// it may be discarded to save memory without a word: untangle keeps serving it. What untangle tells
// the page over the socket (the notes changed: an agent answered) goes to the page as an
// "untangle:push" event.
(function () {
  'use strict';
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const tell = (open, asleep) => {
    const body = JSON.stringify(asleep ? { id, open, asleep } : { id, open });
    // A beacon still goes as the page closes or freezes.
    if ((!open || asleep) && navigator.sendBeacon && navigator.sendBeacon('api/presence', body)) return;
    fetch('api/presence', { method: 'POST', body, keepalive: true }).catch(() => {});
  };
  let socket = null;
  let leaving = false;
  let tries = 0;
  const hold = () => {
    if (typeof WebSocket !== 'function' || leaving || (socket && socket.readyState <= WebSocket.OPEN)) return;
    const at = new URL('api/presence?id=' + encodeURIComponent(id), location.href);
    at.protocol = at.protocol === 'https:' ? 'wss:' : 'ws:';
    const s = new WebSocket(at);
    socket = s;
    // Held again after a drop, the page may have missed news: it asks.
    s.onopen = () => { if (tries) dispatchEvent(new CustomEvent('untangle:push', { detail: { notes: null } })); tries = 0; };
    s.onmessage = (e) => {
      let detail = null;
      try { detail = JSON.parse(e.data); } catch (err) { return; }
      dispatchEvent(new CustomEvent('untangle:push', { detail }));
    };
    // Dropped while the page stays (a proxy cut it, untangle stopped): held again, a few times.
    s.onclose = () => { if (socket === s && !leaving && ++tries <= 5) setTimeout(hold, 1000 * tries); };
  };
  const open = () => {
    leaving = false;
    tries = 0;
    tell(true);
    hold();
  };
  // A page the browser renders ahead of time opens only when it's shown.
  if (document.prerendering) document.addEventListener('prerenderingchange', open, { once: true });
  else open();
  addEventListener('pagehide', () => {
    leaving = true;
    tell(false);
    if (socket) socket.close();
  });
  // Back from the browser's back-forward cache, it's open again.
  addEventListener('pageshow', (e) => { if (e.persisted) open(); });
  document.addEventListener('freeze', () => tell(true, true));
  document.addEventListener('resume', open);
})();
