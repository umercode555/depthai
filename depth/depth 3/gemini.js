(() => {
  if (window.__depthG) return;
  window.__depthG = true;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const vis = (e) => e && (e.offsetParent !== null || e.getClientRects().length);
  const first = (sels) => { for (const s of sels) { const e = [...document.querySelectorAll(s)].find(vis); if (e) return e; } return null; };

  const SEL = {
    editor: ['rich-textarea div.ql-editor[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'textarea'],
    send: ['button.send-button', 'button[aria-label*="Send message" i]', 'button[aria-label*="Send" i]', 'button[mattooltip*="Send" i]'],
    stop: ['button[aria-label*="Stop" i]', 'button.stop', 'button[mattooltip*="Stop" i]']
  };
  const editor = () => first(SEL.editor);
  const sendBtn = () => first(SEL.send);
  const stopBtn = () => first(SEL.stop);
  const responses = () => [...document.querySelectorAll('model-response')];
  const previews = () => document.querySelectorAll('uploader-file-preview, [data-test-id*="file-preview"], [class*="file-preview"], [class*="image-preview"], user-query-file-preview').length;

  const lastText = () => {
    const r = responses().at(-1);
    if (!r) return '';
    const c = r.querySelector('message-content') || r.querySelector('.markdown') || r;
    return (c.innerText || '').trim();
  };

  function toFile(d, name) {
    const [h, b] = d.split(',');
    const mime = (h.match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const bin = atob(b); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new File([u], name, { type: mime });
  }

  async function attach(files) {
    const ed = editor(); if (!ed) throw new Error('no_editor');
    ed.focus();
    const before = previews();
    const dt = new DataTransfer(); files.forEach(f => dt.items.add(f));
    const want = before + files.length;
    // 1) paste
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    for (let i = 0; i < 12 && previews() < want; i++) await sleep(250);
    if (previews() >= want) return true;
    // 2) drop
    const target = ed.closest('rich-textarea') || ed.closest('[class*="input-area"]') || ed;
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    for (let i = 0; i < 12 && previews() < want; i++) await sleep(250);
    if (previews() >= want) return true;
    // 3) hidden file input
    const inp = document.querySelector('input[type="file"]');
    if (inp) { inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); for (let i = 0; i < 16 && previews() < want; i++) await sleep(250); }
    return previews() >= want;
  }

  function setText(text) {
    const ed = editor(); if (!ed) throw new Error('no_editor');
    ed.focus();
    if (ed.tagName === 'TEXTAREA') { ed.value = text; ed.dispatchEvent(new Event('input', { bubbles: true })); return; }
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    // chunked insert keeps the editor responsive for long prompts
    for (let i = 0; i < text.length; i += 4000) document.execCommand('insertText', false, text.slice(i, i + 4000));
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function ask(text, images) {
    const ed = editor(); if (!ed) throw new Error('no_editor');
    const nBefore = responses().length;
    const tBefore = lastText();
    // clear any leftover draft
    ed.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);
    let attached = true;
    if (images && images.length) attached = await attach(images.map((d, i) => toFile(d, 'depth-' + (i + 1) + '.jpg')));
    setText(text);
    // wait for upload spinners to settle and send button to enable
    for (let i = 0; i < 80; i++) {
      const b = sendBtn();
      const busy = document.querySelector('mat-progress-spinner, [role="progressbar"]');
      if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && !busy) break;
      await sleep(250);
    }
    const b = sendBtn();
    if (b) b.click();
    else { const e = editor(); e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); }
    // wait for response to start
    let started = false;
    for (let i = 0; i < 100; i++) {
      await sleep(300);
      if (responses().length > nBefore || (lastText() && lastText() !== tBefore) || stopBtn()) { started = true; break; }
    }
    if (!started) throw new Error('send_failed');
    // wait for completion: no stop button + text stable
    let last = '', stableSince = Date.now(), t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      await sleep(600);
      const cur = lastText();
      if (cur !== last) { last = cur; stableSince = Date.now(); }
      const stopping = !!stopBtn();
      if (!stopping && cur && Date.now() - stableSince > 2200) break;
    }
    if (!last) throw new Error('empty_response');
    return { text: last, attached };
  }

  chrome.runtime.onMessage.addListener((m, _s, res) => {
    if (m.t === 'G_PING') {
      res({ ready: !!editor(), empty: responses().length === 0, url: location.href });
    } else if (m.t === 'G_ASK') {
      ask(m.text, m.images).then(r => res(r)).catch(e => res({ error: String(e.message || e) }));
      return true;
    }
  });
})();
