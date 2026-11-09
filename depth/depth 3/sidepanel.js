const $ = (i) => document.getElementById(i);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MIN = 60000;
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const send = (m) => chrome.runtime.sendMessage(m).catch(() => {});
const DEF = { enabled: true, geminiKey: '', geminiModel: 'gemini-3.5-flash-lite', camera: true, screen: true, chatRead: true, social: false, voice: false, heartbeatMin: 10, lullSec: 120, discussDelaySec: 60, inactivityMin: 5, blockHours: 2, studyAllow: ['chat.deepseek.com'], goalsToday: '', excluded: [] };
const CATC = { ai_chat: 'var(--c-ai_chat)', study_site: 'var(--c-study_site)', media: 'var(--c-media)', social_feed: 'var(--c-social_feed)', messaging: 'var(--c-messaging)', shopping: 'var(--c-shopping)', work: 'var(--c-work)', other: 'var(--c-other)', idle: 'var(--c-idle)', offbrowser: 'var(--c-offbrowser)', private: 'var(--c-private)', internal: 'var(--c-internal)' };
const CATN = { ai_chat: 'AI chat', study_site: 'Study site', media: 'Video', social_feed: 'Feeds', messaging: 'Messaging', shopping: 'Shopping', work: 'Work', other: 'Other', idle: 'Idle', offbrowser: 'Outside Chrome', private: 'Private' };
const PHASES = [['OBSERVE', 'Observe'], ['DISCUSS', 'Discuss'], ['LULL', 'Lull'], ['ANALYSIS', 'Analyze'], ['ACCOUNTABILITY', 'Account'], ['NEGOTIATE', 'Negotiate'], ['STUDY_WATCH', 'Study watch'], ['ENFORCE', 'Enforce'], ['VERIFY', 'Verify']];
const MODS = [
  ['study', 'Study', 'Accountability, task tracking, explaining steps. Reads your AI chats to judge real work.', ['Blocks with consent: yes', 'Reads chats', 'Inactivity checks']],
  ['media', 'Media', 'Watches with you and discusses ideas first. No judging, no blocking.', ['Blocks: no', 'YouTube timestamps', 'Discuss first']],
  ['shopping', 'Shopping', 'Observes spending patterns. Comments only when asked or when impulse looks clear.', ['Blocks: no', 'Observe only']],
  ['social', 'Social', 'Messaging apps. Interaction analysis only when you enable it in Setup.', ['Blocks: no', 'Opt-in']],
  ['work', 'Work', 'eBay, Fiverr, code. Helps you ship, tracks tasks, never blocks.', ['Blocks: no', 'Task tracking']],
  ['wellbeing', 'Wellbeing', 'Late nights, light, posture, breaks, fatigue. Gentle, never blocks.', ['Blocks: no', 'Camera clues', 'Fatigue aware']]
];
let D = {}, tab = 'now', openRec = new Set(), panelPort = null;

try { panelPort = chrome.runtime.connect({ name: 'panel' }); } catch (e) {}

async function load() {
  D = await chrome.storage.local.get(['settings', 'status', 'chat', 'evid', 'seg', 'samples', 'commits', 'profile', 'state', 'stats', 'day', 'ledger']);
  D.settings = { ...DEF, ...(D.settings || {}) };
}
let rT = null;
const schedule = () => { clearTimeout(rT); rT = setTimeout(async () => { await load(); render(); }, 150); };
chrome.storage.onChanged.addListener((c, a) => { if (a === 'local' && Object.keys(c).some(k => k !== 'settings' || true)) schedule(); });

// ---------------- tabs
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => setTab(b.dataset.t));
function setTab(t) {
  tab = t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  document.querySelectorAll('main>section').forEach(s => s.hidden = s.id !== 's-' + t);
  render();
  if (t === 'talk') { const c = $('chat'); c.scrollTop = c.scrollHeight; }
}

// ---------------- render
function render() {
  renderHeader();
  if (tab === 'now') renderNow();
  if (tab === 'talk') renderTalk();
  if (tab === 'time') renderTime();
  if (tab === 'goals') renderGoals();
  if (tab === 'mods') renderMods();
  if (tab === 'depth') renderDepth();
  if (tab === 'setup') renderSetup();
}
function renderHeader() {
  const st = D.status || {};
  const b = $('chipBrain');
  b.className = 'chip ' + (st.brain === 'ok' ? 'ok' : st.brain === 'nokey' || st.brain === 'error' ? 'bad' : 'warn');
  b.textContent = st.busy ? 'Gemini thinking' : st.brain === 'ok' ? 'Gemini ready' : st.brain === 'nokey' ? 'Add API key' : st.brain === 'error' ? 'Gemini: unreachable' : 'Gemini idle';
  const c = $('chipCam');
  c.className = 'chip ' + (st.cam === 'ok' ? 'ok' : st.cam === 'denied' ? 'bad' : 'warn');
  c.textContent = st.cam === 'ok' ? 'Camera' : st.cam === 'denied' ? 'Camera blocked' : st.cam === 'off' ? 'Camera off' : 'Camera?';
  $('pause').textContent = D.settings.enabled ? 'Pause' : 'Resume';
}

// orb
const cv = $('orb'), cx = cv.getContext('2d');
let orbState = { hue: [77, 227, 209], speed: 0.6, amp: 5 }, t0 = performance.now();
function orbFor(st) {
  if (!D.settings.enabled) return { hue: [91, 127, 134], speed: 0.15, amp: 2, title: 'Paused', sub: 'Depth is not watching' };
  if (st.quietUntil > Date.now()) return { hue: [91, 127, 134], speed: 0.2, amp: 2, title: 'Quiet', sub: 'back at ' + hm(st.quietUntil) };
  if (st.busy) return { hue: [138, 167, 255], speed: 2.2, amp: 9, title: 'Thinking', sub: 'Gemini is reading your context' };
  if (st.block?.active) return { hue: [255, 122, 107], speed: 0.5, amp: 4, title: 'Holding the line', sub: 'Study block until ' + hm(st.block.until) };
  if (st.awaiting) return { hue: [240, 217, 168], speed: 0.9, amp: 7, title: 'Waiting for you', sub: 'A question is open' };
  if (st.discussion?.active && !st.discussion.analysisDone) return { hue: [127, 240, 192], speed: 1.1, amp: 7, title: 'Talking it through', sub: st.discussion.title ? st.discussion.title.slice(0, 40) : 'Discussing what you watch' };
  return { hue: [77, 227, 209], speed: 0.6, amp: 5, title: 'Observing', sub: st.host ? st.host + (st.input_idle > 120 ? ' · quiet ' + Math.round(st.input_idle / 60) + ' min' : '') : 'Starting up' };
}
function drawOrb(now) {
  const t = (now - t0) / 1000, W = 440, c = W / 2;
  cx.clearRect(0, 0, W, W);
  const [r, g, b] = orbState.hue;
  const glow = cx.createRadialGradient(c, c, 10, c, c, 210);
  glow.addColorStop(0, `rgba(${r},${g},${b},.38)`); glow.addColorStop(.55, `rgba(${r},${g},${b},.08)`); glow.addColorStop(1, 'rgba(0,0,0,0)');
  cx.fillStyle = glow; cx.fillRect(0, 0, W, W);
  for (let i = 0; i < 7; i++) { // depth layers: deeper rings are slower, dimmer, wider
    const base = 56 + i * 21, sp = orbState.speed * (1 - i * 0.1), amp = orbState.amp * (0.6 + i * 0.25);
    cx.beginPath();
    for (let k = 0; k <= 96; k++) {
      const a = k / 96 * Math.PI * 2;
      const rr = base + Math.sin(a * 3 + t * sp + i * 1.3) * amp + Math.sin(a * 5 - t * sp * 0.7 + i) * amp * 0.5;
      const x = c + Math.cos(a) * rr, y = c + Math.sin(a) * rr;
      k ? cx.lineTo(x, y) : cx.moveTo(x, y);
    }
    cx.closePath();
    cx.strokeStyle = `rgba(${r},${g},${b},${0.7 - i * 0.09})`; cx.lineWidth = 2.4 - i * 0.2; cx.stroke();
    if (i === 0) { cx.fillStyle = `rgba(${r},${g},${b},.16)`; cx.fill(); }
  }
}
let last = 0;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
function loop(now) { if (!document.hidden && now - last > 40 && !reduce) { last = now; drawOrb(now); } requestAnimationFrame(loop); }
requestAnimationFrame(loop); if (reduce) drawOrb(0);

function renderNow() {
  const st = D.status || {}, o = orbFor(st);
  orbState = o; $('stateTitle').textContent = o.title; $('stateSub').textContent = o.sub;
  const ph = st.phase || 'OBSERVE', idx = PHASES.findIndex(p => p[0] === ph);
  $('phases').innerHTML = PHASES.map((p, i) => `<span class="${p[0] === ph ? 'on' : i < idx ? 'done' : ''}">${p[1]}</span>`).join('');
  const ev = (D.evid || []).slice(-1)[0];
  $('hyp').innerHTML = '<h3>Current reading</h3>' + (ev ? ((ev.hypotheses || []).slice(0, 3).map(h => `<div class="hyp"><p>${esc(h.text)}</p><div class="bar"><i style="width:${Math.round((h.confidence || 0) * 100)}%"></i></div></div>`).join('') + (ev.uncertainty ? `<div class="muted">Cannot tell: ${esc(ev.uncertainty)}</div>` : '') + `<div class="muted" style="margin-top:6px">${hm(ev.ts)} · ${esc(ev.module)} · ${Math.round(ev.confidence * 100)}% sure</div>`) : '<div class="muted">No reading yet. Press Look now to get one.</div>');
  const y = st.yt;
  const kv = (k, v, w) => `<div class="kv ${w ? 'wide' : ''}"><b>${k}</b><span>${esc(v)}</span></div>`;
  $('live').innerHTML = [
    kv('Active tab', (st.host || '-') + (st.title ? ' · ' + st.title : ''), 1),
    kv('Category', CATN[st.cat] || st.cat || '-'),
    kv('Input idle', st.input_idle != null ? (st.input_idle > 90 ? Math.round(st.input_idle / 60) + ' min' : st.input_idle + ' s') : '-'),
    kv('Typing (10 min)', st.typing ? `${st.typing.keys_10m} keys · ${Math.round(st.typing.backspace_ratio * 100)}% back` : '-'),
    kv('Light', st.light ? st.light + (st.motion != null ? ' · motion ' + st.motion : '') : '-'),
    y ? kv('YouTube', `${fmt(y.est)} of ${fmt(y.dur)}${y.paused ? ' · paused' : ''} · ${y.title}`, 1) : '',
    st.study ? kv('Study task', st.study.label, 1) : ''
  ].join('');
  const S = st.sensors || {};
  $('senses').innerHTML = [['tab', 'Tabs'], ['input', 'Input'], ['typing', 'Typing'], ['youtube', 'YouTube'], ['chats', 'AI chats'], ['screen', 'Screen'], ['cam', 'Camera'], ['history', 'Memory'], ['phone', 'Phone bridge']].map(([k, n]) => `<span class="${S[k] ? 'on' : ''}">${n}</span>`).join('');
}
const fmt = (s) => { s = s || 0; const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

// talk
function renderTalk() {
  const st = D.status || {}, chat = D.chat || [];
  $('talkState').textContent = st.quietUntil > Date.now() ? 'Quiet until ' + hm(st.quietUntil) : st.busy ? 'Thinking…' : '';
  const evMap = Object.fromEntries((D.evid || []).map(e => [e.id, e]));
  const lastAi = [...chat].reverse().find(m => m.role === 'ai');
  const el = $('chat'), atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (!chat.length) { el.innerHTML = '<div class="msg sys">No conversation yet. Say hello, or press Look now on the first tab.</div>'; return; }
  el.innerHTML = chat.map(m => {
    if (m.role === 'sys') return `<div class="msg sys">${esc(m.text)}</div>`;
    if (m.role === 'user') return `<div class="msg user">${esc(m.text)}</div>`;
    const ev = m.evid ? evMap[m.evid] : null, open = openRec.has(m.id);
    let h = `<div class="msg ai">${esc(m.text)}`;
    if (m.actions?.length) h += m.actions.map(a => `<div class="act"><button class="go" data-block='${esc(JSON.stringify(a))}'>Block all except ${esc(a.allow.join(', '))}</button><button data-quick="Not now">Not now</button></div>`).join('');
    if (m === lastAi && m.qr?.length) h += `<div class="qr">${m.qr.map(q => `<button data-quick="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
    h += `<div class="meta"><span>${hm(m.ts)}${m.module ? ' · ' + esc(m.module) : ''}${m.conf != null ? ' · ' + Math.round(m.conf * 100) + '%' : ''}</span>${ev ? `<button data-rec="${m.id}">${open ? 'Hide' : 'Why?'}</button>` : ''}</div>`;
    if (ev && open) h += `<div class="recpt"><b>What I saw</b><ul>${(ev.evidence || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>${ev.uncertainty ? `<div class="muted">Cannot tell: ${esc(ev.uncertainty)}</div>` : ''}<div class="th">${ev.thumbs?.screen ? `<img src="${ev.thumbs.screen}">` : ''}${ev.thumbs?.cam ? `<img src="${ev.thumbs.cam}">` : ''}</div>${ev.feedback ? `<div class="muted">You marked this ${esc(ev.feedback)}.</div>` : `<div class="act"><button data-fb="right" data-id="${ev.id}">Fair</button><button data-fb="wrong" data-id="${ev.id}">You misread me</button></div>`}</div>`;
    return h + '</div>';
  }).join('');
  if (atEnd) el.scrollTop = el.scrollHeight;
}
$('chat').addEventListener('click', (e) => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.rec) { openRec.has(t.dataset.rec) ? openRec.delete(t.dataset.rec) : openRec.add(t.dataset.rec); renderTalk(); }
  else if (t.dataset.quick) send({ t: 'USER_MSG', text: t.dataset.quick, via: 'chip' });
  else if (t.dataset.block) { const a = JSON.parse(t.dataset.block); send({ t: 'BLOCK_NOW', allow: a.allow, minutes: a.minutes }); }
  else if (t.dataset.fb) { const text = t.dataset.fb === 'wrong' ? prompt('What did I get wrong? (optional)') || '' : ''; send({ t: 'EVID_FEEDBACK', id: t.dataset.id, value: t.dataset.fb, text }); }
});
const inp = $('inp');
const go = () => { const v = inp.value.trim(); if (!v) return; send({ t: 'USER_MSG', text: v, via: 'panel' }); inp.value = ''; inp.style.height = 'auto'; };
$('send').onclick = go;
inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } else send({ t: 'PANEL_TYPING' }); });
inp.addEventListener('input', () => { inp.style.height = 'auto'; inp.style.height = Math.min(120, inp.scrollHeight) + 'px'; });
$('q30').onclick = () => send({ t: 'QUIET', minutes: 30 });
$('qoff').onclick = () => send({ t: 'QUIET', minutes: 0 });
$('look').onclick = () => { send({ t: 'LOOK_NOW' }); setTab('talk'); };

// voice input
let rec = null;
$('mic').onclick = () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('Voice input not supported in this Chrome.'); return; }
  if (rec) { rec.stop(); return; }
  rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
  $('mic').classList.add('live'); $('mic').textContent = 'Stop';
  rec.onresult = (e) => { inp.value = [...e.results].map(r => r[0].transcript).join(' '); };
  rec.onerror = (e) => { if (e.error === 'not-allowed') chrome.tabs.create({ url: 'setup.html' }); };
  rec.onend = () => { $('mic').classList.remove('live'); $('mic').textContent = 'Mic'; rec = null; if (inp.value.trim()) go(); };
  rec.start();
};

// timeline
function renderTime() {
  const seg = D.seg || { list: [], cur: null }, now = Date.now();
  const all = [...seg.list, ...(seg.cur ? [seg.cur] : [])];
  const from = Math.max(D.day?.firstActive || now - 12 * 3600e3, now - 24 * 3600e3), span = Math.max(now - from, MIN);
  const segs = all.filter(x => x.end > from);
  $('strip').innerHTML = segs.map(x => { const l = (Math.max(x.start, from) - from) / span * 100, w = Math.max(0.25, (x.end - Math.max(x.start, from)) / span * 100); return `<i title="${esc(x.host)} ${hm(x.start)}" style="left:${l}%;width:${w}%;background:${CATC[x.category] || CATC.other}"></i>`; }).join('');
  const tot = {}; segs.forEach(x => tot[x.category] = (tot[x.category] || 0) + (x.end - x.start));
  $('legend').innerHTML = Object.entries(tot).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span><b style="background:${CATC[k] || CATC.other}"></b>${CATN[k] || k} ${Math.round(v / MIN)}m</span>`).join('') || '<span class="muted">Nothing recorded yet.</span>';
  $('samples').innerHTML = (D.samples || []).slice(-14).reverse().map(s => `<figure>${s.cam ? `<img src="${s.cam}">` : ''}${hm(s.ts)}<br>${s.bright != null ? 'light ' + s.bright : ''}</figure>`).join('') || '<span class="muted">Ambient samples appear every few minutes.</span>';
  const merged = [];
  for (const x of segs) { const m = merged[merged.length - 1]; if (m && m.host === x.host && m.category === x.category && (m.ytId || '') === (x.ytId || '') && x.start - m.end < 2 * MIN) { m.end = x.end; m.keys += x.keys || 0; if (x.title) m.title = x.title; } else merged.push({ ...x, keys: x.keys || 0 }); }
  $('segs').innerHTML = merged.slice(-40).reverse().map(m => `<div class="seg"><time>${hm(m.start)}–${hm(m.end)}</time><div><strong><span class="dot" style="background:${CATC[m.category] || CATC.other}"></span>${esc(m.host)}</strong><em>${esc((m.title || '').slice(0, 70))} · ${Math.max(1, Math.round((m.end - m.start) / MIN))} min${m.keys ? ' · ' + m.keys + ' keys' : ''}</em></div></div>`).join('') || '<div class="muted">No segments yet.</div>';
}

// goals
let planDirty = false;
$('plan').addEventListener('input', () => { planDirty = true; });
function renderGoals() {
  if (!planDirty) $('plan').value = D.day?.plan || D.settings.goalsToday || '';
  const cs = (D.commits || []).slice(-30).reverse();
  $('commits').innerHTML = cs.length ? cs.map(c => `<div class="commit ${c.status}"><input type="checkbox" data-c="${c.id}" ${c.status === 'done' ? 'checked' : ''} style="width:auto"><span>${esc(c.text)}${c.due ? ' <small class="muted">· ' + hm(c.due) + '</small>' : ''}</span><small class="muted">${esc(c.kind)}</small></div>`).join('') : '<div class="muted">No commitments. Tell Depth "I will study at 3" and it will hold you to your own word.</div>';
  const notes = (D.profile?.notes || []).slice(-12).reverse();
  $('mem').innerHTML = notes.length ? notes.map(n => `<div style="margin-bottom:6px">${esc(n.note)}</div>`).join('') : 'Durable facts Gemini learns about you appear here.';
}
$('savePlan').onclick = async () => { const v = $('plan').value; planDirty = false; await chrome.storage.local.set({ settings: { ...D.settings, goalsToday: v } }); send({ t: 'PLAN', text: v }); };
$('cAdd').onclick = () => { const v = $('cText').value.trim(); if (v) { send({ t: 'ADD_COMMIT', text: v }); $('cText').value = ''; } };
$('commits').addEventListener('change', (e) => { if (e.target.dataset.c) send({ t: 'COMMIT_STATUS', id: e.target.dataset.c, status: e.target.checked ? 'done' : 'open' }); });

// modules
function renderMods() {
  const muted = D.state?.muted || [];
  $('modList').innerHTML = MODS.map(([k, n, d, tags]) => `<div class="card mod"><div><div class="nm">${n}</div><p>${d}</p><div class="tags">${tags.map(t => `<span class="${/Blocks: no/.test(t) ? 'no' : /yes/.test(t) ? 'yes' : ''}">${t}</span>`).join('')}</div></div><div class="sw"><input type="checkbox" id="m_${k}" data-m="${k}" ${muted.includes(k) ? '' : 'checked'}><label for="m_${k}"></label></div></div>`).join('');
}
$('modList').addEventListener('change', (e) => { if (e.target.dataset.m) send({ t: 'MUTE', module: e.target.dataset.m, on: !e.target.checked }); });

// depth metric
function renderDepth() {
  const st = D.stats || {}, seg = D.seg || { list: [], cur: null }, now = Date.now(), S = D.status?.sensors || {};
  const all = [...seg.list, ...(seg.cur ? [seg.cur] : [])].filter(x => x.end > (D.day?.firstActive || now - 6 * 3600e3));
  const start = D.day?.firstActive || now - 6 * 3600e3;
  let covered = 0, gapLimit = 3 * MIN, cursor = start;
  all.sort((a, b) => a.start - b.start).forEach(x => { if (x.start - cursor <= gapLimit) covered += x.end - Math.max(x.start, cursor) + Math.max(0, x.start - cursor); else covered += x.end - x.start; cursor = Math.max(cursor, x.end); });
  const total = Math.max(MIN, now - start);
  const temporal = Math.min(1, covered / total);
  const dims = Object.values(S).filter(Boolean).length / 9;
  const modules = Math.min(1, ((st.modules || []).length) / 5);
  const cases = Math.min(1, (st.cases || []).length / 9);
  const unc = st.uncertain ? Math.min(1, st.uncertainAsked / st.uncertain) : 0.5;
  const fb = st.interventions ? Math.min(1, (st.verified + st.followed) / (st.interventions * 2)) : 0.4;
  const cal = (st.right + st.wrong) ? st.right / (st.right + st.wrong) : 0.5;
  const fail = st.errors ? Math.min(1, st.recovered / st.errors) : 0.7;
  const F = [['Temporal continuity', temporal, 'Share of today with unbroken timeline'], ['Context dimensions', dims, 'Senses fused right now'], ['Cross-module links', modules, 'Modules the brain acted in'], ['Edge-case coverage', cases, 'Special situations handled'], ['Uncertainty handling', unc, 'Asked instead of assuming when unsure'], ['Feedback loops', fb, 'Interventions verified or followed'], ['Calibration', cal, 'Your verdicts on its readings'], ['Failure recovery', fail, 'Errors recovered from']];
  const W = [1.3, 1, 0.8, 1, 1.2, 1.2, 1, 0.7];
  const score = Math.round(F.reduce((a, f, i) => a + f[1] * W[i], 0) / W.reduce((a, b) => a + b, 0) * 100);
  $('dScore').textContent = score;
  const zone = score < 25 ? ['Surface', 'Snapshots, little memory'] : score < 50 ? ['Twilight', 'Aware, still gappy'] : score < 75 ? ['Midnight', 'Continuous and connected'] : ['Abyss', 'Fully woven context'];
  $('dZone').textContent = zone[0]; $('dHint').textContent = zone[1];
  $('dBars').innerHTML = F.map(f => `<div class="dbar"><div><span>${f[0]}</span><small>${Math.round(f[1] * 100)}%</small></div><div class="bar"><i style="width:${Math.round(f[1] * 100)}%"></i></div><small class="muted">${f[2]}</small></div>`).join('');
  $('cases').innerHTML = (st.cases || []).length ? st.cases.map(c => `<span>${esc(c.replace(/_/g, ' '))}</span>`).join('') : '<span>None yet</span>';
}

// setup
let setupLoaded = false;
function renderSetup() {
  const s = D.settings;
  const L = (D.ledger || []).slice(-6).reverse().map(x => `${hm(x.ts)} ${x.trigger}: ${x.screen ? 'screen ' : ''}${x.cam ? 'cam ' : ''}${x.chats} chats, ${x.tabs} tabs`).join('<br>');
  $('ledger').innerHTML = L || 'Nothing sent yet.';
  if (setupLoaded) return; setupLoaded = true;
  ['geminiKey', 'geminiModel', 'heartbeatMin', 'lullSec', 'discussDelaySec', 'inactivityMin', 'blockHours'].forEach(k => $(k).value = s[k]);
  ['camera', 'screen', 'chatRead', 'social', 'voice'].forEach(k => $(k).checked = !!s[k]); $('webGemini').checked = s.webGemini !== false;
  $('studyAllow').value = (s.studyAllow || []).join(', '); $('excluded').value = (s.excluded || []).join(', ');
}
$('saveSet').onclick = async () => {
  const n = (k) => Number($(k).value), list = (k) => $(k).value.split(',').map(x => x.trim()).filter(Boolean);
  const s = { ...D.settings, geminiKey: $('geminiKey').value.trim(), geminiModel: $('geminiModel').value.trim() || DEF.geminiModel, heartbeatMin: n('heartbeatMin'), lullSec: n('lullSec'), discussDelaySec: n('discussDelaySec'), inactivityMin: n('inactivityMin'), blockHours: n('blockHours'), studyAllow: list('studyAllow'), excluded: list('excluded') };
  ['camera', 'screen', 'chatRead', 'social', 'voice'].forEach(k => s[k] = $(k).checked); s.webGemini = $('webGemini').checked;
  await chrome.storage.local.set({ settings: s }); $('saveSet').textContent = 'Saved'; setTimeout(() => $('saveSet').textContent = 'Save settings', 1200);
};
$('testG').onclick = async () => { await $('saveSet').onclick(); $('testOut').textContent = 'Testing Gemini…'; const r = await chrome.runtime.sendMessage({ t: 'GEMINI_TEST' }).catch(() => null); $('testOut').textContent = r?.ok ? 'Gemini works.' : 'Failed: ' + (r?.error || 'no response'); };
$('camSetup').onclick = () => chrome.tabs.create({ url: 'setup.html' });
$('camTest').onclick = async () => { $('testOut').textContent = 'Testing…'; const r = await chrome.runtime.sendMessage({ t: 'SNAP_TEST' }).catch(() => null); $('testOut').textContent = r?.ok ? 'Camera works.' : 'Camera failed (' + (r?.cam || 'unknown') + '). Run camera setup.'; };
$('wipe').onclick = () => { if (confirm('Delete timeline, chat, memory, samples and stats?')) send({ t: 'WIPE' }); };
$('export').onclick = () => { const b = new Blob([JSON.stringify({ day: D.day, seg: D.seg, commits: D.commits, profile: D.profile, stats: D.stats }, null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'depth-timeline.json'; a.click(); };
$('pause').onclick = async () => { await chrome.storage.local.set({ settings: { ...D.settings, enabled: !D.settings.enabled } }); };

load().then(() => { render(); if (!D.settings.geminiKey) setTab('setup'); });
setInterval(() => { if (!document.hidden) load().then(() => { if (tab === 'now' || tab === 'time') render(); }); }, 15000);
