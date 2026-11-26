// Recolour a screenshot: find its main colours and swap each for a filament, or select areas by hand
// (magic wand, fill inside outlines, brush) and colour those.
import * as store from './store.js';
import { rgbToLab, labToRgb, hexToLab, swatchCss, rgbToHex, deltaE, matchWords } from './colour.js';
import { pickFilament } from './picker.js';
import { el, esc, toast, busy, nextFrame } from './ui.js';
import { setDesignNeeds } from './library.js';

const MAXW = 1600;
let img = null;           // { w, h, lab0: original Lab, lab: adjusted Lab (used for finding colours), alpha, data }
let k = 6;
let clusters = [];        // { lab (adjusted), lab0 (original mean, for shading), hex, count, target, bg }
let labels = null;        // Uint8Array: colour group per pixel
let view = 'after';
let hover = -1;           // colour group under the mouse in the list
let shade = 0.6;
let ignoreBg = true;
const adj = { exposure: 0, contrast: 0, saturation: 0 };

// hand-made areas
let tool = 'pick';        // pick | wand | fill | brush
const topt = { tol: 12, contiguous: true, edge: 18, size: 12, outlines: false };
let sel = null;           // Uint8Array selection mask
let areaOf = null;        // Uint8Array: 0 = follow its colour group, n = areas[n-1]
let areas = [];           // { target, lab0 (mean original colour of the area), count }
let edges = null;         // Float32Array edge strength (0-100ish)
const undoStack = [];

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
        <div class="pic-tools" data-ptools>
          <div class="seg" data-tool>
            <button data-t="pick" class="on" title="Click the picture to choose a colour group's filament">👆 Groups</button>
            <button data-t="wand" title="Select pixels of a similar colour">🪄 Magic wand</button>
            <button data-t="fill" title="Select an area enclosed by outlines">🪣 Fill inside lines</button>
            <button data-t="brush" title="Paint a selection by hand">🖌️ Brush</button>
          </div>
          <span class="topts" data-topts></span>
        </div>
        <div class="sel-bar" data-selbar hidden>
          <span data-selinfo></span>
          <button class="btn small" data-colour>Colour the selection…</button>
          <button class="btn ghost small" data-unarea title="Let the selected pixels follow their colour group again">Back to groups</button>
          <button class="btn ghost small" data-invert>Invert</button>
          <button class="btn ghost small" data-none>Clear selection</button>
        </div>
        <div class="drop" data-drop><p><b>Drop a screenshot here</b>, paste one with Ctrl+V, or open a picture.<br><span class="muted">A render from Bambu Studio, a MakerWorld photo, anything.</span></p>
        <canvas data-canvas hidden></canvas></div>
        <p class="muted tiny" data-hint></p>
      </section>
      <section class="card side">
        <h2>Colours</h2>
        <details class="adjust" data-adjust>
          <summary>Adjust to separate colours better</summary>
          <p class="muted tiny">Only changes how colours are told apart, not the finished picture. Brighten dark pictures so the shadows separate, add contrast or colour if similar shades get lumped together.</p>
          ${[['exposure', 'Exposure', -2, 2, 0.1], ['contrast', 'Contrast', -50, 80, 1], ['saturation', 'Colour strength', -60, 150, 5]].map(([k2, l, mn, mx, st]) =>
            `<label class="tiny slider">${l} <input type="range" min="${mn}" max="${mx}" step="${st}" value="${adj[k2]}" data-adj="${k2}"><b data-adjv="${k2}">${adj[k2]}</b></label>`).join('')}
          <button class="link" data-adjreset>Reset</button>
        </details>
        <label class="tiny slider">Colour groups <input type="range" min="2" max="24" value="${k}" data-k><b data-kv>${k}</b></label>
        <label class="tiny slider" title="How much of the picture's light and shadow is kept on the new colour">Keep shading <input type="range" min="0" max="1" step="0.05" value="${shade}" data-shade><b data-shv>${Math.round(shade * 100)}%</b></label>
        <p class="muted tiny">Keep shading: 0% paints each area one flat filament colour. 100% keeps all the original light and shadow on the new colour, so it still looks 3D.</p>
        <label class="check tiny"><input type="checkbox" data-bg ${ignoreBg ? 'checked' : ''}> Leave the background alone (the colour along the edges)</label>
        <div class="row gap"><button class="btn small" data-auto disabled>Match to my spools</button><button class="btn ghost small" data-reset disabled>Undo all swaps</button><button class="btn ghost small" data-undo disabled>↶ Undo</button></div>
        <div class="areas" data-areas></div>
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
  document.addEventListener('keydown', e => {
    if (!document.querySelector('#page-recolour.on') || e.target.matches?.('input, select, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'Escape') { sel = null; afterSel(); }
  });
  $('[data-k]').oninput = e => { $('[data-kv]').textContent = e.target.value; };
  $('[data-k]').onchange = e => { k = +e.target.value; if (img) analyse(); };
  $('[data-shade]').oninput = e => { shade = +e.target.value; $('[data-shv]').textContent = Math.round(shade * 100) + '%'; draw(); };
  $('[data-bg]').onchange = e => { ignoreBg = e.target.checked; markBg(); refreshList(); draw(); };
  let adjT;
  root.querySelectorAll('[data-adj]').forEach(i => i.oninput = () => {
    adj[i.dataset.adj] = +i.value; $(`[data-adjv="${i.dataset.adj}"]`).textContent = i.value;
    clearTimeout(adjT); adjT = setTimeout(() => img && reAdjust(), 250);
  });
  $('[data-adjreset]').onclick = () => { Object.assign(adj, { exposure: 0, contrast: 0, saturation: 0 }); root.querySelectorAll('[data-adj]').forEach(i => { i.value = 0; $(`[data-adjv="${i.dataset.adj}"]`).textContent = 0; }); img && reAdjust(); };
  $('[data-view]').onclick = e => { const v = e.target.dataset.v; if (!v) return; view = v; root.querySelectorAll('[data-view] button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); draw(); };
  $('[data-tool]').onclick = e => { const t = e.target.closest('[data-t]')?.dataset.t; if (t) setTool(t); };
  $('[data-auto]').onclick = autoMatch;
  $('[data-reset]').onclick = () => { pushUndo(); clusters.forEach(c => c.target = null); refreshList(); draw(); };
  $('[data-undo]').onclick = undo;
  $('[data-save]').onclick = savePicture;
  $('[data-colour]').onclick = colourSelection;
  $('[data-unarea]').onclick = () => { if (!sel) return; pushUndo(); for (let i = 0; i < sel.length; i++) if (sel[i]) areaOf[i] = 0; tidyAreas(); sel = null; afterSel(); };
  $('[data-invert]').onclick = () => { if (!sel) return; for (let i = 0; i < sel.length; i++) sel[i] = sel[i] ? 0 : 1; afterSel(); };
  $('[data-none]').onclick = () => { sel = null; afterSel(); };
  setupCanvas($('[data-canvas]'));
  setTool('pick');
}

function setTool(t) {
  tool = t;
  const root = document.getElementById('page-recolour');
  root.querySelectorAll('[data-tool] button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  const o = root.querySelector('[data-topts]');
  const outl = `<label class="check"><input type="checkbox" data-to="outlines" ${topt.outlines ? 'checked' : ''}> Show outlines</label>`;
  o.innerHTML = {
    pick: '',
    wand: `<label>How similar <input type="range" min="1" max="60" value="${topt.tol}" data-to="tol"><b>${topt.tol}</b></label>
      <label class="check"><input type="checkbox" data-to="contiguous" ${topt.contiguous ? 'checked' : ''}> Only touching pixels</label>`,
    fill: `<label>Outline strength <input type="range" min="3" max="60" value="${topt.edge}" data-to="edge"><b>${topt.edge}</b></label>${outl}`,
    brush: `<label>Size <input type="range" min="2" max="120" value="${topt.size}" data-to="size"><b>${topt.size}</b></label>`,
  }[t];
  o.querySelectorAll('[data-to]').forEach(i => i.addEventListener(i.type === 'checkbox' ? 'change' : 'input', () => {
    topt[i.dataset.to] = i.type === 'checkbox' ? i.checked : +i.value;
    if (i.type === 'range') i.nextElementSibling.textContent = i.value;
    if (i.dataset.to === 'outlines' || i.dataset.to === 'edge') draw();
  }));
  root.querySelector('[data-hint]').textContent = {
    pick: 'Click the picture to choose a filament for that colour group.',
    wand: 'Click a colour to select it. Shift-click adds more, Alt-click takes away. Then press "Colour the selection".',
    fill: 'Click inside an outlined area to select it (stops at lines and edges). Lower the outline strength if it leaks out. Shift adds, Alt takes away.',
    brush: 'Drag to paint a selection. Hold Alt to rub it out.',
  }[t];
  draw();
}

/* ---------- loading & adjusting ---------- */
async function loadFile(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, MAXW / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const cv = new OffscreenCanvas(w, h), cx = cv.getContext('2d');
  cx.drawImage(bmp, 0, 0, w, h);
  const data = cx.getImageData(0, 0, w, h);
  const lab0 = new Float32Array(w * h * 3), alpha = new Uint8Array(w * h);
  const cache = new Map();
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const key = (data.data[p] << 16) | (data.data[p + 1] << 8) | data.data[p + 2];
    let L = cache.get(key);
    if (!L) { L = rgbToLab(data.data[p], data.data[p + 1], data.data[p + 2]); cache.set(key, L); }
    lab0[i * 3] = L[0]; lab0[i * 3 + 1] = L[1]; lab0[i * 3 + 2] = L[2];
    alpha[i] = data.data[p + 3];
  }
  img = { w, h, lab0, lab: lab0, alpha, data };
  sel = null; areaOf = new Uint8Array(w * h); areas = []; undoStack.length = 0;
  const cv2 = document.querySelector('#page-recolour [data-canvas]');
  cv2.width = w; cv2.height = h; cv2.hidden = false;
  document.querySelector('#page-recolour [data-drop] p').hidden = true;
  ['[data-auto]', '[data-reset]', '[data-save]'].forEach(s => document.querySelector('#page-recolour ' + s).disabled = false);
  await reAdjust();
}

// Exposure / contrast / colour strength, applied to a copy used only for telling colours apart.
async function reAdjust() {
  const { exposure, contrast, saturation } = adj;
  if (!exposure && !contrast && !saturation) img.lab = img.lab0;
  else {
    busy('Adjusting…'); await nextFrame();
    const { data, w, h } = img, d = data.data;
    const lab = new Float32Array(w * h * 3), cache = new Map();
    const ev = Math.pow(2, exposure), c = 1 + contrast / 100, sat = 1 + saturation / 100;
    const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const srgb = v => { v = Math.max(0, Math.min(1, v)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); };
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const key = (d[p] << 16) | (d[p + 1] << 8) | d[p + 2];
      let L = cache.get(key);
      if (!L) {
        const rgb = [d[p], d[p + 1], d[p + 2]].map(v => { let x = srgb(lin(v) * ev) / 255; x = (x - 0.5) * c + 0.5; return Math.max(0, Math.min(255, x * 255)); });
        L = rgbToLab(rgb[0], rgb[1], rgb[2]); L = [L[0], L[1] * sat, L[2] * sat];
        cache.set(key, L);
      }
      lab[i * 3] = L[0]; lab[i * 3 + 1] = L[1]; lab[i * 3 + 2] = L[2];
    }
    img.lab = lab;
    busy(false);
  }
  edges = null;
  await analyse();
}

/* ---------- colour groups (k-means in Lab) ---------- */
function kmeans(P, m, kk, iters = 20) {
  const C = new Float32Array(kk * 3);
  C.set(P.subarray(0, 3), 0);
  const D = new Float32Array(m).fill(Infinity);
  for (let c = 1; c < kk; c++) {
    let sum = 0;
    for (let j = 0; j < m; j++) {
      const dl = P[j * 3] - C[(c - 1) * 3], da = P[j * 3 + 1] - C[(c - 1) * 3 + 1], db = P[j * 3 + 2] - C[(c - 1) * 3 + 2];
      D[j] = Math.min(D[j], dl * dl + da * da + db * db); sum += D[j];
    }
    let r = Math.random() * sum, j = 0;
    for (; j < m - 1; j++) { r -= D[j]; if (r <= 0) break; }
    C.set(P.subarray(j * 3, j * 3 + 3), c * 3);
  }
  for (let it = 0; it < iters; it++) {
    const sums = new Float64Array(kk * 4);
    for (let j = 0; j < m; j++) {
      const b = nearestC(C, kk, P[j * 3], P[j * 3 + 1], P[j * 3 + 2]);
      sums[b * 4] += P[j * 3]; sums[b * 4 + 1] += P[j * 3 + 1]; sums[b * 4 + 2] += P[j * 3 + 2]; sums[b * 4 + 3]++;
    }
    for (let c = 0; c < kk; c++) if (sums[c * 4 + 3]) for (let q = 0; q < 3; q++) C[c * 3 + q] = sums[c * 4 + q] / sums[c * 4 + 3];
  }
  return C;
}
function nearestC(C, kk, l, a, b) {
  let best = 0, bd = Infinity;
  for (let c = 0; c < kk; c++) {
    const dl = l - C[c * 3], da = a - C[c * 3 + 1], db = b - C[c * 3 + 2];
    const d = dl * dl + da * da + db * db;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

async function analyse() {
  busy('Finding the main colours…'); await nextFrame();
  const { w, h, lab, alpha } = img, n = w * h;
  const step = Math.max(1, Math.floor(n / 60000));
  const pts = [];
  for (let i = 0; i < n; i += step) if (alpha[i] > 128) pts.push(i);
  // shuffle so k-means++ starts somewhere random
  for (let i = pts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pts[i], pts[j]] = [pts[j], pts[i]]; }
  const P = new Float32Array(pts.length * 3);
  pts.forEach((p, j) => P.set(lab.subarray(p * 3, p * 3 + 3), j * 3));
  const C = kmeans(P, pts.length, k);
  const kk = k;
  labels = new Uint8Array(n);
  for (let i = 0; i < n; i++) labels[i] = nearestC(C, kk, lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]);
  const old = clusters;
  clusters = [...Array(kk)].map((_, c) => ({ lab: [C[c * 3], C[c * 3 + 1], C[c * 3 + 2]] }));
  finishClusters(old);
  busy(false);
  refreshList(); draw();
}

// counts, original-colour means, sort big → small, keep earlier choices where the colour is about the same
function finishClusters(old = []) {
  const { lab0 } = img, n = labels.length, kk = clusters.length;
  const sums = new Float64Array(kk * 4);
  for (let i = 0; i < n; i++) { const c = labels[i]; sums[c * 4] += lab0[i * 3]; sums[c * 4 + 1] += lab0[i * 3 + 1]; sums[c * 4 + 2] += lab0[i * 3 + 2]; sums[c * 4 + 3]++; }
  clusters.forEach((cl, c) => {
    const cnt = sums[c * 4 + 3] || 1;
    cl.lab0 = [sums[c * 4] / cnt, sums[c * 4 + 1] / cnt, sums[c * 4 + 2] / cnt];
    cl.hex = rgbToHex(...labToRgb(...cl.lab0));
    cl.count = sums[c * 4 + 3];
    if (cl.target === undefined) {
      const prev = old.map(o => ({ o, d: deltaE(o.lab0, cl.lab0) })).sort((a, b) => a.d - b.d)[0];
      cl.target = prev && prev.d < 6 ? prev.o.target : null;
    }
    cl.bg = false;
  });
  const order = clusters.map((c, i) => i).filter(i => clusters[i].count > 0).sort((a, b) => clusters[b].count - clusters[a].count);
  const remap = new Uint8Array(kk); order.forEach((o, i) => remap[o] = i);
  clusters = order.map(o => clusters[o]);
  for (let i = 0; i < n; i++) labels[i] = remap[labels[i]];
  markBg();
}

// Split one colour group in two (when two colours got lumped together).
function splitGroup(ci) {
  if (clusters.length >= 250) return;
  const { lab } = img, idx = [];
  for (let i = 0; i < labels.length; i++) if (labels[i] === ci) idx.push(i);
  if (idx.length < 20) return toast('Too small to split');
  const step = Math.max(1, Math.floor(idx.length / 40000));
  const sub = idx.filter((_, j) => j % step === 0);
  for (let i = sub.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [sub[i], sub[j]] = [sub[j], sub[i]]; }
  const P = new Float32Array(sub.length * 3);
  sub.forEach((p, j) => P.set(lab.subarray(p * 3, p * 3 + 3), j * 3));
  const C = kmeans(P, sub.length, 2);
  const nu = clusters.length;
  for (const i of idx) if (nearestC(C, 2, lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]) === 1) labels[i] = nu;
  const t = clusters[ci].target;
  clusters.push({ lab: [C[3], C[4], C[5]], target: t });
  clusters[ci].lab = [C[0], C[1], C[2]];
  clusters.forEach(c => { if (c.target === undefined) c.target = null; });
  finishClusters(clusters);
  k = clusters.length;
  const kin = document.querySelector('#page-recolour [data-k]');
  if (kin) { kin.value = Math.min(24, k); document.querySelector('#page-recolour [data-kv]').textContent = k; }
  refreshList(); draw();
}

function markBg() {
  clusters.forEach(c => c.bg = false);
  if (!ignoreBg || !labels) return;
  const { w, h } = img, tally = new Float64Array(clusters.length);
  for (let x = 0; x < w; x++) { tally[labels[x]]++; tally[labels[(h - 1) * w + x]]++; }
  for (let y = 0; y < h; y++) { tally[labels[y * w]]++; tally[labels[y * w + w - 1]]++; }
  let best = 0; for (let c = 1; c < clusters.length; c++) if (tally[c] > tally[best]) best = c;
  if (tally[best] > (w + h) * 2 * 0.5) clusters[best].bg = true;
}

/* ---------- selection tools ---------- */
function setupCanvas(cv) {
  let painting = false, mode = 1;
  const pos = e => { const r = cv.getBoundingClientRect(); return [Math.floor((e.clientX - r.left) / r.width * img.w), Math.floor((e.clientY - r.top) / r.height * img.h), img.w / r.width]; };
  cv.addEventListener('pointerdown', e => {
    if (!labels) return;
    const [x, y, scale] = pos(e);
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
    mode = e.altKey ? 0 : 1;
    const add = e.shiftKey || e.altKey;
    if (tool === 'pick') { hover = labels[y * img.w + x]; refreshList(); draw(); document.querySelector(`#page-recolour [data-ci="${hover}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); choose(hover); return; }
    if (tool === 'wand' || tool === 'fill') {
      const region = tool === 'wand' ? wand(x, y) : fillInside(x, y);
      if (!sel || !add) sel = new Uint8Array(img.w * img.h);
      for (const i of region) sel[i] = mode;
      afterSel();
      return;
    }
    if (tool === 'brush') {
      if (!sel) sel = new Uint8Array(img.w * img.h);
      painting = true; cv.setPointerCapture(e.pointerId);
      dab(x, y, topt.size * scale / 2, mode); afterSel(false);
    }
  });
  cv.addEventListener('pointermove', e => {
    if (!painting) return;
    const [x, y, scale] = pos(e);
    dab(x, y, topt.size * scale / 2, mode); afterSel(false);
  });
  cv.addEventListener('pointerup', () => { if (painting) { painting = false; afterSel(); } });
}

function dab(cx, cy, r, v) {
  const { w, h } = img, r2 = r * r;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) sel[y * w + x] = v;
}

function wand(x, y) {
  const { w, h, lab } = img, s = (y * w + x) * 3;
  const L = lab[s], A = lab[s + 1], B = lab[s + 2], t2 = topt.tol * topt.tol;
  const near = i => { const dl = lab[i * 3] - L, da = lab[i * 3 + 1] - A, db = lab[i * 3 + 2] - B; return dl * dl + da * da + db * db <= t2; };
  if (!topt.contiguous) { const out = []; for (let i = 0; i < w * h; i++) if (near(i)) out.push(i); return out; }
  return flood(x, y, near);
}

// Sobel edge strength on the adjusted lightness + colour, so outlines and colour borders both count.
function edgeMap() {
  if (edges) return edges;
  const { w, h, lab } = img;
  edges = new Float32Array(w * h);
  const g = (x, y, q) => lab[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 3 + q];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let q = 0; q < 3; q++) {
      const gx = g(x + 1, y - 1, q) + 2 * g(x + 1, y, q) + g(x + 1, y + 1, q) - g(x - 1, y - 1, q) - 2 * g(x - 1, y, q) - g(x - 1, y + 1, q);
      const gy = g(x - 1, y + 1, q) + 2 * g(x, y + 1, q) + g(x + 1, y + 1, q) - g(x - 1, y - 1, q) - 2 * g(x, y - 1, q) - g(x + 1, y - 1, q);
      m += (q ? 0.6 : 1) * Math.hypot(gx, gy);
    }
    edges[y * w + x] = m / 4;
  }
  return edges;
}

function fillInside(x, y) {
  const e = edgeMap(), lim = topt.edge;
  const region = flood(x, y, i => e[i] < lim);
  // grow one pixel so the fill tucks under the soft edge of the line
  const { w, h } = img, inR = new Uint8Array(w * h);
  for (const i of region) inR[i] = 1;
  const extra = [];
  for (const i of region) { const px = i % w; for (const j of [i - 1, i + 1, i - w, i + w]) if (j >= 0 && j < w * h && !inR[j] && Math.abs((j % w) - px) <= 1) { inR[j] = 1; extra.push(j); } }
  return region.concat(extra);
}

function flood(x, y, ok) {
  const { w, h } = img, seen = new Uint8Array(w * h), out = [], start = y * w + x;
  if (!ok(start)) return [start];
  const stack = [start]; seen[start] = 1;
  while (stack.length) {
    const i = stack.pop(); out.push(i);
    const px = i % w, py = (i - px) / w;
    if (px > 0 && !seen[i - 1] && ok(i - 1)) { seen[i - 1] = 1; stack.push(i - 1); }
    if (px < w - 1 && !seen[i + 1] && ok(i + 1)) { seen[i + 1] = 1; stack.push(i + 1); }
    if (py > 0 && !seen[i - w] && ok(i - w)) { seen[i - w] = 1; stack.push(i - w); }
    if (py < h - 1 && !seen[i + w] && ok(i + w)) { seen[i + w] = 1; stack.push(i + w); }
  }
  return out;
}

function afterSel(full = true) {
  const bar = document.querySelector('#page-recolour [data-selbar]');
  let n = 0; if (sel) for (let i = 0; i < sel.length; i++) n += sel[i];
  if (!n) sel = null;
  bar.hidden = !sel;
  if (sel) bar.querySelector('[data-selinfo]').textContent = `${(n / sel.length * 100).toFixed(n / sel.length < 0.01 ? 2 : 1)}% of the picture selected`;
  draw();
}

async function colourSelection() {
  if (!sel) return;
  // average original colour of the selection, for the picker's suggestions and for shading
  const { lab0 } = img; let L = 0, A = 0, B = 0, n = 0;
  for (let i = 0; i < sel.length; i++) if (sel[i]) { L += lab0[i * 3]; A += lab0[i * 3 + 1]; B += lab0[i * 3 + 2]; n++; }
  const mean = [L / n, A / n, B / n];
  const f = await pickFilament({ title: 'Colour the selection with…', near: rgbToHex(...labToRgb(...mean)) });
  if (!f) return;
  pushUndo();
  areas.push({ target: f, lab0: mean, count: n });
  const id = areas.length;
  for (let i = 0; i < sel.length; i++) if (sel[i]) areaOf[i] = id;
  tidyAreas();
  sel = null; afterSel(); refreshList();
}

// drop areas nothing points at any more, renumber the rest
function tidyAreas() {
  const counts = new Float64Array(areas.length + 1);
  for (let i = 0; i < areaOf.length; i++) counts[areaOf[i]]++;
  const map = new Uint8Array(areas.length + 1); const keep = [];
  areas.forEach((a, j) => { if (counts[j + 1] > 0 && keep.length < 250) { keep.push({ ...a, count: counts[j + 1] }); map[j + 1] = keep.length; } });
  for (let i = 0; i < areaOf.length; i++) areaOf[i] = map[areaOf[i]];
  areas = keep;
  refreshList();
}

function pushUndo() {
  undoStack.push({ areaOf: areaOf && areaOf.slice(), areas: areas.map(a => ({ ...a })), targets: clusters.map(c => c.target) });
  if (undoStack.length > 20) undoStack.shift();
  const b = document.querySelector('#page-recolour [data-undo]'); if (b) b.disabled = false;
}
function undo() {
  const u = undoStack.pop(); if (!u) return;
  areaOf = u.areaOf; areas = u.areas;
  if (u.targets.length === clusters.length) clusters.forEach((c, i) => c.target = u.targets[i]);
  document.querySelector('#page-recolour [data-undo]').disabled = !undoStack.length;
  refreshList(); draw();
}

/* ---------- list ---------- */
function refreshList() {
  const list = document.querySelector('#page-recolour [data-list]');
  if (!list) return;
  const total = labels ? labels.length : 1;
  const ab = document.querySelector('#page-recolour [data-areas]');
  ab.innerHTML = areas.length ? '<h3 class="tiny-h">Areas you coloured</h3>' : '';
  areas.forEach((a, j) => {
    const r = el('div', { class: 'cl' });
    r.innerHTML = `<span class="sw big" style="background:${rgbToHex(...labToRgb(...a.lab0))}"></span><span class="arrow">→</span><span class="sw big" style="background:${swatchCss(a.target.hex)}"></span>
      <div class="grow"><b>${esc(a.target.name)}</b><small class="muted">${(a.count / total * 100).toFixed(1)}% · ${esc(a.target.type)}${a.target.owned ? '' : ' · ♡ wish list'}</small></div>
      <button class="btn small ghost" data-pick>Change</button><button class="icon-btn" data-sel title="Select this area again">⬚</button><button class="icon-btn" data-del title="Remove (back to its colour groups)">✕</button>`;
    r.querySelector('[data-pick]').onclick = async () => { const f = await pickFilament({ title: 'Colour this area with…', near: rgbToHex(...labToRgb(...a.lab0)) }); if (f) { pushUndo(); a.target = f; refreshList(); draw(); } };
    r.querySelector('[data-sel]').onclick = () => { sel = new Uint8Array(areaOf.length); for (let i = 0; i < areaOf.length; i++) if (areaOf[i] === j + 1) sel[i] = 1; afterSel(); };
    r.querySelector('[data-del]').onclick = () => { pushUndo(); for (let i = 0; i < areaOf.length; i++) if (areaOf[i] === j + 1) areaOf[i] = 0; tidyAreas(); draw(); };
    ab.append(r);
  });
  list.innerHTML = '';
  if (!clusters.length) { list.innerHTML = '<p class="muted">Open a picture to see its colours.</p>'; summary(); return; }
  if (areas.length) list.append(el('h3', { class: 'tiny-h' }, 'Colour groups'));
  clusters.forEach((c, i) => {
    const r = el('div', { class: 'cl' + (i === hover ? ' sel' : '') + (c.bg ? ' bg' : ''), 'data-ci': i });
    const t = c.target;
    const near = !t && !c.bg ? store.nearest(c.hex, 'owned', 1)[0] : null;
    r.innerHTML = `<span class="sw big" style="background:${c.hex}" title="Colour in the picture"></span><span class="arrow">→</span>
      <span class="sw big" style="background:${t ? swatchCss(t.hex) : 'repeating-linear-gradient(45deg,#ddd 0 4px,#fff 4px 8px)'}"></span>
      <div class="grow"><b>${c.bg ? 'Background' : t ? esc(t.name) : 'Not changed'}</b>
      <small class="muted">${(c.count / total * 100).toFixed(c.count / total < 0.01 ? 2 : 0)}% of picture${t ? ` · ${esc(t.type)}${t.owned ? '' : ' · ♡ wish list'}` : near ? ` · closest you have: ${esc(near.f.name)} (${matchWords(near.d)})` : ''}</small></div>
      ${c.bg ? '<button class="link" data-unbg>change it</button>' : `<button class="btn small ghost" data-pick>Choose</button>`}
      <button class="icon-btn" data-split title="Split this group in two (when two colours got lumped together)">⫽</button>
      <button class="icon-btn" data-gsel title="Select this group (to colour part of it by hand)">⬚</button>
      ${t ? '<button class="icon-btn" data-clear title="Put the original colour back">↺</button>' : ''}`;
    r.querySelector('[data-pick]')?.addEventListener('click', () => choose(i));
    r.querySelector('[data-clear]')?.addEventListener('click', () => { pushUndo(); c.target = null; refreshList(); draw(); });
    r.querySelector('[data-unbg]')?.addEventListener('click', () => { c.bg = false; refreshList(); draw(); });
    r.querySelector('[data-split]').addEventListener('click', () => splitGroup(i));
    r.querySelector('[data-gsel]').addEventListener('click', () => { sel = new Uint8Array(labels.length); for (let p = 0; p < labels.length; p++) if (labels[p] === i) sel[p] = 1; afterSel(); });
    r.onmouseenter = () => { hover = i; draw(); };
    r.onmouseleave = () => { hover = -1; draw(); };
    list.append(r);
  });
  summary();
}

async function choose(i) {
  const c = clusters[i];
  const f = await pickFilament({ title: 'Swap this colour for…', near: c.hex, allowNone: true, noneLabel: 'Keep the original colour' });
  if (f === undefined) return;
  pushUndo();
  c.target = f; c.bg = false;
  refreshList(); draw();
}

function autoMatch() {
  if (!store.state().spools.some(s => s.owned)) return toast('Add the spools you have on the Filaments page first');
  pushUndo();
  for (const c of clusters) if (!c.bg) c.target = store.nearest(c.hex, 'owned', 1)[0]?.f || null;
  refreshList(); draw();
}

function summary() {
  const sum = document.querySelector('#page-recolour [data-sum]');
  const used = [...new Map([...clusters.filter(c => c.target && !c.bg).map(c => c.target), ...areas.map(a => a.target)].map(t => [t.id, t])).values()];
  const S = store.state();
  setDesignNeeds('picture', []);
  if (!used.length) { sum.innerHTML = ''; return; }
  const missing = used.filter(f => !f.owned);
  sum.innerHTML = `<b>${used.length} filament${used.length === 1 ? '' : 's'}</b>${used.length > S.amsSlots ? ` <span class="warn">more than your ${S.amsSlots} AMS slots</span>` : ''}
    <div class="row gap wrap">${used.map(f => `<span class="mini"><span class="sw" style="background:${swatchCss(f.hex)}"></span>${esc(f.name)}${f.owned ? '' : ' ♡'}</span>`).join('')}</div>
    ${missing.length ? `<p class="tiny">${missing.length} you don't have yet: they're on your <a href="#shop">shopping list</a>.</p>` : '<p class="tiny">You have all of these.</p>'}`;
}

/* ---------- drawing ---------- */
function draw() {
  if (!img || !labels) return;
  const cv = document.querySelector('#page-recolour [data-canvas]');
  const cx = cv.getContext('2d');
  const { w, h, lab0, data } = img;
  const out = new ImageData(w, h);
  const o = out.data, src = data.data;
  const ctl = clusters.map(c => c.target && !c.bg ? hexToLab(c.target.hex[0]) : null);
  const atl = areas.map(a => hexToLab(a.target.hex[0]));
  const mk = clusters.map(c => [...labToRgb(...c.lab0)]);
  const showEdges = tool === 'fill' && topt.outlines;
  const E = showEdges ? edgeMap() : null;
  const cache = new Map();
  const sL = 0.35 + shade * 0.65, sC = shade * 0.5;
  for (let i = 0; i < w * h; i++) {
    const p = i * 4, c = labels[i], ar = areaOf ? areaOf[i] : 0;
    let r = src[p], g = src[p + 1], b = src[p + 2];
    if (view === 'mask') { [r, g, b] = mk[c]; }
    else if (view === 'after') {
      const T = ar ? atl[ar - 1] : ctl[c];
      if (T) {
        const key = (ar ? 1e9 + ar * 1e7 : c * 16777216) + ((r << 16) | (g << 8) | b);
        let v = cache.get(key);
        if (!v) {
          const C = ar ? areas[ar - 1].lab0 : clusters[c].lab0;
          v = labToRgb(Math.max(0, Math.min(100, T[0] + (lab0[i * 3] - C[0]) * sL)), T[1] + (lab0[i * 3 + 1] - C[1]) * sC, T[2] + (lab0[i * 3 + 2] - C[2]) * sC);
          cache.set(key, v);
        }
        [r, g, b] = v;
      }
    }
    if (hover >= 0 && c !== hover) { r = r * 0.35 + 38; g = g * 0.35 + 38; b = b * 0.35 + 38; }
    if (E && E[i] >= topt.edge) { r = 255; g = 40; b = 120; }
    if (sel) {
      if (sel[i]) { // blue tint + checker so it reads on any colour
        const ch = ((i % w) >> 2 ^ (Math.floor(i / w) >> 2)) & 1;
        r = r * 0.5 + (ch ? 40 : 70) * 0.5; g = g * 0.5 + (ch ? 140 : 170) * 0.5; b = b * 0.5 + 255 * 0.5;
      } else { r *= 0.75; g *= 0.75; b *= 0.75; }
    }
    o[p] = r; o[p + 1] = g; o[p + 2] = b; o[p + 3] = src[p + 3];
  }
  cx.putImageData(out, 0, 0);
}

function savePicture() {
  const was = [hover, sel, view, tool];
  hover = -1; sel = null; view = 'after'; tool = 'pick'; draw();
  document.querySelector('#page-recolour [data-canvas]').toBlob(b => {
    const a = el('a', { href: URL.createObjectURL(b), download: 'recoloured.png' }); a.click();
    [hover, sel, view, tool] = was; draw();
  });
}
