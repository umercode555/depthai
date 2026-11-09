let chain = Promise.resolve();
export const get = async (k, d) => { const r = await chrome.storage.local.get(k); return r[k] === undefined ? d : r[k]; };
export const set = (k, v) => chrome.storage.local.set({ [k]: v });
// Serialized read-modify-write. fn may mutate and return undefined, or return a new value.
export function patch(k, d, fn) {
  const run = chain.then(async () => {
    const v = await get(k, d);
    const n = await fn(v);
    const out = n === undefined ? v : n;
    await set(k, out);
    return out;
  });
  chain = run.catch(() => {});
  return run;
}
export const DEFAULT_SETTINGS = {
  enabled: true,
  geminiUrl: 'https://gemini.google.com/app',
  camera: true, screen: true, chatRead: true, social: false, shopping: true,
  voice: false,
  heartbeatMin: 10, lullSec: 120, discussDelaySec: 60, inactivityMin: 5, blockHours: 2,
  studyAllow: ['chat.deepseek.com'],
  goalsToday: '',
  excluded: ['bank', 'paypal.com', 'mail.google.com', 'outlook.live.com', 'accounts.google.com', '1password.com', 'bitwarden.com', 'lastpass.com', 'easypaisa', 'jazzcash', 'web.whatsapp.com']
};
export const sget = async () => ({ ...DEFAULT_SETTINGS, ...(await get('settings', {})) });
