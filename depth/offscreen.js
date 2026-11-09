let prev = null;
chrome.runtime.onMessage.addListener((m, _s, res) => {
  if (m.target !== 'offscreen' || m.t !== 'CAM_SNAP') return;
  snap().then(res).catch(e => res({ error: (e.name || 'Error') + ': ' + (e.message || '') }));
  return true;
});
async function snap() {
  const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } });
  try {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.srcObject = s;
    await v.play();
    await new Promise(r => setTimeout(r, 900)); // auto-exposure warm-up
    const c = document.createElement('canvas'); c.width = 640; c.height = 480;
    c.getContext('2d').drawImage(v, 0, 0, 640, 480);
    const sm = document.createElement('canvas'); sm.width = 32; sm.height = 24;
    const sx = sm.getContext('2d'); sx.drawImage(v, 0, 0, 32, 24);
    const d = sx.getImageData(0, 0, 32, 24).data;
    const g = new Float32Array(768); let sum = 0;
    for (let i = 0; i < 768; i++) { g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; sum += g[i]; }
    let motion = null;
    if (prev) { let df = 0; for (let i = 0; i < 768; i++) df += Math.abs(g[i] - prev[i]); motion = +(df / 768 / 255).toFixed(3); }
    prev = g;
    return { dataUrl: c.toDataURL('image/jpeg', 0.7), bright: Math.round(sum / 768), motion };
  } finally { s.getTracks().forEach(t => t.stop()); }
}
