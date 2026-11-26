// Small DOM helpers.
export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids);
  return n;
}
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = v => '$' + (Math.round(v * 100) / 100).toFixed(2);

let toastT;
export function toast(msg, ms = 2600) {
  let t = document.getElementById('toast');
  if (!t) { t = el('div', { id: 'toast' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), ms);
}

export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function busy(msg) {
  let b = document.getElementById('busy');
  if (!b) { b = el('div', { id: 'busy' }, el('div', { class: 'busy-box' })); document.body.append(b); }
  if (msg === false) { b.classList.remove('show'); return; }
  b.querySelector('.busy-box').textContent = msg;
  b.classList.add('show');
}
export const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
