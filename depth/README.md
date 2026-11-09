# Depth — LifeAI companion (Chrome extension)

Install (Chrome on Catalina, up to v138):
1. Unzip. Open chrome://extensions. Turn on Developer mode.
2. Load unpacked. Pick this folder.
3. Setup tab opens. Click "Allow camera + microphone".
4. Open gemini.google.com in Chrome. Sign in. (Depth also opens a pinned Gemini tab itself.)
5. Click Depth icon. Side panel opens. Stays open across tabs.
6. Press "Look now". First turn sends system prompt + context + screenshot + webcam frame.

Optional: paste your own Gemini chat link in Setup tab.

Files:
- background.js   service worker: sensors, timeline, policy engine, Gemini loop, blocking
- gemini.js       drives gemini.google.com (types, attaches images, reads reply)
- content.js      per-page sensors: typing counts, YouTube time, AI-chat text, toast
- offscreen.*     webcam snapshot + brightness/motion stats
- sidepanel.*     UI
- blocked.*       block page with 10s override
- lib/prompt.js   Gemini system prompt + output contract

If Gemini UI changes: edit selectors at top of gemini.js (SEL object).
