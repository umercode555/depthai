const o = document.getElementById('o');
document.getElementById('b').onclick = async () => {
  o.textContent = 'Waiting for permission…';
  let cam = false, mic = false;
  try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach(t => t.stop()); cam = true; } catch (e) {}
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); mic = true; } catch (e) {}
  o.textContent = (cam ? 'Camera ready. ' : 'Camera blocked: allow it from the lock icon in the address bar. ') + (mic ? 'Mic ready.' : 'Mic blocked.');
  chrome.runtime.sendMessage({ t: 'PERMS_DONE', cam, mic });
};
