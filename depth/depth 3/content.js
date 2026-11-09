(() => {
  if (window.__depthC) return;
  window.__depthC = true;
  const host = location.hostname.replace(/^www\./, '');
  const send = (m) => { try { chrome.runtime.sendMessage(m).catch(() => {}); } catch (e) {} };

  // ---------- input + typing telemetry (counts only, never content) ----------
  let lastAct = 0, keys = 0, backs = 0, pauseMax = 0, lastKey = 0, bursts = 0;
  const act = () => { const n = Date.now(); if (n - lastAct > 5000) { lastAct = n; send({ t: 'ACT' }); } };
  ['mousemove', 'mousedown', 'scroll', 'touchstart', 'wheel'].forEach(e => addEventListener(e, act, { passive: true, capture: true }));
  addEventListener('keydown', (e) => {
    act();
    const t = e.target;
    if (t && (t.type === 'password' || t.autocomplete === 'cc-number')) return;
    keys++;
    if (e.key === 'Backspace' || e.key === 'Delete') backs++;
    const n = Date.now();
    if (lastKey) { const g = n - lastKey; if (g >= 1500) bursts++; if (g >= 1500 && g < 60000) pauseMax = Math.max(pauseMax, g); }
    lastKey = n;
  }, true);
  setInterval(() => { if (keys) { send({ t: 'TYPING', keys, backs, pauseMax, bursts }); keys = backs = pauseMax = bursts = 0; } }, 15000);

  // ---------- YouTube ----------
  function yt() {
    if (!/(^|\.)youtube\.com$/.test(host)) return null;
    const v = document.querySelector('video');
    if (!v) return null;
    const u = new URL(location.href);
    const id = u.searchParams.get('v') || (u.pathname.startsWith('/shorts/') ? u.pathname.split('/')[2] : '');
    if (!id) return null;
    const title = (document.querySelector('h1.ytd-watch-metadata yt-formatted-string, ytd-watch-metadata h1, h1 yt-formatted-string')?.textContent || document.title.replace(/ - YouTube$/, '')).trim();
    const channel = (document.querySelector('#owner #channel-name a, ytd-channel-name a')?.textContent || '').trim();
    const caption = [...document.querySelectorAll('.ytp-caption-segment')].map(e => e.textContent).join(' ').slice(0, 300);
    return { id, title, channel, t: Math.floor(v.currentTime || 0), dur: Math.floor(isFinite(v.duration) ? v.duration : 0), paused: v.paused, ad: !!document.querySelector('.ad-showing'), caption, speed: v.playbackRate, url: 'https://www.youtube.com/watch?v=' + id, shorts: u.pathname.startsWith('/shorts/') };
  }

  // ---------- YouTube transcript (cached per video) ----------
  let trCache = { id: null, ev: null };
  async function loadTranscript(id) {
    if (trCache.id === id && trCache.ev) return trCache.ev;
    trCache = { id, ev: null };
    try {
      const html = await (await fetch(location.href, { credentials: 'include' })).text();
      const m = html.match(/"captionTracks":(\[.*?\])/);
      if (!m) return (trCache.ev = []);
      const tracks = JSON.parse(m[1]);
      const tk = tracks.find(t => t.languageCode === 'en' && !t.kind) || tracks.find(t => t.languageCode === 'en') || tracks.find(t => !t.kind) || tracks[0];
      if (!tk) return (trCache.ev = []);
      const j = await (await fetch(tk.baseUrl.replace(/\\u0026/g, '&') + '&fmt=json3', { credentials: 'include' })).json();
      trCache.ev = (j.events || []).filter(e => e.segs).map(e => ({ s: Math.round((e.tStartMs || 0) / 1000), x: e.segs.map(g => g.utf8).join('').replace(/\s+/g, ' ').trim() })).filter(e => e.x);
    } catch (e) { trCache.ev = []; }
    return trCache.ev;
  }
  async function transcriptAt(at) {
    const y = yt(); if (!y) return null;
    const ev = await loadTranscript(y.id);
    if (!ev.length) return y.caption ? { text: y.caption, range: [at, at] } : null;
    const from = Math.max(0, at - 180), to = at + 5;
    const w = ev.filter(e => e.s >= from && e.s <= to);
    if (!w.length) return null;
    return { text: w.map(e => e.x).join(' ').slice(-3500), range: [from, to] };
  }

  // ---------- AI chat adapters ----------
  function chat() {
    let nodes = [];
    const h = host;
    if (/deepseek/.test(h)) {
      nodes = [...document.querySelectorAll('.ds-markdown, div[class*="fbb737a4"]')].map(n => ({ r: n.classList.contains('ds-markdown') ? 'ai' : 'user', x: n.innerText }));
    } else if (/claude\.ai/.test(h)) {
      nodes = [...document.querySelectorAll('[data-testid="user-message"], .font-claude-response, div[class*="font-claude-message"]')].map(n => ({ r: n.matches('[data-testid="user-message"]') ? 'user' : 'ai', x: n.innerText }));
    } else if (/chatgpt|openai/.test(h)) {
      nodes = [...document.querySelectorAll('[data-message-author-role]')].map(n => ({ r: n.getAttribute('data-message-author-role') === 'user' ? 'user' : 'ai', x: n.innerText }));
    } else {
      nodes = [];
    }
    const messages = nodes.filter(n => n.x && n.x.trim()).slice(-10).map(n => ({ r: n.r, x: n.x.trim().slice(0, 700) }));
    const streaming = !!document.querySelector('[data-is-streaming="true"], button[aria-label*="Stop" i]');
    const tail = messages.length >= 2 ? undefined : (document.querySelector('main')?.innerText || document.body.innerText || '').trim().slice(-3000);
    return { messages, streaming, tail };
  }

  const page = () => ({ t: 'PAGE', url: location.href, title: document.title, host, visible: document.visibilityState === 'visible', focus: document.hasFocus(), yt: yt(), scroll: Math.round(scrollY) });
  setInterval(() => { if (document.visibilityState === 'visible') send(page()); }, 12000);
  setTimeout(() => send(page()), 800);
  ['play', 'pause', 'seeked'].forEach(e => document.addEventListener(e, () => setTimeout(() => send(page()), 150), true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') send(page()); });

  // ---------- Toast (shadow DOM) ----------
  let toastEl = null, hideT = null;
  function toast(m) {
    if (window !== top) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;';
      const root = toastEl.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",Helvetica,Arial,sans-serif}
        .c{width:340px;background:linear-gradient(160deg,#0b2230,#071820);color:#e8f1f2;border:1px solid rgba(120,230,215,.28);border-radius:16px;padding:14px 14px 12px;box-shadow:0 18px 50px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.3);animation:in .35s cubic-bezier(.2,.8,.2,1)}
        @keyframes in{from{transform:translateY(14px);opacity:0}to{transform:none;opacity:1}}
        .h{display:flex;align-items:center;gap:8px;margin-bottom:8px;color:#7fe6d8;font-size:12px;font-weight:600;letter-spacing:.02em}
        .o{width:10px;height:10px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#d9fff9,#35c9b5 60%,#0e6f7a);box-shadow:0 0 12px #35c9b5}
        .x{margin-left:auto;cursor:pointer;opacity:.5;font-size:16px;line-height:1}.x:hover{opacity:1}
        .t{font-size:13.5px;line-height:1.45;white-space:pre-wrap}
        .q{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
        .q button{background:rgba(127,230,216,.1);color:#bff5ee;border:1px solid rgba(127,230,216,.25);border-radius:999px;padding:5px 10px;font-size:12px;cursor:pointer}
        .q button:hover{background:rgba(127,230,216,.2)}
        .r{display:flex;gap:6px;margin-top:10px}
        .r input{flex:1;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.12);color:#fff;border-radius:10px;padding:8px 10px;font-size:13px;outline:none}
        .r input:focus{border-color:#35c9b5}
        .r button{background:#35c9b5;color:#052026;border:0;border-radius:10px;padding:0 12px;font-weight:600;cursor:pointer}
      </style><div class="c"><div class="h"><span class="o"></span><span>Depth</span><span class="x" id="x">×</span></div><div class="t" id="t"></div><div class="q" id="q"></div><div class="r"><input id="i" placeholder="Reply…"><button id="s">Send</button></div></div>`;
      document.documentElement.appendChild(toastEl);
      const $ = (id) => root.getElementById(id);
      $('x').onclick = () => { toastEl.style.display = 'none'; };
      const go = (txt) => { if (!txt.trim()) return; send({ t: 'USER_MSG', text: txt, via: 'toast' }); $('i').value = ''; toastEl.style.display = 'none'; };
      $('s').onclick = () => go($('i').value);
      $('i').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go($('i').value); else send({ t: 'PANEL_TYPING' }); }, true);
      toastEl.addEventListener('mouseenter', () => clearTimeout(hideT));
      toastEl._root = root; toastEl._go = go;
    }
    const root = toastEl._root;
    root.getElementById('t').textContent = m.text;
    const q = root.getElementById('q'); q.innerHTML = '';
    (m.qr || []).slice(0, 3).forEach(s => { const b = document.createElement('button'); b.textContent = s; b.onclick = () => toastEl._go(s); q.appendChild(b); });
    toastEl.style.display = 'block';
    clearTimeout(hideT);
    hideT = setTimeout(() => { toastEl.style.display = 'none'; }, 60000);
  }

  chrome.runtime.onMessage.addListener((m, _s, res) => {
    if (m.t === 'GET_CHAT') { res(chat()); }
    else if (m.t === 'GET_TRANSCRIPT') { transcriptAt(m.at || 0).then(r => res(r || {})).catch(() => res({})); return true; }
    else if (m.t === 'GET_PAGE') { res(page()); }
    else if (m.t === 'TOAST') { toast(m); res(1); }
  });
})();
