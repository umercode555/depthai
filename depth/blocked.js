const from = location.href.split('from=')[1] || '';
const $ = (i) => document.getElementById(i);
chrome.runtime.sendMessage({ t: 'BLOCK_INFO' }, (info) => {
  if (!info) return;
  $('s').textContent = 'Only ' + info.allow.join(', ') + ' stays open. Study mode ends at ' + new Date(info.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.';
  $('back').innerHTML = info.allow.map(h => `<a class="b" href="https://${h}">Back to ${h}</a>`).join('');
  $('u').textContent = 'You were trying to open: ' + decodeURIComponent(from).slice(0, 90);
});
$('ask').onclick = () => { chrome.runtime.sendMessage({ t: 'UNBLOCK_REQUEST', reason: $('r').value || 'No reason given', from }); $('ask').textContent = 'Sent. Check the Depth panel.'; };
let t0 = 0, raf = 0;
const bar = document.querySelector('.hold i');
const tick = () => { const p = Math.min(1, (Date.now() - t0) / 10000); bar.style.width = (p * 100) + '%'; if (p >= 1) { chrome.runtime.sendMessage({ t: 'BLOCK_OVERRIDE', reason: $('r').value, from }); return; } raf = requestAnimationFrame(tick); };
$('hold').onmousedown = () => { t0 = Date.now(); tick(); };
['mouseup', 'mouseleave'].forEach(e => $('hold').addEventListener(e, () => { cancelAnimationFrame(raf); bar.style.width = '0'; }));
