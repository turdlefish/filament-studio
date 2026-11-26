// Recolour a screenshot: find its main colours, then swap each for a filament.
import * as store from './store.js';
import { rgbToLab, labToRgb, hexToLab, swatchCss, rgbToHex, deltaE, matchWords } from './colour.js';
import { pickFilament } from './picker.js';
import { el, esc, toast, busy, nextFrame } from './ui.js';
import { setDesignNeeds } from './library.js';

const MAXW = 1600;
let img = null;           // { w, h, lab: Float32Array(w*h*3), alpha: Uint8Array, src ImageData }
let k = 6;
let clusters = [];        // { lab, hex, count, target: spool|null }
let labels = null;        // Uint8Array per pixel
let view = 'after';
let selected = -1;
let shade = 0.6;
let ignoreBg = true;

export function renderRecolour() {
  const root = document.getElementById('page-recolour');
  if (root.dataset.ready) return refreshList();
  root.dataset.ready = 1;
  root.innerHTML = `
    <div class="split">
      <section class="card canvas-card">
        <div class="card-head"><h2>Picture</h2>
          <div class="row gap wrap">
            <label class="btn small">Open a picture<input type="file" accept="image/*" hidden data-file></label>
            <div class="seg" data-view><button data-v="before">Before</button><button data-v="after" class="on">After</button><button data-v="mask">Groups</button></div>
            <button class="btn ghost small" data-save disabled>Save picture</button>
          </div></div>
        <div class="drop" data-drop><p><b>Drop a screenshot here</b>, paste one with Ctrl+V, or open a picture.<br><span class="muted">A render from Bambu Studio, a MakerWorld photo, anything. Click the picture to pick a colour group.</span></p>
        <canvas data-canvas hidden></canvas></div>
      </section>
      <section class="card side">
        <h2>Colours</h2>
        <label class="tiny">How many colour groups: <b data-kv>${k}</b><input type="range" min="2" max="16" value="${k}" data-k></label>
        <label class="tiny">Keep shading: <input type="range" min="0" max="1" step="0.05" value="${shade}" data-shade></label>
        <label class="check tiny"><input type="checkbox" data-bg ${ignoreBg ? 'checked' : ''}> Leave the background alone (the colour along the edges)</label>
        <div class="row gap"><button class="btn small" data-auto disabled>Match to my spools</button><button class="btn ghost small" data-reset disabled>Undo all swaps</button></div>
        <div class="cl-list" data-list></div>
        <div class="summary" data-sum></div>
      </section>
    </div>`;
  const $ = s => root.querySelector(s);
  $('[data-file]').onchange = e => e.target.files[0] && loadFile(e.target.files[0]);
  const drop = $('[data-drop]');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); const f = [...e.dataTransfer.files].find(f => f.type.startsWith('image')); f && loadFile(f); };
  document.addEventListener('paste', e => {
    if (!document.querySelector('#page-recolour.on')) return;
    const it = [...e.clipboardData.items].find(i => i.type.startsWith('image'));
    if (it) loadFile(it.getAsFile());
  });
  $('[data-k]').oninput = e => { $('[data-kv]').textContent = e.target.value; };
  $('[data-k]').onchange = e => { k = +e.target.value; if (img) analyse(); };
  $('[data-shade]').oninput = e => { shade = +e.target.value; draw(); };
  $('[data-bg]').onchange = e => { ignoreBg = e.target.checked; markBg(); refreshList(); draw(); };
  $('[data-view]').onclick = e => { const v = e.target.dataset.v; if (!v) return; view = v; root.querySelectorAll('[data-view] button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); draw(); };
  $('[data-auto]').onclick = autoMatch;
  $('[data-reset]').onclick = () => { clusters.forEach(c => c.target = null); refreshList(); draw(); };
  $('[data-save]').onclick = savePicture;
  $('[data-canvas]').onclick = e => {
    if (!labels) return;
    const c = e.currentTarget, r = c.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * img.w), y = Math.floor((e.clientY - r.top) / r.height * img.h);
    const i = labels[y * img.w + x];
    selected = i; refreshList(); draw();
    root.querySelector(`[data-ci="${i}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    choose(i);
  };
}

async function loadFile(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, MAXW / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const cv = new OffscreenCanvas(w, h), cx = cv.getContext('2d');
  cx.drawImage(bmp, 0, 0, w, h);
  const data = cx.getImageData(0, 0, w, h);
  const lab = new Float32Array(w * h * 3), alpha = new Uint8Array(w * h);
  // Cache Lab conversion per colour, screenshots repeat colours a lot.
  const cache = new Map();
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const key = (data.data[p] << 16) | (data.data[p + 1] << 8) | data.data[p + 2];
    let L = cache.get(key);
    if (!L) { L = rgbToLab(data.data[p], data.data[p + 1], data.data[p + 2]); cache.set(key, L); }
    lab[i * 3] = L[0]; lab[i * 3 + 1] = L[1]; lab[i * 3 + 2] = L[2];
    alpha[i] = data.data[p + 3];
  }
  img = { w, h, lab, alpha, data };
  const cv2 = document.querySelector('#page-recolour [data-canvas]');
  cv2.width = w; cv2.height = h; cv2.hidden = false;
  document.querySelector('#page-recolour [data-drop] p').hidden = true;
  ['[data-auto]', '[data-reset]', '[data-save]'].forEach(s => document.querySelector('#page-recolour ' + s).disabled = false);
  analyse();
}

async function analyse() {
  busy('Finding the main colours…'); await nextFrame();
  const { w, h, lab, alpha } = img;
  const n = w * h;
  // Sample pixels for k-means.
  const step = Math.max(1, Math.floor(n / 60000));
  const pts = [];
  for (let i = 0; i < n; i += step) if (alpha[i] > 128) pts.push(i);
  const P = new Float32Array(pts.length * 3);
  pts.forEach((p, j) => { P[j * 3] = lab[p * 3]; P[j * 3 + 1] = lab[p * 3 + 1]; P[j * 3 + 2] = lab[p * 3 + 2]; });
  const m = pts.length;
  // k-means++ start
  const C = new Float32Array(k * 3);
  let first = Math.floor(Math.random() * m);
  C.set(P.subarray(first * 3, first * 3 + 3), 0);
  const D = new Float32Array(m).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let j = 0; j < m; j++) {
      const dl = P[j * 3] - C[(c - 1) * 3], da = P[j * 3 + 1] - C[(c - 1) * 3 + 1], db = P[j * 3 + 2] - C[(c - 1) * 3 + 2];
      D[j] = Math.min(D[j], dl * dl + da * da + db * db); sum += D[j];
    }
    let r = Math.random() * sum, j = 0;
    for (; j < m - 1; j++) { r -= D[j]; if (r <= 0) break; }
    C.set(P.subarray(j * 3, j * 3 + 3), c * 3);
  }
  const A = new Uint8Array(m);
  for (let it = 0; it < 20; it++) {
    const sums = new Float64Array(k * 4);
    for (let j = 0; j < m; j++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dl = P[j * 3] - C[c * 3], da = P[j * 3 + 1] - C[c * 3 + 1], db = P[j * 3 + 2] - C[c * 3 + 2];
        const d = dl * dl + da * da + db * db;
        if (d < bd) { bd = d; best = c; }
      }
      A[j] = best;
      sums[best * 4] += P[j * 3]; sums[best * 4 + 1] += P[j * 3 + 1]; sums[best * 4 + 2] += P[j * 3 + 2]; sums[best * 4 + 3]++;
    }
    for (let c = 0; c < k; c++) if (sums[c * 4 + 3]) { C[c * 3] = sums[c * 4] / sums[c * 4 + 3]; C[c * 3 + 1] = sums[c * 4 + 1] / sums[c * 4 + 3]; C[c * 3 + 2] = sums[c * 4 + 2] / sums[c * 4 + 3]; }
  }
  // Label every pixel.
  labels = new Uint8Array(n);
  const counts = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    let best = 0, bd = Infinity;
    for (let c = 0; c < k; c++) {
      const dl = lab[i * 3] - C[c * 3], da = lab[i * 3 + 1] - C[c * 3 + 1], db = lab[i * 3 + 2] - C[c * 3 + 2];
      const d = dl * dl + da * da + db * db;
      if (d < bd) { bd = d; best = c; }
    }
    labels[i] = best; counts[best]++;
  }
  const old = clusters;
  clusters = [...Array(k)].map((_, c) => {
    const L = [C[c * 3], C[c * 3 + 1], C[c * 3 + 2]];
    const hex = rgbToHex(...labToRgb(...L));
    // keep earlier choices when the user changes the number of groups
    const prev = old.map(o => ({ o, d: deltaE(o.lab, L) })).sort((a, b) => a.d - b.d)[0];
    return { lab: L, hex, count: counts[c], target: prev && prev.d < 6 ? prev.o.target : null, bg: false };
  });
  // sort big → small, relabel
  const order = clusters.map((c, i) => i).sort((a, b) => clusters[b].count - clusters[a].count);
  const remap = new Uint8Array(k); order.forEach((o, i) => remap[o] = i);
  clusters = order.map(o => clusters[o]);
  for (let i = 0; i < n; i++) labels[i] = remap[labels[i]];
  markBg();
  selected = -1;
  busy(false);
  refreshList(); draw();
}

// The colour group that owns most of the picture's border counts as background.
function markBg() {
  clusters.forEach(c => c.bg = false);
  if (!ignoreBg || !labels) return;
  const { w, h } = img, tally = new Float64Array(k);
  for (let x = 0; x < w; x++) { tally[labels[x]]++; tally[labels[(h - 1) * w + x]]++; }
  for (let y = 0; y < h; y++) { tally[labels[y * w]]++; tally[labels[y * w + w - 1]]++; }
  let best = 0; for (let c = 1; c < k; c++) if (tally[c] > tally[best]) best = c;
  if (tally[best] > (w + h) * 2 * 0.5) clusters[best].bg = true;
}

function refreshList() {
  const list = document.querySelector('#page-recolour [data-list]');
  if (!list) return;
  list.innerHTML = '';
  if (!clusters.length) { list.innerHTML = '<p class="muted">Open a picture to see its colours.</p>'; summary(); return; }
  const total = clusters.reduce((a, c) => a + c.count, 0);
  clusters.forEach((c, i) => {
    const r = el('div', { class: 'cl' + (i === selected ? ' sel' : '') + (c.bg ? ' bg' : ''), 'data-ci': i });
    const t = c.target;
    const near = !t && !c.bg ? store.nearest(c.hex, 'owned', 1)[0] : null;
    r.innerHTML = `<span class="sw big" style="background:${c.hex}" title="Colour in the picture"></span><span class="arrow">→</span>
      <span class="sw big" style="background:${t ? swatchCss(t.hex) : 'repeating-linear-gradient(45deg,#ddd 0 4px,#fff 4px 8px)'}"></span>
      <div class="grow"><b>${c.bg ? 'Background' : t ? esc(t.name) : 'Not changed'}</b>
      <small class="muted">${Math.round(c.count / total * 100)}% of picture${t ? ` · ${esc(t.type)}${t.owned ? '' : ' · ♡ wish list'}` : near ? ` · closest you have: ${esc(near.f.name)} (${matchWords(near.d)})` : ''}</small></div>
      ${c.bg ? '<button class="link" data-unbg>change it</button>' : `<button class="btn small ghost" data-pick>Choose</button>${t ? '<button class="icon-btn" data-clear title="Put the original colour back">↺</button>' : ''}`}`;
    r.querySelector('[data-pick]')?.addEventListener('click', () => choose(i));
    r.querySelector('[data-clear]')?.addEventListener('click', () => { c.target = null; refreshList(); draw(); });
    r.querySelector('[data-unbg]')?.addEventListener('click', () => { c.bg = false; refreshList(); draw(); });
    r.onmouseenter = () => { selected = i; draw(); };
    r.onmouseleave = () => { selected = -1; draw(); };
    list.append(r);
  });
  summary();
}

async function choose(i) {
  const c = clusters[i];
  const f = await pickFilament({ title: 'Swap this colour for…', near: c.hex, allowNone: true, noneLabel: 'Keep the original colour' });
  if (f === undefined) return;
  c.target = f; c.bg = false;
  refreshList(); draw();
}

function autoMatch() {
  if (!store.state().spools.some(s => s.owned)) return toast('Add the spools you have on the Filaments page first');
  for (const c of clusters) if (!c.bg) c.target = store.nearest(c.hex, 'owned', 1)[0]?.f || null;
  refreshList(); draw();
}

function summary() {
  const sum = document.querySelector('#page-recolour [data-sum]');
  const used = [...new Map(clusters.filter(c => c.target && !c.bg).map(c => [c.target.id, c.target])).values()];
  const S = store.state();
  if (!used.length) { sum.innerHTML = ''; setDesignNeeds('picture', []); return; }
  const missing = used.filter(f => !f.owned);
  sum.innerHTML = `<b>${used.length} filament${used.length === 1 ? '' : 's'}</b>${used.length > S.amsSlots ? ` <span class="warn">more than your ${S.amsSlots} AMS slots</span>` : ''}
    <div class="row gap wrap">${used.map(f => `<span class="mini"><span class="sw" style="background:${swatchCss(f.hex)}"></span>${esc(f.name)}${f.owned ? '' : ' ♡'}</span>`).join('')}</div>
    ${missing.length ? `<p class="tiny">${missing.length} you don't have yet: they're on your <a href="#shop">shopping list</a>.</p>` : '<p class="tiny">You have all of these.</p>'}`;
  setDesignNeeds('picture', []);
}

function draw() {
  if (!img || !labels) return;
  const cv = document.querySelector('#page-recolour [data-canvas]');
  const cx = cv.getContext('2d');
  const { w, h, lab, data } = img;
  const out = new ImageData(w, h);
  const o = out.data, src = data.data;
  const tl = clusters.map(c => c.target && !c.bg ? hexToLab(c.target.hex[0]) : null);
  const mk = clusters.map(c => [...labToRgb(...c.lab)]);
  const cache = new Map();
  for (let i = 0; i < w * h; i++) {
    const p = i * 4, c = labels[i];
    let r = src[p], g = src[p + 1], b = src[p + 2];
    if (view === 'mask') { [r, g, b] = mk[c]; }
    else if (view === 'after' && tl[c]) {
      const key = c * 16777216 + ((r << 16) | (g << 8) | b);
      let v = cache.get(key);
      if (!v) {
        const C = clusters[c].lab, T = tl[c];
        const L = T[0] + (lab[i * 3] - C[0]) * (0.35 + shade * 0.65);
        const A = T[1] + (lab[i * 3 + 1] - C[1]) * shade * 0.5;
        const B = T[2] + (lab[i * 3 + 2] - C[2]) * shade * 0.5;
        v = labToRgb(Math.max(0, Math.min(100, L)), A, B);
        cache.set(key, v);
      }
      [r, g, b] = v;
    }
    if (selected >= 0 && c !== selected) { r = r * 0.35 + 255 * 0.15; g = g * 0.35 + 255 * 0.15; b = b * 0.35 + 255 * 0.15; }
    o[p] = r; o[p + 1] = g; o[p + 2] = b; o[p + 3] = src[p + 3];
  }
  cx.putImageData(out, 0, 0);
}

function savePicture() {
  const was = selected; selected = -1; view = 'after'; draw();
  document.querySelector('#page-recolour [data-canvas]').toBlob(b => {
    const a = el('a', { href: URL.createObjectURL(b), download: 'recoloured.png' }); a.click();
    selected = was;
  });
  document.querySelectorAll('#page-recolour [data-view] button').forEach(b => b.classList.toggle('on', b.dataset.v === 'after'));
}
