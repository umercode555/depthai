const MAP = [
  ['ai_chat', ['chat.deepseek.com', 'claude.ai', 'chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'chat.qwen.ai', 'grok.com']],
  ['study_site', ['khanacademy.org', 'wolframalpha.com', 'desmos.com', 'geogebra.org', 'classroom.google.com', 'scholar.google.com', 'wikipedia.org', 'coursera.org', 'edx.org', 'brilliant.org']],
  ['media', ['youtube.com', 'youtu.be', 'netflix.com', 'twitch.tv', 'spotify.com', 'primevideo.com', 'dailymotion.com', 'vimeo.com']],
  ['social_feed', ['instagram.com', 'tiktok.com', 'facebook.com', 'x.com', 'twitter.com', 'reddit.com', 'snapchat.com', 'pinterest.com', 'threads.net', 'linkedin.com']],
  ['messaging', ['web.whatsapp.com', 'web.telegram.org', 'discord.com', 'messenger.com', 'slack.com']],
  ['shopping', ['daraz.pk', 'amazon.com', 'ebay.com', 'aliexpress.com', 'temu.com', 'etsy.com', 'shein.com', 'olx.com.pk']],
  ['work', ['fiverr.com', 'upwork.com', 'notion.so', 'figma.com', 'canva.com', 'vercel.com', 'netlify.com', 'supabase.com', 'github.com', 'stackoverflow.com', 'developer.mozilla.org', 'docs.google.com', 'drive.google.com', 'sheets.google.com', 'console.cloud.google.com']]
];
const MODULE = { ai_chat: 'study', study_site: 'study', media: 'media', social_feed: 'media', messaging: 'social', shopping: 'shopping', work: 'work' };
export const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
export function classify(url) {
  const host = hostOf(url);
  if (url && url.startsWith('chrome-extension://')) return { host: 'depth', category: 'internal', module: 'general' };
  for (const [cat, list] of MAP) if (list.some(d => host === d || host.endsWith('.' + d))) return { host, category: cat, module: MODULE[cat] || 'general' };
  return { host, category: 'other', module: 'general' };
}
export function isPrivate(url, s) {
  const u = (url || '').toLowerCase();
  const ex = [...(s.excluded || [])];
  const social = !!s.social;
  return ex.some(x => {
    if (social && x === 'web.whatsapp.com') return false;
    return u.includes(x.toLowerCase());
  });
}
export const CATEGORIES = ['ai_chat', 'study_site', 'media', 'social_feed', 'messaging', 'shopping', 'work', 'other'];
