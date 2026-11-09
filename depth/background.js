import { get, set, patch, sget } from './lib/store.js';
import { classify, isPrivate } from './lib/categories.js';
import { SYSTEM_PROMPT, buildTurn } from './lib/prompt.js';

const MIN = 60000, HOUR = 3600000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 9);
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error('timeout')), ms))]);
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const iso = (t) => { const d = new Date(t), p = n => String(n).padStart(2, '0'), o = -d.getTimezoneOffset(), sg = o >= 0 ? '+' : '-'; return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sg}${p(Math.floor(Math.abs(o) / 60))}:${p(Math.abs(o) % 60)}`; };

const defState = () => ({ phase: 'OBSERVE', discussion: { active: false }, ignored: 0, silentAsks: 0, quietUntil: 0, muted: [], block: { active: false }, offered: null, studyTask: null, awaitingReply: null, lastAiAt: 0, lastUserAt: 0, lastAnalysisAt: 0, lastStudyCheck: 0, lastDiscussStart: 0, lastWellbeing: 0, intervention: null, pendingReturn: null, lastResult: null, feedback: null });
const defStats = () => ({ consults: 0, silent: 0, asks: 0, uncertain: 0, uncertainAsked: 0, interventions: 0, verified: 0, followed: 0, right: 0, wrong: 0, gates: 0, errors: 0, recovered: 0, cases: [], modules: [] });

const RT = { pages: {}, active: null, idle: 'active', idleSince: 0, lastInputAt: Date.now(), lastTypeAt: 0, typing: [], ports: 0, cam: 'unknown', brain: 'unknown', busy: false, queue: [], imgs: null, lastSample: 0, lastDayWrite: 0, err: false, lastBright: null, lastMotion: null, ytSeen: null };

// ------------------------------------------------------------ runtime persistence
let saveT = null;
const saveRT = () => { clearTimeout(saveT); saveT = setTimeout(() => chrome.storage.session.set({ rt: { lastInputAt: RT.lastInputAt, lastTypeAt: RT.lastTypeAt, idle: RT.idle, idleSince: RT.idleSince, cam: RT.cam, lastSample: RT.lastSample } }).catch(() => {}), 1500); };
const hydrate = (async () => { try { const { rt } = await chrome.storage.session.get('rt'); if (rt) Object.assign(RT, rt); } catch (e) {} })();

// ------------------------------------------------------------ day / wake model
async function markActive() {
  const now = Date.now();
  if (now - RT.lastDayWrite < 30000) return;
  RT.lastDayWrite = now;
  const s = await sget();
  await patch('day', {}, (d) => {
    if (!d.firstActive || now - (d.lastActive || 0) >= 4 * HOUR) {
      return { date: iso(now).slice(0, 10), firstActive: now, prevLastActive: d.lastActive || null, plan: s.goalsToday || '', askedPlan: false, summary: '', lastActive: now };
    }
    d.lastActive = now;
  });
}

// ------------------------------------------------------------ timeline segments
async function setCurrent(info) {
  const now = Date.now();
  await patch('seg', { cur: null, list: [] }, (s) => {
    const key = info ? `${info.kind}|${info.host}|${info.ytId || ''}` : 'off';
    const c = s.cur;
    if (c && c.key === key) { c.end = now; if (info && info.title) c.title = info.title; return; }
    if (c) { c.end = now; if (c.end - c.start >= 3000) s.list.push(c); }
    s.cur = info ? { key, start: now, end: now, ...info } : { key: 'off', start: now, end: now, kind: 'off', host: '(outside Chrome)', category: 'offbrowser', module: 'general', title: '' };
    if (s.list.length > 1500) s.list = s.list.slice(-1200);
  });
}

async function computeActive() {
  const s = await sget();
  if (RT.idle !== 'active') return { kind: 'idle', host: '(idle)', category: 'idle', module: 'general', title: '' };
  const w = await chrome.windows.getLastFocused().catch(() => null);
  if (!w || !w.focused) return null;
  const [t] = await chrome.tabs.query({ active: true, windowId: w.id });
  if (!t || !t.url) return null;
  const c = classify(t.url);
  const priv = isPrivate(t.url, s);
  const pg = RT.pages[t.id];
  return { kind: 'tab', tabId: t.id, windowId: w.id, url: priv ? '' : t.url, host: priv ? '(private)' : c.host, title: priv ? '(private)' : (t.title || '').slice(0, 120), category: priv ? 'private' : c.category, module: priv ? 'general' : c.module, private: priv, ytId: priv ? '' : (pg?.yt?.id || '') };
}
async function refreshActive() {
  const a = await computeActive();
  RT.active = a;
  await setCurrent(a);
}

// ------------------------------------------------------------ capture (eyes)
async function blobToDataURL(b) {
  const buf = new Uint8Array(await b.arrayBuffer()); let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return 'data:' + b.type + ';base64,' + btoa(s);
}
async function shrink(dataUrl, maxW = 900, q = 0.6) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const sc = Math.min(1, maxW / bmp.width);
  const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * sc)), Math.max(1, Math.round(bmp.height * sc)));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return blobToDataURL(await c.convertToBlob({ type: 'image/jpeg', quality: q }));
}
async function captureScreen() {
  const s = await sget();
  const a = RT.active;
  if (!s.screen || !a || a.kind !== 'tab' || a.private) return null;
  try { return await shrink(await chrome.tabs.captureVisibleTab(a.windowId, { format: 'jpeg', quality: 60 }), 1000, 0.6); } catch (e) { return null; }
}
async function ensureOffscreen() {
  try {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctx.length) return;
  } catch (e) {}
  try { await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Webcam snapshot for companion context' }); } catch (e) {}
}
async function captureCam() {
  const s = await sget();
  if (!s.camera) { RT.cam = 'off'; return null; }
  await ensureOffscreen();
  try {
    const r = await withTimeout(chrome.runtime.sendMessage({ target: 'offscreen', t: 'CAM_SNAP' }), 12000);
    if (!r || r.error) { RT.cam = /NotAllowed|Permission/i.test(r?.error || '') ? 'denied' : 'error'; return null; }
    RT.cam = 'ok'; RT.lastBright = r.bright; RT.lastMotion = r.motion;
    return r;
  } catch (e) { RT.cam = 'error'; return null; }
}
const brightLabel = (b) => b == null ? 'unknown' : b < 35 ? 'very dark' : b < 80 ? 'dim' : b < 150 ? 'normal' : 'bright';

// silent ambient sampling (no Gemini call)
async function sample() {
  const now = Date.now(); RT.lastSample = now; saveRT();
  const cam = await captureCam();
  const screen = await captureScreen();
  if (!cam && !screen) return;
  const item = { ts: now, host: RT.active?.host || '', bright: cam?.bright ?? null, motion: cam?.motion ?? null, cam: cam ? await shrink(cam.dataUrl, 200, 0.5) : null, screen: screen ? await shrink(screen, 260, 0.5) : null };
  await patch('samples', [], (a) => { a.push(item); if (a.length > 120) a.splice(0, a.length - 120); });
  RT.imgs = { ts: now, screen, cam: cam?.dataUrl || null };
}

// ------------------------------------------------------------ Gemini brain driver
async function ensureGemini() {
  const s = await sget();
  let [tab] = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  if (!tab) { tab = await chrome.tabs.create({ url: s.geminiUrl, active: false, pinned: true }); await sleep(3000); }
  let ping = null;
  for (let i = 0; i < 30; i++) {
    try { ping = await withTimeout(chrome.tabs.sendMessage(tab.id, { t: 'G_PING' }), 3000); if (ping?.ready) break; }
    catch (e) {
      if (i === 3) { try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['gemini.js'] }); } catch (_) {} }
      const t2 = await chrome.tabs.get(tab.id).catch(() => null);
      if (t2 && /accounts\.google\.com/.test(t2.url || '')) { RT.brain = 'login'; throw new Error('LOGIN'); }
    }
    await sleep(1000);
  }
  if (!ping?.ready) { RT.brain = 'error'; throw new Error('GEMINI_NOT_READY'); }
  return { tab, ping };
}
async function brainAsk(text, images) {
  const ka = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    const { tab } = await ensureGemini();
    const r = await chrome.tabs.sendMessage(tab.id, { t: 'G_ASK', text, images: images || [] });
    if (!r || r.error) throw new Error(r?.error || 'no_response');
    return r.text;
  } finally { clearInterval(ka); }
}
function parseJSON(raw) {
  if (!raw) return null;
  const a = raw.indexOf('{'); if (a < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = a; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(raw.slice(a, i + 1)); } catch (e) { return null; } } }
  }
  return null;
}
async function brainTurn(ctx, images) {
  const b = await get('brain', { boot: false, turns: 0 });
  let { tab, ping } = await ensureGemini();
  if (ping.empty) b.boot = false;
  if (b.turns >= 28) { await chrome.tabs.update(tab.id, { url: 'https://gemini.google.com/app' }); await sleep(3000); b.boot = false; b.turns = 0; await ensureGemini(); }
  const text = (b.boot ? '' : SYSTEM_PROMPT + '\n\n') + buildTurn(ctx) + (b.boot ? '\n(Reply: ONE JSON object only.)' : '');
  let raw = await brainAsk(text, images);
  let dec = parseJSON(raw);
  if (!dec) { raw = await brainAsk('Your last reply was not a valid JSON object. Reply again with ONLY the JSON object following the OUTPUT CONTRACT.', []); dec = parseJSON(raw); }
  b.boot = true; b.turns++; await set('brain', b);
  if (!dec) throw new Error('BAD_JSON');
  RT.brain = 'ok';
  return dec;
}

// ------------------------------------------------------------ context builder (memory + timeline)
function compactSegs(seg) {
  const now = Date.now();
  const all = [...seg.list, ...(seg.cur ? [seg.cur] : [])].filter(x => x.end >= now - 3 * HOUR);
  const merged = [];
  for (const x of all) {
    const m = merged[merged.length - 1];
    if (m && m.host === x.host && m.cat === x.category && m.yt === (x.ytId || '') && x.start - m.endRaw < 2 * MIN) { m.endRaw = x.end; m.keys += x.keys || 0; m.backs += x.backs || 0; if (x.title) m.title = x.title; }
    else merged.push({ host: x.host, cat: x.category, yt: x.ytId || '', title: x.title, startRaw: x.start, endRaw: x.end, keys: x.keys || 0, backs: x.backs || 0 });
  }
  return merged.slice(-30).map(m => ({ from: hm(m.startRaw), to: hm(m.endRaw), min: Math.round((m.endRaw - m.startRaw) / MIN * 10) / 10, host: m.host, cat: m.cat, title: (m.title || '').slice(0, 70), keys: m.keys || undefined, backs: m.backs || undefined }));
}
function totals(seg, since) {
  const t = {};
  for (const x of [...seg.list, ...(seg.cur ? [seg.cur] : [])]) { if (x.start < since) continue; t[x.category] = (t[x.category] || 0) + (x.end - x.start) / MIN; }
  for (const k in t) t[k] = Math.round(t[k]);
  return t;
}
async function collectChats(s, tabs) {
  if (!s.chatRead) return [];
  const out = [];
  const cands = tabs.filter(t => t.url && classify(t.url).category === 'ai_chat' && !isPrivate(t.url, s)).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)).slice(0, 4);
  for (const t of cands) {
    const base = { host: classify(t.url).host, title: (t.title || '').slice(0, 80), active: !!t.active, last_access_min_ago: t.lastAccessed ? Math.round((Date.now() - t.lastAccessed) / MIN) : null };
    try { const r = await withTimeout(chrome.tabs.sendMessage(t.id, { t: 'GET_CHAT' }), 2500); out.push({ ...base, messages: r.messages, tail: r.tail, streaming: r.streaming }); }
    catch (e) { out.push({ ...base, unreadable: true }); }
  }
  return out;
}
function ytInfo() {
  const a = RT.active;
  let pg = a?.tabId != null ? RT.pages[a.tabId] : null;
  if (!pg?.yt) pg = Object.values(RT.pages).filter(p => p.yt && Date.now() - p.ts < 5 * MIN).sort((x, y) => y.ts - x.ts)[0];
  if (!pg?.yt) return null;
  const y = pg.yt, age = (Date.now() - pg.ts) / 1000;
  return { ...y, captured_at: iso(pg.ts), est_now_t: y.paused ? y.t : Math.round(y.t + age * (y.speed || 1)), url_at_t: `${y.url}&t=${y.paused ? y.t : Math.round(y.t + age)}s`, tab_active: pg.tabId === a?.tabId };
}
function typingSummary() {
  const cut = Date.now() - 10 * MIN, r = RT.typing.filter(x => x.ts >= cut);
  const keys = r.reduce((a, x) => a + x.keys, 0), backs = r.reduce((a, x) => a + x.backs, 0);
  return { keys_10m: keys, backspace_ratio: keys ? +(backs / keys).toFixed(2) : 0, longest_pause_s: Math.round(Math.max(0, ...r.map(x => x.pauseMax || 0)) / 1000), last_typed_ago_s: RT.typing.length ? Math.round((Date.now() - RT.typing[RT.typing.length - 1].ts) / 1000) : null };
}
async function buildContext(trigger, extra, S, s) {
  const now = Date.now();
  const [day, seg, tabs, commits, profile, chat, samples] = await Promise.all([get('day', {}), get('seg', { cur: null, list: [] }), chrome.tabs.query({}), get('commits', []), get('profile', { notes: [] }), get('chat', []), get('samples', [])]);
  const tabList = tabs.filter(t => t.url && /^https?:/.test(t.url) && !/gemini\.google\.com/.test(t.url)).slice(0, 25).map(t => { const p = isPrivate(t.url, s); return { host: p ? '(private)' : classify(t.url).host, title: p ? '' : (t.title || '').slice(0, 60), cat: p ? 'private' : classify(t.url).category, active: !!t.active, last_access_min_ago: t.lastAccessed ? Math.round((now - t.lastAccessed) / MIN) : null }; });
  const chats = await collectChats(s, tabs);
  const a = RT.active;
  const recentSamples = samples.slice(-6).map(x => ({ ago_min: Math.round((now - x.ts) / MIN), host: x.host, brightness: x.bright, light: brightLabel(x.bright), motion: x.motion }));
  const ctx = {
    trigger, phase: S.phase,
    now: { local: iso(now), weekday: new Date(now).toLocaleDateString('en-US', { weekday: 'long' }), tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
    day: { first_active: day.firstActive ? iso(day.firstActive) : null, prev_last_active: day.prevLastActive ? iso(day.prevLastActive) : null, plan: day.plan || s.goalsToday || '', summary: day.summary || '' },
    live: { active_tab: a ? { host: a.host, title: a.title, category: a.category, minutes_here: seg.cur ? Math.round((now - seg.cur.start) / MIN * 10) / 10 : 0 } : { host: '(outside Chrome)' }, input_idle_sec: Math.round((now - RT.lastInputAt) / 1000), system_idle: RT.idle, typing: typingSummary(), youtube: ytInfo() },
    segments: compactSegs(seg), today_totals_min: totals(seg, day.firstActive || now - 12 * HOUR), tabs: tabList, ai_chats: chats,
    block: S.block.active ? { active: true, allow: S.block.allow, until: iso(S.block.until) } : { active: false },
    commitments: commits.filter(c => c.status === 'open').slice(-10).map(c => ({ id: c.id, text: c.text, kind: c.kind, due: c.due ? iso(c.due) : null })),
    study_task: S.studyTask, discussion: S.discussion, last_action_result: S.lastResult, feedback_loop: S.feedback,
    memory: profile.notes.slice(-25).map(n => n.note), conversation_tail: chat.slice(-8).map(m => ({ role: m.role, text: (m.text || '').slice(0, 400), at: hm(m.ts) })),
    ambient_samples: recentSamples, modules_muted: S.muted
  };
  if (extra.user) ctx.user_message = extra.user;
  if (extra.dispute) ctx.dispute = extra.dispute;
  if (extra.awayMin) ctx.away_minutes = extra.awayMin;
  if (extra.commit) ctx.due_commitment = extra.commit;
  if (extra.reason) ctx.unblock_reason = extra.reason;
  return ctx;
}

// ------------------------------------------------------------ chat + delivery (voice)
async function pushChat(m) {
  const msg = { id: uid(), ts: Date.now(), ...m };
  await patch('chat', [], (a) => { a.push(msg); if (a.length > 300) a.splice(0, a.length - 300); });
  return msg;
}
async function deliver(msg) {
  const s = await sget();
  if (RT.ports === 0) {
    const a = RT.active;
    if (a?.tabId != null) chrome.tabs.sendMessage(a.tabId, { t: 'TOAST', text: msg.text, qr: msg.qr }).catch(() => {});
    const w = await chrome.windows.getLastFocused().catch(() => null);
    if (!w || !w.focused) chrome.notifications.create('d' + msg.id, { type: 'basic', iconUrl: 'icons/128.png', title: 'Depth', message: msg.text.slice(0, 200) }).catch(() => {});
  }
  if (s.voice && msg.voice) chrome.tts.speak(msg.text.slice(0, 400), { rate: 1.0 });
}

// ------------------------------------------------------------ blocking (hands)
const normHost = (h) => (h || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim();
const hostAllowed = (url, list) => { try { const h = new URL(url).hostname.replace(/^www\./, ''); return list.some(d => h === d || h.endsWith('.' + d)); } catch { return true; } };
const blockedUrl = (u) => `chrome-extension://${chrome.runtime.id}/blocked.html?from=${u}`;
async function verifyBlock(S) {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const ok = rules.some(r => r.id === 1);
  const excl = [...(S.block.allow || []), 'gemini.google.com', 'accounts.google.com'];
  const tabs = await chrome.tabs.query({});
  let blocked = 0, remaining = 0;
  for (const t of tabs) {
    if (!t.url) continue;
    if (t.url.startsWith(`chrome-extension://${chrome.runtime.id}/blocked.html`)) blocked++;
    else if (/^https?:/.test(t.url) && !hostAllowed(t.url, excl)) remaining++;
  }
  return { rule_active: ok, tabs_blocked: blocked, tabs_still_open_not_allowed: remaining };
}
async function applyBlock({ allow, minutes, reason }) {
  const s = await sget();
  let hosts = [...new Set((allow || []).map(normHost).filter(Boolean))];
  if (!hosts.length) hosts = s.studyAllow.map(normHost);
  const excl = [...new Set([...hosts, 'gemini.google.com', 'accounts.google.com'])];
  const rule = { id: 1, priority: 1, action: { type: 'redirect', redirect: { regexSubstitution: `chrome-extension://${chrome.runtime.id}/blocked.html?from=\\1` } }, condition: { regexFilter: '^(https?://.*)$', resourceTypes: ['main_frame'], excludedRequestDomains: excl } };
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1], addRules: [rule] });
  const until = Date.now() + (minutes || s.blockHours * 60) * MIN;
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) { if (t.url && /^https?:/.test(t.url) && !hostAllowed(t.url, excl)) { try { await chrome.tabs.update(t.id, { url: blockedUrl(t.url) }); } catch (e) {} } }
  const S = await patch('state', defState(), (S) => { S.block = { active: true, allow: hosts, until, startedAt: Date.now(), reason: reason || '' }; S.phase = 'ENFORCE'; });
  chrome.alarms.create('block-end', { when: until });
  await sleep(1500);
  const v = await verifyBlock(S);
  await patch('state', defState(), (S2) => { S2.lastResult = { action: 'execute_block', verified: v.rule_active && v.tabs_still_open_not_allowed === 0, ...v, allow: hosts, at: iso(Date.now()) }; S2.phase = 'VERIFY'; });
  await pushChat({ role: 'sys', text: v.rule_active ? `Block active. ${v.tabs_blocked} tab(s) held. Open: ${hosts.join(', ')}. Ends ${hm(until)}.` : 'Block rule failed to apply.' });
  await patch('stats', defStats(), (st) => { if (v.rule_active) st.verified++; });
  return v;
}
async function liftBlock(why) {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1] }).catch(() => {});
  chrome.alarms.clear('block-end');
  const tabs = await chrome.tabs.query({});
  const pre = `chrome-extension://${chrome.runtime.id}/blocked.html?from=`;
  for (const t of tabs) if (t.url && t.url.startsWith(pre)) { try { await chrome.tabs.update(t.id, { url: t.url.slice(pre.length) }); } catch (e) {} }
  await patch('state', defState(), (S) => { S.block = { active: false }; S.phase = 'OBSERVE'; S.lastResult = { action: 'lift_block', why: why || '', at: iso(Date.now()) }; });
  await pushChat({ role: 'sys', text: 'Block lifted. ' + (why || '') });
}
async function enforceBlock(S) {
  if (!S.block.active) return;
  if (Date.now() >= S.block.until) return liftBlock('Time ended.');
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  if (!rules.some(r => r.id === 1)) await applyBlock({ allow: S.block.allow, minutes: Math.ceil((S.block.until - Date.now()) / MIN), reason: S.block.reason }); // tamper recovery
}

// ------------------------------------------------------------ decision application (policy gates)
const MODULE_ACTIONS = {
  study: ['silent', 'discuss', 'ask', 'nudge', 'offer_block', 'execute_block', 'lift_block', 'log'],
  media: ['silent', 'discuss', 'ask', 'log'], shopping: ['silent', 'ask', 'log', 'discuss'], social: ['silent', 'log', 'ask'],
  work: ['silent', 'ask', 'discuss', 'nudge', 'log'], wellbeing: ['silent', 'ask', 'nudge', 'discuss', 'log'], general: ['silent', 'ask', 'discuss', 'nudge', 'log']
};
const PHASES = ['OBSERVE', 'DISCUSS', 'LULL', 'ANALYSIS', 'ACCOUNTABILITY', 'NEGOTIATE', 'STUDY_WATCH', 'ENFORCE', 'VERIFY'];
const CONSENT = /\b(yes|yeah|yep|yup|ok|okay|sure|do it|block|go ahead|haan|han|kar do|karo|theek)\b/i;

async function applyDecision(dec, trigger, extra, S, images) {
  const now = Date.now();
  let module = MODULE_ACTIONS[dec.module] ? dec.module : 'general';
  let action = dec.action || 'silent';
  if (!MODULE_ACTIONS[module].includes(action)) { action = dec.message ? 'ask' : 'silent'; await patch('stats', defStats(), s => { s.gates++; }); }
  if (S.muted.includes(module) && action !== 'silent') action = 'silent';
  // sequencing law gate: no accountability during discussion
  if (trigger === 'DISCUSS_START' && ['nudge', 'offer_block', 'execute_block'].includes(action)) { action = 'discuss'; await patch('stats', defStats(), s => { s.gates++; }); }
  // blocking consent gate
  let blockResult = null;
  if (action === 'execute_block') {
    const lastUser = (await get('chat', [])).filter(m => m.role === 'user').slice(-1)[0];
    const consented = extra.buttonConsent || (lastUser && now - lastUser.ts < 10 * MIN && CONSENT.test(lastUser.text) && S.offered);
    if (!consented) { action = 'offer_block'; await patch('stats', defStats(), s => { s.gates++; }); }
  }
  const conf = typeof dec.confidence === 'number' ? dec.confidence : 0.5;
  const msgText = (dec.message || '').trim();
  const wantsSay = msgText && !['silent', 'log'].includes(action);

  // evidence receipt
  let evidId = null;
  if (dec.evidence?.length || dec.hypotheses?.length) {
    evidId = uid();
    const thumbs = {};
    try { if (images?.screen) thumbs.screen = await shrink(images.screen, 240, 0.5); if (images?.cam) thumbs.cam = await shrink(images.cam, 200, 0.5); } catch (e) {}
    await patch('evid', [], (a) => { a.push({ id: evidId, ts: now, trigger, module, action, confidence: conf, hypotheses: dec.hypotheses || [], evidence: dec.evidence || [], uncertainty: dec.uncertainty || '', thumbs, feedback: null }); if (a.length > 60) a.splice(0, a.length - 60); });
  }

  // chat message
  let actions = [];
  if (action === 'offer_block') {
    const allow = (dec.block?.allow || S.block.allow || (await sget()).studyAllow).map(normHost);
    actions = [{ type: 'block', allow, minutes: dec.block?.minutes || null }];
    await patch('state', defState(), (X) => { X.offered = { ts: now, allow, minutes: dec.block?.minutes || null }; });
  }
  if (wantsSay) {
    const msg = await pushChat({ role: 'ai', text: msgText, qr: (dec.quick_replies || []).slice(0, 3), actions, evid: evidId, trigger, module, conf, voice: !!dec.voice });
    await deliver(msg);
  }

  // block execution after chat message so order reads naturally
  if (action === 'execute_block') {
    const allow = (dec.block?.allow?.length ? dec.block.allow : S.offered?.allow) || [];
    blockResult = await applyBlock({ allow, minutes: dec.block?.minutes || S.offered?.minutes, reason: dec.block?.user_confirmed_quote || '' });
  }
  if (action === 'lift_block') await liftBlock('Lifted by companion.');

  // commitments
  if (Array.isArray(dec.commitments) && dec.commitments.length) {
    await patch('commits', [], (list) => {
      for (const c of dec.commitments) {
        if (c.op === 'add' && c.text) list.push({ id: uid(), text: c.text, kind: c.kind || 'task', due: c.due_iso ? Date.parse(c.due_iso) || null : null, status: 'open', created: now, fired: false });
        else if (c.op === 'done' || c.op === 'cancel') { const m = list.find(x => x.id === c.id) || list.find(x => x.status === 'open' && c.text && x.text.toLowerCase().includes(c.text.toLowerCase())); if (m) { m.status = c.op === 'done' ? 'done' : 'cancelled'; m.closed = now; } }
      }
      if (list.length > 200) list.splice(0, list.length - 200);
    });
  }
  if (dec.memory_note) await patch('profile', { notes: [] }, (p) => { if (!p.notes.some(n => n.note === dec.memory_note)) p.notes.push({ ts: now, note: dec.memory_note }); if (p.notes.length > 60) p.notes.shift(); });
  if (dec.day_summary) await patch('day', {}, (d) => { d.summary = String(dec.day_summary).slice(0, 700); });

  // state
  const intervened = ['nudge', 'offer_block', 'execute_block'].includes(action) || (trigger === 'LULL_ANALYSIS' || trigger === 'DRIFT') && wantsSay;
  await patch('state', defState(), (X) => {
    if ('study_task' in dec) X.studyTask = dec.study_task && dec.study_task.label ? dec.study_task : null;
    if (dec.control?.quiet_minutes) X.quietUntil = now + dec.control.quiet_minutes * MIN;
    if (dec.control?.mute_modules?.length) X.muted = [...new Set([...X.muted, ...dec.control.mute_modules])];
    if (dec.control?.unmute_modules?.length) X.muted = X.muted.filter(m => !dec.control.unmute_modules.includes(m));
    const np = PHASES.includes(dec.next_phase) ? dec.next_phase : null;
    if (np && action !== 'execute_block') X.phase = np;
    if (wantsSay) {
      if (trigger !== 'USER_MSG' && X.lastUserAt < X.lastAiAt && X.lastAiAt) X.ignored = Math.min(X.ignored + 1, 6);
      X.lastAiAt = now;
      X.awaitingReply = /\?\s*$/.test(msgText) || ['ask', 'offer_block'].includes(action) ? { since: now } : null;
    }
    if (trigger === 'DISCUSS_START') { X.discussion = { active: true, vid: RT.active?.ytId || ytInfo()?.id || '', title: ytInfo()?.title || '', startedAt: now, lastAiAt: now, lastUserAt: 0, turns: 0, analysisDone: false }; X.lastDiscussStart = now; if (!np) X.phase = 'DISCUSS'; }
    if (trigger === 'LULL_ANALYSIS' || trigger === 'DRIFT') { X.lastAnalysisAt = now; if (X.discussion?.active) X.discussion.analysisDone = true; if (!np) X.phase = 'ACCOUNTABILITY'; }
    if (trigger === 'USER_MSG' && X.phase === 'ACCOUNTABILITY') X.phase = 'NEGOTIATE';
    if (trigger === 'STUDY_INACTIVITY') X.lastStudyCheck = now;
    if (trigger === 'LATE_NIGHT') X.lastWellbeing = now;
    if (trigger === 'USER_SILENT') X.silentAsks++;
    if (intervened) X.intervention = { ts: now, type: action, checked: false };
    if (action === 'execute_block') X.lastResult = blockResult ? { ...(X.lastResult || {}), verified: blockResult.rule_active } : X.lastResult;
  });

  // stats (depth metric inputs)
  await patch('stats', defStats(), (st) => {
    st.consults++;
    if (action === 'silent') st.silent++;
    if (['ask', 'nudge'].includes(action)) st.asks++;
    if (conf < 0.7) { st.uncertain++; if (['ask', 'silent'].includes(action)) st.uncertainAsked++; }
    if (intervened) st.interventions++;
    if (dec.edge_case && !st.cases.includes(dec.edge_case)) st.cases.push(dec.edge_case);
    if (!st.modules.includes(module)) st.modules.push(module);
    if (RT.err) { st.recovered++; RT.err = false; }
  });
}

// ------------------------------------------------------------ consult (one brain turn)
async function consult(trigger, extra = {}) {
  if (RT.busy) { if (extra.user || extra.force) RT.queue.push([trigger, extra]); return; }
  RT.busy = true; await writeStatus();
  try {
    const s = await sget();
    const S = await get('state', defState());
    // fresh capture unless cache is young
    const wantImgs = trigger !== 'COMMITMENT_DUE' && trigger !== 'MORNING_PLAN';
    let imgs = { screen: null, cam: null }, labels = [];
    if (wantImgs) {
      if (RT.imgs && Date.now() - RT.imgs.ts < 45000 && trigger !== 'LOOK_NOW') imgs = RT.imgs;
      else { const cam = await captureCam(); const screen = await captureScreen(); imgs = { ts: Date.now(), screen, cam: cam?.dataUrl || null }; RT.imgs = imgs; }
    }
    const list = [];
    if (imgs.screen) { list.push(imgs.screen); labels.push('IMAGE ' + list.length + ': screenshot of active Chrome tab'); }
    if (imgs.cam) { list.push(imgs.cam); labels.push('IMAGE ' + list.length + ': webcam frame (lighting: ' + brightLabel(RT.lastBright) + ')'); }
    const ctx = await buildContext(trigger, extra, S, s);
    ctx.images = labels.length ? labels : ['no images this turn' + (RT.cam === 'denied' ? ' (camera permission denied)' : '')];
    if (!imgs.cam && s.camera) ctx.live.camera = { status: RT.cam };
    else ctx.live.camera = { light: brightLabel(RT.lastBright), motion: RT.lastMotion };
    const dec = await brainTurn(ctx, list);
    await patch('ledger', [], (a) => { a.push({ ts: Date.now(), trigger, screen: !!imgs.screen, cam: !!imgs.cam, tabs: ctx.tabs.length, chats: ctx.ai_chats.length, youtube: !!ctx.live.youtube, chars: JSON.stringify(ctx).length }); if (a.length > 100) a.splice(0, a.length - 100); });
    await patch('state', defState(), (X) => { X.feedback = null; });
    await applyDecision(dec, trigger, extra, S, imgs);
  } catch (e) {
    RT.err = true;
    const code = String(e.message || e);
    await patch('stats', defStats(), (st) => { st.errors++; });
    const txt = code === 'LOGIN' ? 'Gemini needs sign-in. Open the pinned Gemini tab and log in.' : code === 'GEMINI_NOT_READY' ? 'Cannot reach Gemini page. Open gemini.google.com in a tab, then retry.' : 'Brain hiccup: ' + code + '. Will retry on next trigger.';
    if (extra.user || extra.force || trigger === 'LOOK_NOW') await pushChat({ role: 'sys', text: txt });
  } finally {
    RT.busy = false; await writeStatus();
    const q = RT.queue.shift(); if (q) consult(q[0], q[1]);
  }
}

// ------------------------------------------------------------ policy engine: when to consult
const COOLDOWN_BASE = 90000;
async function pickTrigger(s, S) {
  const now = Date.now();
  const cd = Math.min(COOLDOWN_BASE * 2 ** Math.min(S.ignored, 5), HOUR);
  const canSpeak = now - S.lastAiAt >= cd;
  const cur = (await get('seg', { cur: null })).cur;
  const a = RT.active;
  const inputIdle = (now - RT.lastInputAt) / 1000;
  const day = await get('day', {});
  const commits = await get('commits', []);
  const hr = new Date(now).getHours();
  const yt = ytInfo();
  const muted = (m) => S.muted.includes(m);

  // T7 commitment due (bypasses cooldown)
  const due = commits.find(c => c.status === 'open' && c.due && c.due <= now && !c.fired);
  if (due) { await patch('commits', [], l => { const x = l.find(y => y.id === due.id); if (x) x.fired = true; }); return ['COMMITMENT_DUE', { commit: due.text }]; }
  // T5 return from away
  if (S.pendingReturn && now - S.pendingReturn.at > 25000 && RT.idle === 'active') { const r = S.pendingReturn; await patch('state', defState(), X => { X.pendingReturn = null; }); if (canSpeak || now - S.lastAiAt > 5 * MIN) return ['RETURN', { awayMin: r.awayMin }]; }
  // T2 lull -> analysis (discuss first, judge second)
  const d = S.discussion;
  if (d?.active && !d.analysisDone && canSpeak) {
    const sinceUser = d.lastUserAt ? now - d.lastUserAt : Infinity, sinceAi = now - (d.lastAiAt || d.startedAt);
    const typingQuiet = now - RT.lastTypeAt > 20000;
    const lull = d.lastUserAt ? sinceUser >= s.lullSec * 1000 : sinceAi >= s.lullSec * 1500;
    if (lull && typingQuiet && sinceAi >= 30000) return ['LULL_ANALYSIS', {}];
  }
  // T3 user silent after question
  if (S.awaitingReply && now - S.awaitingReply.since >= 4 * MIN && S.silentAsks < 2 && canSpeak) return ['USER_SILENT', {}];
  // intervention feedback loop
  if (S.intervention && !S.intervention.checked && now - S.intervention.ts >= 7 * MIN) {
    const followed = a?.module === 'study' || (S.block.active && a?.category !== 'social_feed' && a?.category !== 'media');
    await patch('state', defState(), X => { X.intervention.checked = true; X.feedback = { intervention: X.intervention.type, minutes_since: Math.round((now - X.intervention.ts) / MIN), followed_by_behavior: !!followed, now_on: a?.host || 'outside Chrome' }; });
    await patch('stats', defStats(), st => { if (followed) st.followed++; });
    return ['FEEDBACK_CHECK', {}];
  }
  if (!canSpeak) return null;
  // T1 discuss start: YouTube foreground long enough, new video, cooldown between auto-discussions
  if (!muted('media') && cur?.category === 'media' && yt && yt.tab_active && !yt.ad && cur.ytId && S.discussion?.vid !== cur.ytId && now - cur.start >= s.discussDelaySec * 1000 && now - S.lastDiscussStart >= 15 * MIN && !S.block.active) return ['DISCUSS_START', {}];
  // T4 study inactivity
  const studying = S.studyTask || S.block.active || cur?.category === 'ai_chat' || cur?.category === 'study_site';
  if (!muted('study') && studying && inputIdle >= s.inactivityMin * 60 && RT.idle === 'active' && now - S.lastStudyCheck >= 15 * MIN) return ['STUDY_INACTIVITY', {}];
  // T9 drift (feeds etc., nothing to discuss). Skip while a discussion is still open.
  if (!muted('study') && !(d?.active && !d.analysisDone) && now - S.lastAnalysisAt >= 45 * MIN && (day.plan || commits.some(c => c.kind === 'study' && c.status === 'open'))) {
    const seg = await get('seg', { cur: null, list: [] });
    const t = totals({ list: seg.list.filter(x => x.end >= now - 40 * MIN), cur: seg.cur }, now - 40 * MIN);
    const distract = (t.media || 0) + (t.social_feed || 0);
    if (distract >= 25 || (cur?.category === 'social_feed' && now - cur.start >= 10 * MIN)) return ['DRIFT', {}];
  }
  // T6 morning plan
  if (day.firstActive && !day.plan && !day.askedPlan && now - day.firstActive >= 2 * MIN && !S.discussion?.active) { await patch('day', {}, x => { x.askedPlan = true; }); return ['MORNING_PLAN', {}]; }
  // T10 late night wellbeing
  if (hr >= 1 && hr < 5 && inputIdle < 120 && now - S.lastWellbeing >= 90 * MIN && !muted('wellbeing')) return ['LATE_NIGHT', {}];
  return null;
}

async function tick() {
  await hydrate;
  const s = await sget();
  if (!s.enabled) { await writeStatus(); return; }
  await refreshActive();
  const S = await get('state', defState());
  await enforceBlock(S);
  const now = Date.now();
  if (RT.idle === 'active' && now - RT.lastSample >= s.heartbeatMin * MIN && now - RT.lastInputAt < 20 * MIN && !RT.busy) await sample();
  await writeStatus();
  if (S.quietUntil > now || RT.busy) return;
  const t = await pickTrigger(s, S);
  if (t) consult(t[0], t[1]);
}

// ------------------------------------------------------------ status for UI
async function writeStatus() {
  const s = await sget();
  const S = await get('state', defState());
  const now = Date.now(), a = RT.active, yt = ytInfo();
  await set('status', { ts: now, busy: RT.busy, brain: RT.brain, cam: RT.cam, enabled: s.enabled, phase: S.phase, module: a?.module || 'general', host: a?.host || '(outside Chrome)', cat: a?.category || 'offbrowser', title: a?.title || '', idle: RT.idle, input_idle: Math.round((now - RT.lastInputAt) / 1000), typing: typingSummary(), light: brightLabel(RT.lastBright), bright: RT.lastBright, motion: RT.lastMotion, yt: yt ? { title: yt.title, est: yt.est_now_t, dur: yt.dur, paused: yt.paused } : null, quietUntil: S.quietUntil, block: S.block, discussion: S.discussion, study: S.studyTask, awaiting: !!S.awaitingReply, sensors: { tab: !!a, input: true, typing: RT.typing.length > 0, youtube: !!yt, chats: s.chatRead, screen: s.screen && !a?.private, cam: RT.cam === 'ok', history: true, phone: false } });
}

// ------------------------------------------------------------ user messages
async function onUserMsg(text, via, extra = {}) {
  text = (text || '').trim(); if (!text) return;
  await pushChat({ role: 'user', text, via: via || 'panel' });
  RT.lastTypeAt = Date.now();
  await patch('state', defState(), (X) => { X.ignored = 0; X.awaitingReply = null; X.silentAsks = 0; X.lastUserAt = Date.now(); if (X.discussion?.active) { X.discussion.turns++; X.discussion.lastUserAt = Date.now(); } });
  consult(extra.trigger || 'USER_MSG', { user: text, force: true, ...extra });
}

chrome.runtime.onMessage.addListener((m, sender, res) => {
  (async () => {
    await hydrate;
    switch (m.t) {
      case 'ACT': RT.lastInputAt = Date.now(); saveRT(); markActive(); if (RT.idle !== 'active') { RT.idle = 'active'; } break;
      case 'PANEL_TYPING': RT.lastTypeAt = Date.now(); break;
      case 'TYPING': RT.typing.push({ ts: Date.now(), keys: m.keys, backs: m.backs, pauseMax: m.pauseMax, bursts: m.bursts, host: sender.tab ? classify(sender.tab.url).host : '' }); if (RT.typing.length > 80) RT.typing.shift(); RT.lastTypeAt = Date.now(); await patch('seg', { cur: null, list: [] }, (s) => { if (s.cur) { s.cur.keys = (s.cur.keys || 0) + m.keys; s.cur.backs = (s.cur.backs || 0) + m.backs; } }); break;
      case 'PAGE': { if (!sender.tab) break; const old = RT.pages[sender.tab.id]; RT.pages[sender.tab.id] = { ...m, ts: Date.now(), tabId: sender.tab.id, windowId: sender.tab.windowId }; if (!old || old.title !== m.title || old.yt?.id !== m.yt?.id) refreshActive(); break; }
      case 'USER_MSG': onUserMsg(m.text, m.via); break;
      case 'LOOK_NOW': consult('LOOK_NOW', { force: true }); break;
      case 'BLOCK_NOW': { await pushChat({ role: 'user', text: 'Yes, block everything except ' + (m.allow || []).join(', ') + '.', via: 'button' }); const S = await get('state', defState()); await patch('state', defState(), X => { X.offered = { ts: Date.now(), allow: m.allow, minutes: m.minutes }; }); await applyBlock({ allow: m.allow, minutes: m.minutes, reason: 'button consent' }); consult('USER_MSG', { user: 'I approved the block with the button.', force: true }); break; }
      case 'BLOCK_INFO': { const S = await get('state', defState()); res({ allow: S.block.allow || [], until: S.block.until || Date.now() }); return; }
      case 'UNBLOCK_REQUEST': onUserMsg('Let me out of the block. Reason: ' + (m.reason || ''), 'blockpage', { trigger: 'UNBLOCK_REQUEST', reason: m.reason }); break;
      case 'BLOCK_OVERRIDE': await liftBlock('You overrode it (held 10s).'); onUserMsg('I overrode the block by holding the button. ' + (m.reason || ''), 'blockpage', { trigger: 'UNBLOCK_OVERRIDE', reason: m.reason }); break;
      case 'LIFT_BLOCK': await liftBlock('Lifted from panel.'); break;
      case 'QUIET': await patch('state', defState(), X => { X.quietUntil = m.minutes ? Date.now() + m.minutes * MIN : 0; }); break;
      case 'EVID_FEEDBACK': {
        let claim = null;
        await patch('evid', [], (a) => { const e = a.find(x => x.id === m.id); if (e) { e.feedback = m.value; claim = e; } });
        await patch('stats', defStats(), st => { if (m.value === 'right') st.right++; else st.wrong++; });
        if (m.value === 'wrong' && claim) onUserMsg(m.text || 'That reading was wrong.', 'receipt', { dispute: { hypotheses: claim.hypotheses, evidence: claim.evidence }, trigger: 'USER_MSG' });
        break;
      }
      case 'MUTE': await patch('state', defState(), X => { X.muted = m.on ? [...new Set([...X.muted, m.module])] : X.muted.filter(x => x !== m.module); }); break;
      case 'PLAN': await patch('day', {}, d => { d.plan = m.text || ''; }); break;
      case 'ADD_COMMIT': await patch('commits', [], l => { l.push({ id: uid(), text: m.text, kind: m.kind || 'task', due: m.due || null, status: 'open', created: Date.now(), fired: false }); }); break;
      case 'COMMIT_STATUS': await patch('commits', [], l => { const x = l.find(y => y.id === m.id); if (x) { x.status = m.status; x.closed = Date.now(); } }); break;
      case 'SNAP_TEST': { const c = await captureCam(); res({ ok: !!c, cam: RT.cam }); return; }
      case 'WIPE': await chrome.storage.local.remove(['seg', 'chat', 'evid', 'samples', 'ledger', 'commits', 'profile', 'state', 'stats', 'day', 'brain']); break;
      case 'PERMS_DONE': RT.cam = m.cam ? 'ok' : 'denied'; break;
    }
    res && res({ ok: true });
  })().catch(() => res && res({ ok: false }));
  return true;
});

// ------------------------------------------------------------ browser events
chrome.tabs.onActivated.addListener(() => refreshActive());
chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'complete' || info.title) refreshActive(); });
chrome.tabs.onRemoved.addListener((id) => { delete RT.pages[id]; });
chrome.windows.onFocusChanged.addListener(() => refreshActive());
chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener(async (st) => {
  await hydrate;
  const was = RT.idle;
  RT.idle = st === 'locked' ? 'idle' : st;
  if (st !== 'active' && was === 'active') RT.idleSince = Date.now();
  if (st === 'active' && was !== 'active') {
    RT.lastInputAt = Date.now(); markActive();
    const away = RT.idleSince ? (Date.now() - RT.idleSince) / MIN : 0;
    if (away >= 10) await patch('state', defState(), X => { X.pendingReturn = { awayMin: Math.round(away), at: Date.now() }; });
  }
  saveRT(); refreshActive();
});
chrome.runtime.onConnect.addListener((p) => { if (p.name === 'panel') { RT.ports++; p.onDisconnect.addListener(() => { RT.ports = Math.max(0, RT.ports - 1); }); } });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') tick(); if (a.name === 'block-end') get('state', defState()).then(S => enforceBlock(S)); });
chrome.notifications.onClicked.addListener(() => { chrome.windows.getLastFocused().then(w => chrome.sidePanel.open({ windowId: w.id })).catch(() => {}); });

function boot() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create('tick', { periodInMinutes: 0.5 });
  markActive(); refreshActive();
}
chrome.runtime.onInstalled.addListener((d) => { boot(); if (d.reason === 'install') chrome.tabs.create({ url: 'setup.html' }); });
chrome.runtime.onStartup.addListener(boot);
boot();
