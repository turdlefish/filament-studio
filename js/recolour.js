// Recolour a screenshot: find its main colours and swap each for a filament, or select areas by hand
// (magic wand, fill inside outlines, brush) and colour those.
import * as store from './store.js';
import { rgbToLab, labToRgb, hexToLab, swatchCss, rgbToHex, deltaE, matchWords } from './colour.js';
import { pickFilament } from './picker.js';
import { el, esc, toast, busy, nextFrame, download } from './ui.js';
import { zipSync, unzipSync, strToU8, strFromU8 } from '../vendor/fflate.module.js';
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
const thr = { on: false, level: 50 }; // threshold: lightness level (0-100) that splits black from white

// hand-made areas
let tool = 'pick';        // pick | wand | fill | brush
const topt = { tol: 12, contiguous: true, edge: 18, size: 12, outlines: false, feather: 0, flat: false };
let sel = null;           // Uint8Array selection mask, 0-255 (in between = soft edge)
let areaOf = null;        // Uint8Array: 0 = follow its colour group, n = areas[n-1]
let areaAlpha = null;     // Uint8Array: how much of its own group's colour a pixel takes (255 = all; less on soft edges)
let areas = [];           // your own groups: { target (or null), lab0 (mean original colour), count, name, flat }
let saved = { id: null, name: '' }; // the saved copy this picture belongs to
let edges = null;         // Float32Array edge strength (0-100ish)
let hoverA = 0;           // your own group under the mouse in the list (1-based)
const undoStack = [], redoStack = [];
let areaVer = 0, labelsVer = 0, lastCopy = {};
// zoom & pan of the picture
const zv = { z: 1, x: 0, y: 0, fitted: true };
let spaceDown = false;

export function renderRecolour() {
  const root = document.getElementById('page-recolour');
  if (root.dataset.ready) return refreshList();
  root.dataset.ready = 1;
  root.innerHTML = `
    <div class="split">
      <section class="card canvas-card">
        <div class="card-head"><h2>Picture <small class="muted" data-picname></small></h2>
          <div class="row gap wrap">
            <label class="btn small">Open a picture<input type="file" accept="image/*,.fspic" hidden data-file></label>
            <button class="btn small" data-store disabled title="Keep this picture with all its groups and colours, to come back and edit later">💾 Save</button>
            <button class="btn ghost small" data-saved title="Your saved pictures">📂 Saved</button>
            <div class="seg" data-view><button data-v="before">Before</button><button data-v="after" class="on">After</button><button data-v="mask">Groups</button></div>
            <button class="btn ghost small" data-save disabled title="Download the recoloured picture as a PNG image">⬇ Download image</button>
          </div></div>
        <div class="pic-tools" data-ptools>
          <div class="seg" data-tool>
            <button data-t="pick" class="on" title="Click the picture to choose a colour group's filament">👆 Groups</button>
            <button data-t="wand" title="Select pixels of a similar colour">🪄 Magic wand</button>
            <button data-t="fill" title="Select an area enclosed by outlines">🪣 Fill inside lines</button>
            <button data-t="brush" title="Paint a selection by hand">🖌️ Brush</button>
            <button data-t="move" title="Drag to move around a zoomed-in picture (or hold Space, or drag with the right mouse button)">✋ Move</button>
          </div>
          <span class="topts" data-topts></span>
          <span class="zoom-ctl">
            <button class="icon-btn" data-undo disabled title="Undo (Ctrl+Z)">↶</button><button class="icon-btn" data-redo disabled title="Redo (Ctrl+Y)">↷</button>
            <button class="icon-btn" data-zoom="-1" title="Zoom out">−</button><button class="btn ghost small" data-zoomfit title="Fit the whole picture">Fit</button><button class="icon-btn" data-zoom="1" title="Zoom in (or scroll the mouse wheel over the picture)">+</button><b data-zoomv class="tiny"></b>
          </span>
        </div>
        <div class="sel-bar" data-selbar hidden>
          <span data-selinfo></span>
          <button class="btn small" data-colour>Colour the selection…</button>
          <button class="btn small ghost" data-mkgroup title="Make the selected pixels into one group of their own (joins parts together)">Make a group</button>
          <label class="soft-edge" title="Feathers the edge of the selection, so the new colour fades into what's next to it instead of a hard cut. 0 = hard edge.">Soft edge <input type="range" min="0" max="30" value="${topt.feather}" data-feather><b data-featherv>${topt.feather}</b> px</label>
          <label class="check" title="Colour it as one flat filament colour, without the picture's light and shadow"><input type="checkbox" data-flatsel ${topt.flat ? 'checked' : ''}> One solid colour</label>
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
          <p class="muted tiny">While this is open, the picture shows what the magic wand, fill and colour groups see. It doesn't change the finished picture. Brighten dark pictures so the shadows separate; add contrast or colour if similar shades get lumped together.</p>
          ${[['exposure', 'Exposure', -3, 3, 0.05], ['contrast', 'Contrast', -50, 100, 1], ['saturation', 'Colour strength', -100, 200, 5]].map(([k2, l, mn, mx, st]) =>
            `<label class="tiny slider">${l} <input type="range" min="${mn}" max="${mx}" step="${st}" value="${adj[k2]}" data-adj="${k2}"><b data-adjv="${k2}">${adj[k2]}</b></label>`).join('')}
          <div class="thr">
            <label class="check tiny"><input type="checkbox" data-thr> <b>Threshold</b>: black and white only</label>
            <div class="hist-wrap"><canvas data-hist width="256" height="56"></canvas></div>
            <label class="tiny slider">Level <input type="range" min="0" max="100" step="0.5" value="${thr.level}" data-thrl><b data-thrv>${thr.level}</b></label>
            <p class="muted tiny">Everything lighter than the level turns white, everything darker black. Drag the level (or click the ramp) until the shape you want stands on its own. While it's ticked, the 🪄 wand and 🪣 fill pick from the black-and-white picture, so one click selects the whole shape (close this panel to see your colours again; the wand keeps using the threshold until you untick it).</p>
          </div>
          <button class="link" data-adjreset>Reset</button>
        </details>
        <label class="tiny slider">Colour groups <input type="range" min="2" max="24" value="${k}" data-k><b data-kv>${k}</b></label>
        <label class="tiny slider" title="How much of the picture's light and shadow is kept on the new colour">Keep shading <input type="range" min="0" max="1" step="0.05" value="${shade}" data-shade><b data-shv>${Math.round(shade * 100)}%</b></label>
        <p class="muted tiny">Keep shading: 0% paints each area one flat filament colour. 100% keeps all the original light and shadow on the new colour, so it still looks 3D.</p>
        <label class="check tiny"><input type="checkbox" data-bg ${ignoreBg ? 'checked' : ''}> Leave the background alone (the colour along the edges)</label>
        <div class="row gap"><button class="btn small" data-auto disabled>Match to my spools</button><button class="btn ghost small" data-reset disabled>Undo all swaps</button></div>
        <p class="muted tiny" data-joinhint hidden>To join groups: ⬚ one, Shift + ⬚ the others, then <b>Make a group</b>. ✎ renames.</p>
        <div class="areas" data-areas></div>
        <div class="cl-list" data-list></div>
        <div class="summary" data-sum></div>
      </section>
    </div>`;
  const $ = s => root.querySelector(s);
  $('[data-file]').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) /\.fspic$/i.test(f.name) ? openFile(f) : loadFile(f); };
  const drop = $('[data-drop]');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => {
    e.preventDefault(); drop.classList.remove('over');
    const fs = [...e.dataTransfer.files], p = fs.find(f => /\.fspic$/i.test(f.name)), f = fs.find(f => f.type.startsWith('image'));
    if (p) openFile(p); else if (f) loadFile(f);
  };
  $('[data-store]').onclick = saveNamed;
  $('[data-saved]').onclick = showSaved;
  $('[data-flatsel]').onchange = e => { topt.flat = e.target.checked; };
  let featherT;
  $('[data-feather]').oninput = e => {
    topt.feather = +e.target.value; $('[data-featherv]').textContent = topt.feather;
    clearTimeout(featherT); featherT = setTimeout(draw, 40);
  };
  document.addEventListener('paste', e => {
    if (!document.querySelector('#page-recolour.on')) return;
    const it = [...e.clipboardData.items].find(i => i.type.startsWith('image'));
    if (it) loadFile(it.getAsFile());
  });
  document.addEventListener('keydown', e => {
    if (!document.querySelector('#page-recolour.on') || e.target.matches?.('input, select, textarea')) return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if ((e.ctrlKey || e.metaKey) && key === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'Escape' && sel) { pushUndo(); sel = null; afterSel(); }
    if (e.key === ' ' && img) { e.preventDefault(); if (!spaceDown) { spaceDown = true; cursor(); } }
    if ((e.key === '+' || e.key === '=') && img) zoomBy(1.25);
    if (e.key === '-' && img) zoomBy(0.8);
    if (e.key === '0' && img) fit();
  });
  document.addEventListener('keyup', e => { if (e.key === ' ') { spaceDown = false; cursor(); } });
  window.addEventListener('resize', () => { if (img && document.querySelector('#page-recolour.on')) zv.fitted ? fit() : applyZoom(); });
  $('[data-k]').oninput = e => { $('[data-kv]').textContent = e.target.value; };
  $('[data-k]').onchange = e => { k = +e.target.value; if (img) analyse(); };
  $('[data-shade]').oninput = e => { shade = +e.target.value; $('[data-shv]').textContent = Math.round(shade * 100) + '%'; draw(); autosaveSoon(); };
  $('[data-bg]').onchange = e => { ignoreBg = e.target.checked; markBg(); refreshList(); draw(); autosaveSoon(); };
  // sliders preview straight away; the colour groups are found again when you let go
  let adjT, regroupT;
  root.querySelectorAll('[data-adj]').forEach(i => {
    i.oninput = () => {
      adj[i.dataset.adj] = +i.value; $(`[data-adjv="${i.dataset.adj}"]`).textContent = i.value;
      clearTimeout(adjT); adjT = setTimeout(() => img && reAdjust(false), 60);
    };
    i.onchange = () => { clearTimeout(regroupT); regroupT = setTimeout(() => img && reAdjust(true), 300); };
  });
  $('[data-adjreset]').onclick = () => {
    Object.assign(adj, { exposure: 0, contrast: 0, saturation: 0 }); thr.on = false;
    root.querySelectorAll('[data-adj]').forEach(i => { i.value = 0; $(`[data-adjv="${i.dataset.adj}"]`).textContent = 0; });
    $('[data-thr]').checked = false;
    img && reAdjust();
  };
  $('[data-adjust]').ontoggle = () => { draw(); drawHist(); };
  $('[data-thr]').onchange = e => { thr.on = e.target.checked; if (img) { makeThreshold(); draw(); autosaveSoon(); } drawHist(); };
  const setLevel = v => {
    thr.level = Math.round(v * 2) / 2; $('[data-thrl]').value = thr.level; $('[data-thrv]').textContent = thr.level;
    if (!thr.on) { thr.on = true; $('[data-thr]').checked = true; }
    if (img) { makeThreshold(); draw(); autosaveSoon(); }
    drawHist();
  };
  $('[data-thrl]').oninput = e => setLevel(+e.target.value);
  const hc = $('[data-hist]');
  const histAt = e => { const r = hc.getBoundingClientRect(); setLevel(Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100))); };
  hc.onpointerdown = e => { hc.setPointerCapture(e.pointerId); histAt(e); };
  hc.onpointermove = e => { if (e.buttons) histAt(e); };
  $('[data-view]').onclick = e => { const v = e.target.dataset.v; if (v) setView(v); };
  $('[data-tool]').onclick = e => { const t = e.target.closest('[data-t]')?.dataset.t; if (t) setTool(t); };
  $('[data-auto]').onclick = autoMatch;
  $('[data-reset]').onclick = () => { pushUndo(); clusters.forEach(c => c.target = null); areas.forEach(a => a.target = null); refreshList(); draw(); };
  $('[data-undo]').onclick = undo;
  $('[data-redo]').onclick = redo;
  root.querySelectorAll('[data-zoom]').forEach(b => b.onclick = () => zoomBy(+b.dataset.zoom > 0 ? 1.5 : 1 / 1.5));
  $('[data-zoomfit]').onclick = () => fit();
  $('[data-save]').onclick = savePicture;
  $('[data-colour]').onclick = colourSelection;
  $('[data-mkgroup]').onclick = () => makeGroup();
  $('[data-unarea]').onclick = () => { if (!sel) return; pushUndo(); for (let i = 0; i < sel.length; i++) if (sel[i] >= 128) areaOf[i] = 0; areaVer++; tidyAreas(); sel = null; afterSel(); };
  $('[data-invert]').onclick = () => { if (!sel) return; pushUndo(); for (let i = 0; i < sel.length; i++) sel[i] = 255 - sel[i]; afterSel(); };
  $('[data-none]').onclick = () => { if (!sel) return; pushUndo(); sel = null; afterSel(); };
  setupCanvas($('[data-canvas]'));
  setTool('pick');
  restoreCurrent();
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
    move: '',
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
    move: 'Drag to move around. Scroll the mouse wheel (or pinch) to zoom.',
  }[t] + (t === 'move' ? '' : ' Scroll to zoom; hold Space or the right mouse button and drag to move around.');
  cursor();
  draw();
}

function setView(v) {
  view = v;
  document.querySelectorAll('#page-recolour [data-view] button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  draw();
}

/* ---------- zoom & pan ---------- */
const box = () => document.querySelector('#page-recolour [data-drop]');
const canvasEl = () => document.querySelector('#page-recolour [data-canvas]');
function applyZoom() {
  if (!img) return;
  const b = box(), W = b.clientWidth, H = b.clientHeight, sw = img.w * zv.z, sh = img.h * zv.z;
  // keep the picture on screen: centred when it's smaller than the box, edges can't come past the middle otherwise
  zv.x = sw <= W ? (W - sw) / 2 : Math.min(W * 0.5, Math.max(W * 0.5 - sw, zv.x));
  zv.y = sh <= H ? (H - sh) / 2 : Math.min(H * 0.5, Math.max(H * 0.5 - sh, zv.y));
  const cv = canvasEl();
  cv.style.transform = `translate(${zv.x}px, ${zv.y}px) scale(${zv.z})`;
  cv.classList.toggle('pixels', zv.z >= 2);
  const v = document.querySelector('#page-recolour [data-zoomv]'); if (v) v.textContent = Math.round(zv.z * 100) + '%';
}
function fit() {
  if (!img) return;
  const b = box();
  // box as tall as the picture needs at this width (no big empty bands on a phone), up to 72% of the screen
  b.style.height = Math.round(Math.max(260, Math.min(innerHeight * 0.72, b.clientWidth * img.h / img.w))) + 'px';
  zv.z = Math.min(b.clientWidth / img.w, b.clientHeight / img.h, 1) || 1;
  zv.fitted = true; zv.x = 0; zv.y = 0;
  applyZoom();
}
// zoom keeping the point (cx, cy) in the box still (default: the middle)
function zoomBy(f, cx, cy) {
  if (!img) return;
  const b = box();
  if (cx === undefined) { cx = b.clientWidth / 2; cy = b.clientHeight / 2; }
  const fitZ = Math.min(b.clientWidth / img.w, b.clientHeight / img.h, 1);
  const z = Math.max(Math.min(fitZ, 0.1), Math.min(16, zv.z * f));
  zv.x = cx - (cx - zv.x) * z / zv.z; zv.y = cy - (cy - zv.y) * z / zv.z; zv.z = z;
  zv.fitted = false;
  applyZoom();
}
function cursor() {
  const cv = canvasEl(); if (!cv) return;
  cv.style.cursor = spaceDown || tool === 'move' ? 'grab' : tool === 'pick' ? 'pointer' : 'crosshair';
}

/* ---------- loading & adjusting ---------- */
async function loadFile(file) {
  await decodeImage(file);
  saved = { id: null, name: '' };
  showName();
  await reAdjust();
  autosaveSoon();
}

// read a picture into img (scaled to at most MAXW; or exactly w × h when reopening a saved one) and reset the page
async function decodeImage(file, W, H) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, MAXW / Math.max(bmp.width, bmp.height));
  const w = W || Math.round(bmp.width * s), h = H || Math.round(bmp.height * s);
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
  img = { w, h, lab0, lab: lab0, alpha, data, png: file.type === 'image/png' && !W && s === 1 && bmp.width === w ? file : null };
  sel = null; areaOf = new Uint8Array(w * h); areaAlpha = new Uint8Array(w * h).fill(255); areas = [];
  undoStack.length = 0; redoStack.length = 0; lastCopy = {}; areaVer++; labelsVer++;
  clusters = []; labels = null; hover = -1; hoverA = 0;
  const cv2 = canvasEl();
  cv2.width = w; cv2.height = h; cv2.style.width = w + 'px'; cv2.style.height = h + 'px'; cv2.hidden = false;
  document.querySelector('#page-recolour [data-drop] p').hidden = true;
  box().classList.add('has-pic');
  ['[data-auto]', '[data-reset]', '[data-save]', '[data-store]'].forEach(s => document.querySelector('#page-recolour ' + s).disabled = false);
  undoButtons();
  fit();
}

// Exposure / contrast / colour strength, applied to a copy used only for telling colours apart.
async function reAdjust(thenAnalyse = true) {
  const { exposure, contrast, saturation } = adj;
  if (!exposure && !contrast && !saturation) { img.lab = img.lab0; img.adjRGB = null; }
  else {
    const { data, w, h } = img, d = data.data;
    const lab = new Float32Array(w * h * 3), rgbOut = new Uint8ClampedArray(w * h * 4), cache = new Map();
    const ev = Math.pow(2, exposure), c = 1 + contrast / 100, sat = 1 + saturation / 100;
    const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const srgb = v => { v = Math.max(0, Math.min(1, v)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); };
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const key = (d[p] << 16) | (d[p + 1] << 8) | d[p + 2];
      let L = cache.get(key);
      if (!L) {
        // exposure in stops (on linear light, like a camera), then contrast around mid grey, then colour strength
        const rgb = [d[p], d[p + 1], d[p + 2]].map(v => { let x = srgb(lin(v) * ev) / 255; x = (x - 0.5) * c + 0.5; return Math.max(0, Math.min(255, x * 255)); });
        const l0 = rgbToLab(rgb[0], rgb[1], rgb[2]);
        const l1 = [l0[0], l0[1] * sat, l0[2] * sat];
        L = [...l1, ...labToRgb(...l1)];
        cache.set(key, L);
      }
      lab[i * 3] = L[0]; lab[i * 3 + 1] = L[1]; lab[i * 3 + 2] = L[2];
      rgbOut[p] = L[3]; rgbOut[p + 1] = L[4]; rgbOut[p + 2] = L[5]; rgbOut[p + 3] = d[p + 3];
    }
    img.lab = lab; img.adjRGB = rgbOut;
  }
  makeThreshold();
  drawHist();
  if (thenAnalyse) await analyse(); else draw();
}

// Threshold: a black-and-white copy (lighter than the level = white) that the wand and fill use while it's on.
function makeThreshold() {
  edges = null;
  if (!thr.on) { img.labT = null; return; }
  const { lab } = img, n = img.w * img.h, t = new Float32Array(n * 3), lv = thr.level;
  for (let i = 0; i < n; i++) t[i * 3] = lab[i * 3] >= lv ? 100 : 0;
  img.labT = t;
}
const toolLab = () => img.labT || img.lab;
const adjOpen = () => !!document.querySelector('#page-recolour [data-adjust]')?.open;

// lightness histogram of the adjusted picture, with the threshold level marked (like Photoshop's Threshold ramp)
function drawHist() {
  const hc = document.querySelector('#page-recolour [data-hist]'); if (!hc) return;
  const cx = hc.getContext('2d'), W = hc.width, H = hc.height;
  cx.clearRect(0, 0, W, H);
  // ramp under the bars: black to white
  const g = cx.createLinearGradient(0, 0, W, 0); g.addColorStop(0, '#000'); g.addColorStop(1, '#fff');
  cx.fillStyle = g; cx.fillRect(0, H - 6, W, 6);
  if (img) {
    const bins = new Float64Array(128), { lab } = img, n = img.w * img.h;
    for (let i = 0; i < n; i++) bins[Math.min(127, Math.max(0, Math.floor(lab[i * 3] / 100 * 128)))]++;
    const max = Math.max(...[...bins].sort((a, b) => b - a).slice(2, 3), 1); // ignore the two tallest spikes (flat backgrounds)
    cx.fillStyle = '#6b6680';
    for (let b = 0; b < 128; b++) { const bh = Math.min(1, bins[b] / max) * (H - 9); cx.fillRect(b * 2, H - 7 - bh, 2, bh); }
  }
  const x = thr.level / 100 * W;
  cx.fillStyle = thr.on ? '#d6336c' : 'rgba(214,51,108,.45)'; cx.fillRect(x - 1, 0, 2, H);
  cx.beginPath(); cx.moveTo(x - 5, H); cx.lineTo(x + 5, H); cx.lineTo(x, H - 8); cx.fill();
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
  let kept = 0;
  if (labels && clusters.length) {
    pushUndo(); // so finding the groups again can be undone
    kept = keepChosenGroups();
  }
  // find the groups among the pixels that aren't in one of your own groups
  const free = i => alpha[i] > 128 && !(areaOf && areaOf[i]);
  let nFree = 0; for (let i = 0; i < n; i++) if (free(i)) nFree++;
  const step = Math.max(1, Math.floor((nFree || n) / 60000));
  const pts = [];
  for (let i = 0, j = 0; i < n; i++) if (!nFree || free(i)) { if (j++ % step === 0) pts.push(i); }
  // shuffle so k-means++ starts somewhere random
  for (let i = pts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pts[i], pts[j]] = [pts[j], pts[i]]; }
  const P = new Float32Array(pts.length * 3);
  pts.forEach((p, j) => P.set(lab.subarray(p * 3, p * 3 + 3), j * 3));
  const kk = Math.max(1, Math.min(k, pts.length));
  const C = kmeans(P, pts.length, kk);
  labels = new Uint8Array(n); labelsVer++;
  for (let i = 0; i < n; i++) labels[i] = nearestC(C, kk, lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]);
  clusters = [...Array(kk)].map((_, c) => ({ lab: [C[c * 3], C[c * 3 + 1], C[c * 3 + 2]] }));
  finishClusters([]);
  busy(false);
  refreshList(); draw();
  if (kept) toast(`Kept ${kept} group${kept === 1 ? '' : 's'} you'd coloured or named (in “Your groups”)`);
  autosaveSoon();
}

// Before the colour groups are found again, any group you've coloured, named or made solid becomes one of
// "Your groups", so it stays exactly as it is.
function keepChosenGroups() {
  let kept = 0;
  clusters.forEach((c, ci) => {
    if (c.bg || !(c.target || c.name || c.flat) || areas.length >= 250) return;
    let cnt = 0;
    for (let i = 0; i < labels.length; i++) if (labels[i] === ci && !areaOf[i]) cnt++;
    if (!cnt) return;
    areas.push({ target: c.target || null, lab0: c.lab0, count: cnt, name: c.name, flat: c.flat });
    const id = areas.length;
    for (let i = 0; i < labels.length; i++) if (labels[i] === ci && !areaOf[i]) { areaOf[i] = id; areaAlpha[i] = 255; }
    kept++;
  });
  if (kept) areaVer++;
  return kept;
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
      if (prev && prev.d < 6 && prev.o.name) cl.name = prev.o.name;
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
  pushUndo();
  labelsVer++;
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
  let painting = false, mode = 1, last = null;
  let pan = null;                 // { x, y, zx, zy } while dragging the picture around
  const touches = new Map();      // pointerId -> [x, y] for pinch zoom
  let pinch = null;
  const b = box();
  const pos = e => { const r = cv.getBoundingClientRect(); return [Math.floor((e.clientX - r.left) / r.width * img.w), Math.floor((e.clientY - r.top) / r.height * img.h), img.w / r.width]; };
  const local = e => { const r = b.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  b.addEventListener('wheel', e => {
    if (!img) return;
    e.preventDefault();
    const [lx, ly] = local(e);
    zoomBy(Math.pow(1.0015, -e.deltaY * (e.deltaMode ? 30 : 1)), lx, ly);
  }, { passive: false });
  b.addEventListener('contextmenu', e => { if (img) e.preventDefault(); });
  b.addEventListener('pointerdown', e => {
    if (!img || !labels) return;
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, local(e));
      if (touches.size === 2) { // second finger: stop painting, start pinching
        if (painting) { painting = false; afterSel(); }
        pan = null;
        const [p1, p2] = [...touches.values()];
        pinch = { d: Math.hypot(p1[0] - p2[0], p1[1] - p2[1]), mx: (p1[0] + p2[0]) / 2, my: (p1[1] + p2[1]) / 2 };
        return;
      }
    }
    if (spaceDown || tool === 'move' || e.button === 1 || e.button === 2) {
      const [lx, ly] = local(e);
      pan = { x: lx, y: ly, zx: zv.x, zy: zv.y };
      b.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    if (e.button !== 0 || e.target !== cv) return;
    const [x, y, scale] = pos(e);
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
    mode = e.altKey ? 0 : 1;
    const add = e.shiftKey || e.altKey;
    const i0 = y * img.w + x;
    if (tool === 'pick') {
      if (areaOf[i0]) { const a = areaOf[i0]; hoverA = a; hover = -1; refreshList(); draw(); document.querySelector(`#page-recolour [data-ai="${a}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); chooseArea(a - 1); return; }
      hover = labels[i0]; hoverA = 0; refreshList(); draw(); document.querySelector(`#page-recolour [data-ci="${hover}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); choose(hover); return;
    }
    if (tool === 'wand' || tool === 'fill') {
      const region = tool === 'wand' ? wand(x, y) : fillInside(x, y);
      pushUndo();
      if (!sel || !add) sel = new Uint8Array(img.w * img.h);
      const m = softMask(region);
      for (let i = 0; i < m.length; i++) if (m[i]) sel[i] = mode ? Math.max(sel[i], m[i]) : Math.round(sel[i] * (255 - m[i]) / 255);
      afterSel();
      return;
    }
    if (tool === 'brush') {
      pushUndo();
      if (!sel) sel = new Uint8Array(img.w * img.h);
      painting = true; b.setPointerCapture(e.pointerId);
      last = [x, y];
      dab(x, y, topt.size * scale / 2, mode); afterSel(false);
    }
  });
  b.addEventListener('pointermove', e => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, local(e));
    if (pinch && touches.size === 2) {
      const [p1, p2] = [...touches.values()];
      const d = Math.hypot(p1[0] - p2[0], p1[1] - p2[1]), mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
      zv.x += mx - pinch.mx; zv.y += my - pinch.my;
      zoomBy(d / (pinch.d || 1), mx, my);
      pinch = { d, mx, my };
      return;
    }
    if (pan) {
      const [lx, ly] = local(e);
      zv.x = pan.zx + lx - pan.x; zv.y = pan.zy + ly - pan.y; zv.fitted = false;
      applyZoom();
      return;
    }
    if (!painting) return;
    const [x, y, scale] = pos(e), r = topt.size * scale / 2;
    // fill the gap between fast pointer samples
    const steps = Math.max(1, Math.ceil(Math.hypot(x - last[0], y - last[1]) / Math.max(1, r / 2)));
    for (let s = 1; s <= steps; s++) dab(last[0] + (x - last[0]) * s / steps, last[1] + (y - last[1]) * s / steps, r, mode);
    last = [x, y];
    afterSel(false);
  });
  const up = e => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    if (pan) { pan = null; cursor(); }
    if (painting) { painting = false; afterSel(); }
  };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
}

function dab(cx, cy, r, v) {
  const { w, h } = img, r2 = r * r;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) sel[y * w + x] = v ? 255 : 0;
}

function wand(x, y) {
  const { w, h } = img, lab = toolLab(), s = (y * w + x) * 3;
  const L = lab[s], A = lab[s + 1], B = lab[s + 2], t2 = topt.tol * topt.tol;
  const near = i => { const dl = lab[i * 3] - L, da = lab[i * 3 + 1] - A, db = lab[i * 3 + 2] - B; return dl * dl + da * da + db * db <= t2; };
  if (!topt.contiguous) { const out = []; for (let i = 0; i < w * h; i++) if (near(i)) out.push(i); return out; }
  return flood(x, y, near);
}

// Sobel edge strength on the adjusted lightness + colour, so outlines and colour borders both count.
function edgeMap() {
  if (edges) return edges;
  const { w, h } = img, lab = toolLab();
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

let selVer = 0, selDragging = false, softCache = { ver: -1, f: -1, m: null };
function afterSel(full = true) {
  const bar = document.querySelector('#page-recolour [data-selbar]');
  let n = 0; if (sel) for (let i = 0; i < sel.length; i++) n += sel[i];
  if (!n) sel = null;
  selVer++; selDragging = !full;
  bar.hidden = !sel;
  const f = n / 255 / (sel ? sel.length : 1);
  if (sel) bar.querySelector('[data-selinfo]').textContent = `${(f * 100).toFixed(f < 0.01 ? 2 : 1)}% of the picture selected`;
  draw();
}

// The selection as it will be used: the soft edge (Soft edge slider on the selection bar) blurred in.
// The tools keep `sel` itself hard, so the slider can be changed back and forth.
function selNow() {
  if (!sel || !topt.feather || selDragging) return sel;
  if (softCache.ver !== selVer || softCache.f !== topt.feather) softCache = { ver: selVer, f: topt.feather, m: blurMask(sel, topt.feather) };
  return softCache.m;
}

// mean original colour of the selection, weighted by how strongly each pixel is selected
function selMean() {
  const s = selNow(), { lab0 } = img; let L = 0, A = 0, B = 0, n = 0, wt = 0;
  for (let i = 0; i < s.length; i++) if (s[i]) { const q = s[i]; L += lab0[i * 3] * q; A += lab0[i * 3 + 1] * q; B += lab0[i * 3 + 2] * q; wt += q; n++; }
  return { mean: [L / wt, A / wt, B / wt], n };
}

function softMask(region) {
  const m = new Uint8Array(img.w * img.h);
  for (const i of region) m[i] = 255;
  return m;
}

// Blur a 0-255 mask (three box blurs ≈ a gaussian) so its edge fades over about `feather` pixels each side.
function blurMask(src, feather) {
  const { w, h } = img, n = w * h;
  const m = new Uint8Array(n);
  if (!feather) { m.set(src); return m; }
  const r = Math.max(1, Math.round(feather / 3));
  let a = Float32Array.from(src), b = new Float32Array(n);
  const pass = (src, dst, horiz) => {
    const len = horiz ? w : h, lines = horiz ? h : w, st = horiz ? 1 : w, ls = horiz ? w : 1, win = 2 * r + 1;
    for (let l = 0; l < lines; l++) {
      const o = l * ls;
      let acc = 0;
      for (let k2 = -r; k2 <= r; k2++) acc += src[o + Math.min(len - 1, Math.max(0, k2)) * st];
      for (let x = 0; x < len; x++) {
        dst[o + x * st] = acc / win;
        acc += src[o + Math.min(len - 1, x + r + 1) * st] - src[o + Math.max(0, x - r) * st];
      }
    }
  };
  for (let it = 0; it < 3; it++) { pass(a, b, true); pass(b, a, false); }
  for (let i = 0; i < n; i++) m[i] = a[i] < 1 ? 0 : Math.min(255, Math.round(a[i]));
  return m;
}

// Make the selected pixels into one group of their own. Joining groups keeps the colour and name of the biggest part.
function makeGroup(target) {
  if (!sel) return null;
  const { mean, n } = selMean();
  if (areas.length >= 250) { toast('That\'s the most groups you can make'); return null; }
  let name;
  if (target === undefined) {
    const tally = new Map(); // 'a<n>' / 'c<n>' -> pixels
    for (let i = 0; i < sel.length; i++) if (sel[i] >= 128) { const key = areaOf[i] ? 'a' + areaOf[i] : 'c' + labels[i]; tally.set(key, (tally.get(key) || 0) + 1); }
    const [top] = [...tally].sort((a, b) => b[1] - a[1]);
    const src = top && (top[0][0] === 'a' ? areas[+top[0].slice(1) - 1] : clusters[+top[0].slice(1)]);
    target = src && !src.bg ? src.target || null : null;
    name = src && top[0][0] === 'a' ? src.name : undefined;
  }
  pushUndo();
  areas.push({ target, lab0: mean, count: n, name, flat: topt.flat || undefined });
  const id = areas.length, soft = selNow();
  for (let i = 0; i < soft.length; i++) {
    const s = soft[i];
    if (!s || (s < 128 && areaOf[i])) continue; // faint soft edge: don't take pixels away from another of your groups
    areaOf[i] = id; areaAlpha[i] = s;
  }
  areaVer++;
  sel = null;
  tidyAreas();
  afterSel();
  if (target) setView('after');
}

async function colourSelection() {
  if (!sel) return;
  const { mean } = selMean();
  const f = await pickFilament({ title: 'Colour the selection with…', near: rgbToHex(...labToRgb(...mean)) });
  if (!f) return;
  makeGroup(f);
}

// drop areas nothing points at any more, renumber the rest
function tidyAreas() {
  const counts = new Float64Array(areas.length + 1);
  for (let i = 0; i < areaOf.length; i++) counts[areaOf[i]]++;
  const map = new Uint8Array(areas.length + 1); const keep = [];
  areas.forEach((a, j) => { if (counts[j + 1] > 0 && keep.length < 250) { keep.push({ ...a, count: counts[j + 1] }); map[j + 1] = keep.length; } });
  let moved = false;
  for (let i = 0; i < areaOf.length; i++) { const m = map[areaOf[i]]; if (m !== areaOf[i]) { areaOf[i] = m; moved = true; } }
  if (moved) areaVer++;
  areas = keep;
  refreshList();
}

/* ---------- undo / redo (selections, groups and colours) ---------- */
// The big per-pixel arrays are only copied when they've changed since the last copy.
function snapshot() {
  if (lastCopy.areaVer !== areaVer) lastCopy = { ...lastCopy, areaVer, areaOf: areaOf.slice(), areaAlpha: areaAlpha.slice() };
  if (lastCopy.labelsVer !== labelsVer) lastCopy = { ...lastCopy, labelsVer, labels: labels.slice() };
  return {
    areaOf: lastCopy.areaOf, areaAlpha: lastCopy.areaAlpha, areaVer, labels: lastCopy.labels, labelsVer, k,
    areas: areas.map(a => ({ ...a })), clusters: clusters.map(c => ({ ...c })), sel: sel && sel.slice(),
  };
}
function restore(s) {
  areaOf = s.areaOf.slice(); areaAlpha = s.areaAlpha.slice(); labels = s.labels.slice();
  areaVer = s.areaVer; labelsVer = s.labelsVer;
  lastCopy = { areaVer, areaOf: s.areaOf, areaAlpha: s.areaAlpha, labelsVer, labels: s.labels };
  areas = s.areas.map(a => ({ ...a })); clusters = s.clusters.map(c => ({ ...c })); sel = s.sel && s.sel.slice();
  if (s.k !== k) {
    k = s.k;
    const kin = document.querySelector('#page-recolour [data-k]');
    if (kin) { kin.value = Math.min(24, k); document.querySelector('#page-recolour [data-kv]').textContent = k; }
  }
  hover = -1; hoverA = 0;
  afterSel(false); refreshList(); draw();
  autosaveSoon();
}
function pushUndo() {
  if (!img || !labels) return;
  undoStack.push(snapshot());
  if (undoStack.length > 40) undoStack.shift();
  redoStack.length = 0;
  undoButtons();
  autosaveSoon();
}
function undo() {
  const u = undoStack.pop(); if (!u) return;
  redoStack.push(snapshot());
  restore(u); undoButtons();
}
function redo() {
  const r = redoStack.pop(); if (!r) return;
  undoStack.push(snapshot());
  restore(r); undoButtons();
}
function undoButtons() {
  const u = document.querySelector('#page-recolour [data-undo]'), r = document.querySelector('#page-recolour [data-redo]');
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}

// rename a group in place
function renameRow(row, obj, fallback) {
  const b = row.querySelector('[data-name]');
  const inp = el('input', { class: 'rename', value: obj.name || '', placeholder: fallback, maxlength: 40 });
  b.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = ok => {
    if (done) return; done = true;
    const v = inp.value.trim();
    if (ok && v !== (obj.name || '')) { pushUndo(); obj.name = v || undefined; }
    refreshList();
  };
  inp.onkeydown = e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };
  inp.onblur = () => finish(true);
}

// select a group's pixels; Shift adds to what's already selected
function selectWhere(test, add, val = () => 255) {
  pushUndo();
  if (!sel || !add) sel = new Uint8Array(labels.length);
  for (let p = 0; p < labels.length; p++) if (test(p)) sel[p] = Math.max(sel[p], val(p));
  afterSel();
}

/* ---------- list ---------- */
function refreshList() {
  const list = document.querySelector('#page-recolour [data-list]');
  if (!list) return;
  const total = labels ? labels.length : 1;
  const pct = n => `${(n / total * 100).toFixed(n / total < 0.01 ? 2 : n / total < 0.1 ? 1 : 0)}%`;
  const hatch = 'repeating-linear-gradient(45deg,#ddd 0 4px,#fff 4px 8px)';
  const tline = t => t ? ` · ${esc(t.type)}${t.owned ? '' : ' · ♡ wish list'}` : '';
  const nameBtn = '<button class="icon-btn" data-ren title="Rename">✎</button>';
  const flatBtn = o => `<button class="icon-btn flat${o.flat ? ' on' : ''}" data-flat title="${o.flat ? 'One solid colour. Click to keep the picture\'s shading instead' : 'Keeps the picture\'s shading. Click for one solid colour'}">${o.flat ? '■' : '◐'}</button>`;
  // pixels still following each colour group (not taken into one of your own groups)
  const live = new Float64Array(clusters.length);
  if (labels) for (let p = 0; p < labels.length; p++) if (!areaOf[p]) live[labels[p]]++;
  const ab = document.querySelector('#page-recolour [data-areas]');
  ab.innerHTML = areas.length ? '<h3 class="tiny-h">Your groups</h3>' : '';
  areas.forEach((a, j) => {
    const r = el('div', { class: 'cl own' + (hoverA === j + 1 ? ' sel' : ''), 'data-ai': j + 1 });
    const t = a.target, auto = t ? t.name : `Group ${j + 1}`;
    r.innerHTML = `<span class="sw big" style="background:${rgbToHex(...labToRgb(...a.lab0))}"></span><span class="arrow">→</span><span class="sw big" style="background:${t ? swatchCss(t.hex) : hatch}"></span>
      <div class="grow"><b data-name>${esc(a.name || auto)}</b>
      <small class="muted">${pct(a.count)}${a.name && t ? ` · ${esc(t.name)}` : ''}${t ? tline(t) : ' · not changed'}</small></div>
      <span class="acts">${nameBtn}${t ? flatBtn(a) : ''}<button class="btn small ghost" data-pick>${t ? 'Change' : 'Choose'}</button>
      <button class="icon-btn" data-sel title="Select this group (Shift adds it to the selection)">⬚</button><button class="icon-btn" data-del title="Remove (its pixels go back to their colour groups)">✕</button></span>`;
    r.querySelector('[data-ren]').onclick = () => renameRow(r, a, auto);
    r.querySelector('[data-name]').ondblclick = () => renameRow(r, a, auto);
    r.querySelector('[data-pick]').onclick = () => chooseArea(j);
    r.querySelector('[data-flat]')?.addEventListener('click', () => { pushUndo(); a.flat = !a.flat || undefined; refreshList(); draw(); });
    r.querySelector('[data-sel]').onclick = e => selectWhere(p => areaOf[p] === j + 1, e.shiftKey, p => areaAlpha[p] >= 128 ? 255 : 0);
    r.querySelector('[data-del]').onclick = () => { pushUndo(); for (let i = 0; i < areaOf.length; i++) if (areaOf[i] === j + 1) areaOf[i] = 0; areaVer++; tidyAreas(); draw(); };
    r.onmouseenter = () => { hoverA = j + 1; draw(); };
    r.onmouseleave = () => { hoverA = 0; draw(); };
    ab.append(r);
  });
  list.innerHTML = '';
  document.querySelector('#page-recolour [data-joinhint]').hidden = !clusters.length;
  if (!clusters.length) { list.innerHTML = '<p class="muted">Open a picture to see its colours.</p>'; summary(); return; }
  if (areas.length) list.append(el('h3', { class: 'tiny-h' }, 'Colour groups'));
  clusters.forEach((c, i) => {
    if (areas.length && !live[i]) return; // everything in it has gone into your own groups
    const r = el('div', { class: 'cl' + (i === hover ? ' sel' : '') + (c.bg ? ' bg' : ''), 'data-ci': i });
    const t = c.target;
    const near = !t && !c.bg ? store.nearest(c.hex, 'owned', 1)[0] : null;
    const auto = c.bg ? 'Background' : t ? t.name : 'Not changed';
    r.innerHTML = `<span class="sw big" style="background:${c.hex}" title="Colour in the picture"></span><span class="arrow">→</span>
      <span class="sw big" style="background:${t ? swatchCss(t.hex) : hatch}"></span>
      <div class="grow"><b data-name>${esc(c.name || auto)}</b>
      <small class="muted">${pct(live[i])} of picture${c.name ? ` · ${esc(auto)}` : ''}${t ? tline(t) : near ? ` · closest you have: ${esc(near.f.name)} (${matchWords(near.d)})` : ''}</small></div>
      <span class="acts">${nameBtn}${t && !c.bg ? flatBtn(c) : ''}${c.bg ? '<button class="link" data-unbg>change it</button>' : `<button class="btn small ghost" data-pick>Choose</button>`}
      <button class="icon-btn" data-split title="Split this group in two (when two colours got lumped together)">⫽</button>
      <button class="icon-btn" data-gsel title="Select this group (Shift adds it to the selection, to join groups)">⬚</button>
      ${t ? '<button class="icon-btn" data-clear title="Put the original colour back">↺</button>' : ''}</span>`;
    r.querySelector('[data-ren]').onclick = () => renameRow(r, c, auto);
    r.querySelector('[data-name]').ondblclick = () => renameRow(r, c, auto);
    r.querySelector('[data-flat]')?.addEventListener('click', () => { pushUndo(); c.flat = !c.flat || undefined; refreshList(); draw(); });
    r.querySelector('[data-pick]')?.addEventListener('click', () => choose(i));
    r.querySelector('[data-clear]')?.addEventListener('click', () => { pushUndo(); c.target = null; refreshList(); draw(); });
    r.querySelector('[data-unbg]')?.addEventListener('click', () => { c.bg = false; refreshList(); draw(); });
    r.querySelector('[data-split]').addEventListener('click', () => splitGroup(i));
    r.querySelector('[data-gsel]').addEventListener('click', e => selectWhere(p => labels[p] === i && !areaOf[p], e.shiftKey));
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
  if (f) setView('after');
  refreshList(); draw();
}

async function chooseArea(j) {
  const a = areas[j];
  const f = await pickFilament({ title: `Colour ${a.name ? '“' + a.name + '”' : 'this group'} with…`, near: rgbToHex(...labToRgb(...a.lab0)), allowNone: true, noneLabel: 'Keep the original colour' });
  if (f === undefined) return;
  pushUndo();
  a.target = f;
  if (f) setView('after');
  refreshList(); draw();
}

function autoMatch() {
  if (!store.state().spools.some(s => s.owned)) return toast('Add the spools you have on the Filaments page first');
  pushUndo();
  for (const c of clusters) if (!c.bg) c.target = store.nearest(c.hex, 'owned', 1)[0]?.f || null;
  for (const a of areas) if (!a.target) a.target = store.nearest(rgbToHex(...labToRgb(...a.lab0)), 'owned', 1)[0]?.f || null;
  setView('after');
  refreshList(); draw();
}

function summary() {
  const sum = document.querySelector('#page-recolour [data-sum]');
  const used = [...new Map([...clusters.filter(c => c.target && !c.bg).map(c => c.target), ...areas.filter(a => a.target).map(a => a.target)].map(t => [t.id, t])).values()];
  const S = store.state();
  setDesignNeeds('picture', []);
  if (!used.length) { sum.innerHTML = ''; return; }
  const missing = used.filter(f => !f.owned);
  sum.innerHTML = `<b>${used.length} filament${used.length === 1 ? '' : 's'}</b>${used.length > S.amsSlots ? ` <span class="warn">more than your ${S.amsSlots} AMS slots</span>` : ''}
    <div class="row gap wrap">${used.map(f => `<span class="mini"><span class="sw" style="background:${swatchCss(f.hex)}"></span>${esc(f.name)}${f.owned ? '' : ' ♡'}</span>`).join('')}</div>
    ${missing.length ? `<p class="tiny">${missing.length} you don't have yet: they're on your <a href="#shop">shopping list</a>.</p>` : '<p class="tiny">You have all of these.</p>'}`;
}

/* ---------- drawing ---------- */
function draw(forSave = false) {
  if (!img || !labels) return;
  const cv = document.querySelector('#page-recolour [data-canvas]');
  const cx = cv.getContext('2d');
  const { w, h, lab0, data } = img;
  const out = new ImageData(w, h);
  const o = out.data, src = data.data;
  const ctl = clusters.map(c => c.target && !c.bg ? hexToLab(c.target.hex[0]) : null);
  const atl = areas.map(a => a.target ? hexToLab(a.target.hex[0]) : null);
  const mk = clusters.map(c => [...labToRgb(...c.lab0)]);
  const mka = areas.map(a => [...labToRgb(...a.lab0)]);
  // while "Adjust" is open, show the picture the way the tools see it
  const preview = !forSave && adjOpen() && (thr.on || img.adjRGB);
  const labT = preview && thr.on ? img.labT : null, aRGB = preview ? img.adjRGB : null;
  const showEdges = tool === 'fill' && topt.outlines;
  const S = selNow();
  const E = showEdges ? edgeMap() : null;
  const cache = new Map();
  const sL = 0.35 + shade * 0.65, sC = shade * 0.5;
  // new colour of pixel i in group g (cluster c, or your group ar), keeping the picture's shading unless it's solid
  const recol = (i, ar, c, r0, g0, b0) => {
    const T = ar ? atl[ar - 1] : ctl[c];
    if (!T) return null;
    const key = (ar ? (256 + ar) : c) * 16777216 + ((r0 << 16) | (g0 << 8) | b0);
    let v = cache.get(key);
    if (!v) {
      const G = ar ? areas[ar - 1] : clusters[c], C = G.lab0;
      v = G.flat ? labToRgb(...T)
        : labToRgb(Math.max(0, Math.min(100, T[0] + (lab0[i * 3] - C[0]) * sL)), T[1] + (lab0[i * 3 + 1] - C[1]) * sC, T[2] + (lab0[i * 3 + 2] - C[2]) * sC);
      cache.set(key, v);
    }
    return v;
  };
  for (let i = 0; i < w * h; i++) {
    const p = i * 4, c = labels[i], ar = areaOf ? areaOf[i] : 0;
    const al = ar ? areaAlpha[i] / 255 : 1; // soft edge: part your group's colour, part what's underneath
    let r = src[p], g = src[p + 1], b = src[p + 2];
    if (preview) { // what the tools see: threshold black/white, or the adjusted picture
      if (labT) r = g = b = labT[i * 3] ? 255 : 0;
      else if (aRGB) { r = aRGB[p]; g = aRGB[p + 1]; b = aRGB[p + 2]; }
    } else if (view === 'mask') {
      [r, g, b] = ar ? mka[ar - 1] : mk[c];
      if (al < 1) { const u = mk[c]; r = r * al + u[0] * (1 - al); g = g * al + u[1] * (1 - al); b = b * al + u[2] * (1 - al); }
    } else if (view === 'after') {
      const r0 = r, g0 = g, b0 = b;
      const v = recol(i, ar, c, r0, g0, b0);
      if (v) [r, g, b] = v;
      if (al < 1) {
        const u = recol(i, 0, c, r0, g0, b0) || [r0, g0, b0];
        r = r * al + u[0] * (1 - al); g = g * al + u[1] * (1 - al); b = b * al + u[2] * (1 - al);
      }
    }
    if ((hoverA && ar !== hoverA) || (!hoverA && hover >= 0 && (c !== hover || ar))) { r = r * 0.35 + 38; g = g * 0.35 + 38; b = b * 0.35 + 38; }
    if (E && E[i] >= topt.edge) { r = 255; g = 40; b = 120; }
    if (sel) {
      // blue tint + checker so it reads on any colour (fading out over a soft edge); the rest dimmed
      const q = S[i] / 255, ch = ((i % w) >> 2 ^ (Math.floor(i / w) >> 2)) & 1;
      const d = 0.75 + 0.25 * q, t = 0.5 * q;
      r = r * d * (1 - t) + (ch ? 40 : 70) * t; g = g * d * (1 - t) + (ch ? 140 : 170) * t; b = b * d * (1 - t) + 255 * t;
    }
    o[p] = r; o[p + 1] = g; o[p + 2] = b; o[p + 3] = src[p + 3];
  }
  cx.putImageData(out, 0, 0);
}

/* ---------- saving your work (kept in this browser; or as a .fspic file) ---------- */
function db() {
  return new Promise((res, rej) => { const r = indexedDB.open('filament-studio', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function dbGet(key) {
  const d = await db();
  return new Promise(r => { const q = d.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => r(q.result); q.onerror = () => r(undefined); });
}
async function dbPut(key, val) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); val === undefined ? t.objectStore('kv').delete(key) : t.objectStore('kv').put(val, key); t.oncomplete = res; t.onerror = () => rej(t.error); });
}
const listKey = 'recolour:list';

function showName() {
  const n = document.querySelector('#page-recolour [data-picname]');
  if (n) n.textContent = saved.id ? `· ${saved.name} (changes save by themselves)` : img ? '· not saved yet' : '';
}

async function pngOf() {
  if (!img.png) { const c = new OffscreenCanvas(img.w, img.h); c.getContext('2d').putImageData(img.data, 0, 0); img.png = await c.convertToBlob({ type: 'image/png' }); }
  return img.png;
}
// small picture of the result for the Saved list
function thumbnail() {
  const was = [hover, hoverA, sel, view];
  hover = -1; hoverA = 0; sel = null; view = 'after'; draw(true);
  const s = Math.min(1, 220 / Math.max(img.w, img.h)), t = el('canvas', { width: Math.round(img.w * s), height: Math.round(img.h * s) });
  t.getContext('2d').drawImage(canvasEl(), 0, 0, t.width, t.height);
  [hover, hoverA, sel, view] = was; draw();
  return t.toDataURL('image/jpeg', 0.8);
}
async function stateNow(withThumb) {
  return {
    v: 1, id: saved.id, name: saved.name, date: Date.now(), w: img.w, h: img.h, png: await pngOf(),
    labels, areaOf, areaAlpha, k, adj: { ...adj }, thr: { ...thr }, shade, ignoreBg,
    clusters: clusters.map(c => ({ ...c })), areas: areas.map(a => ({ ...a })),
    thumb: withThumb ? thumbnail() : undefined,
  };
}
async function writeSaved(st) {
  await dbPut('recolour:' + st.id, st);
  const list = (await dbGet(listKey)) || [];
  const entry = { id: st.id, name: st.name, date: st.date, thumb: st.thumb || list.find(e => e.id === st.id)?.thumb };
  await dbPut(listKey, [entry, ...list.filter(e => e.id !== st.id)]);
}

let autoT;
function autosaveSoon() {
  clearTimeout(autoT);
  autoT = setTimeout(async () => {
    if (!img || !labels) return;
    try {
      const st = await stateNow(!!saved.id);
      await dbPut('recolour:current', st);
      if (saved.id) await writeSaved(st);
    } catch (e) { console.warn('autosave', e); }
  }, 1200);
}

async function saveNamed() {
  if (!img || !labels) return;
  if (!saved.id) {
    const name = await askName('Save this picture as', 'My picture ' + new Date().toLocaleDateString());
    if (!name) return;
    saved = { id: store.uid(), name };
  }
  busy('Saving…'); await nextFrame();
  try { const st = await stateNow(true); await writeSaved(st); await dbPut('recolour:current', st); toast(`Saved “${saved.name}”`); }
  catch (e) { toast('Couldn\'t save: ' + e.message); }
  busy(false); showName();
}

async function restoreState(st) {
  busy('Opening…'); await nextFrame();
  await decodeImage(st.png, st.w, st.h);
  img.png = st.png;
  Object.assign(adj, st.adj || {}); Object.assign(thr, st.thr || { on: false }); shade = st.shade ?? shade; ignoreBg = st.ignoreBg ?? ignoreBg; k = st.k || k;
  const R = document.getElementById('page-recolour');
  R.querySelectorAll('[data-adj]').forEach(i => { i.value = adj[i.dataset.adj]; R.querySelector(`[data-adjv="${i.dataset.adj}"]`).textContent = adj[i.dataset.adj]; });
  R.querySelector('[data-shade]').value = shade; R.querySelector('[data-shv]').textContent = Math.round(shade * 100) + '%';
  R.querySelector('[data-thr]').checked = thr.on; R.querySelector('[data-thrl]').value = thr.level; R.querySelector('[data-thrv]').textContent = thr.level;
  R.querySelector('[data-bg]').checked = ignoreBg;
  R.querySelector('[data-k]').value = Math.min(24, k); R.querySelector('[data-kv]').textContent = k;
  await reAdjust(false);
  // filaments may have changed since (bought one, renamed it): use the library's copy where there is one
  const fresh = t => t && (store.spoolById(t.id) || t);
  labels = new Uint8Array(st.labels); areaOf = new Uint8Array(st.areaOf); areaAlpha = new Uint8Array(st.areaAlpha);
  clusters = st.clusters.map(c => ({ ...c, target: fresh(c.target) }));
  areas = st.areas.map(a => ({ ...a, target: fresh(a.target) }));
  labelsVer++; areaVer++; lastCopy = {};
  saved = { id: st.id || null, name: st.name || '' };
  busy(false);
  showName(); refreshList(); draw();
}

async function openSaved(id) {
  const st = await dbGet('recolour:' + id);
  if (!st) return toast('That one isn\'t here any more');
  await restoreState(st);
  autosaveSoon();
}

// back where you were after a reload
async function restoreCurrent() {
  try { const st = await dbGet('recolour:current'); if (st && !img) await restoreState(st); } catch (e) { console.warn(e); busy(false); }
}

async function fileBytes() {
  const st = await stateNow(false);
  const meta = { ...st, png: undefined, labels: undefined, areaOf: undefined, areaAlpha: undefined, thumb: undefined, app: 'Filament Studio' };
  return zipSync({
    'picture.json': strToU8(JSON.stringify(meta)), 'picture.png': new Uint8Array(await st.png.arrayBuffer()),
    'labels.bin': labels, 'groups.bin': areaOf, 'soft.bin': areaAlpha,
  });
}
async function openFile(file) {
  try {
    const z = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const meta = JSON.parse(strFromU8(z['picture.json']));
    await restoreState({ ...meta, png: new Blob([z['picture.png']], { type: 'image/png' }), labels: z['labels.bin'], areaOf: z['groups.bin'], areaAlpha: z['soft.bin'], id: null, name: '' });
    saved = { id: null, name: '' }; showName();
    toast('Opened. Press 💾 Save to keep it in this browser.');
    autosaveSoon();
  } catch (e) { busy(false); toast('That file couldn\'t be opened'); console.warn(e); }
}

function askName(title, value = '') {
  return new Promise(resolve => {
    const back = el('div', { class: 'modal-back' }), m = el('div', { class: 'modal small-modal' });
    m.innerHTML = `<div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-x>✕</button></div>
      <div class="modal-body"><input class="input" data-n maxlength="60" value="${esc(value)}"></div>
      <div class="modal-foot"><button class="btn ghost" data-x>Cancel</button> <button class="btn" data-ok>Save</button></div>`;
    back.append(m); document.body.append(back);
    const inp = m.querySelector('[data-n]'); inp.focus(); inp.select();
    const done = v => { back.remove(); resolve(v); };
    m.querySelectorAll('[data-x]').forEach(b => b.onclick = () => done(null));
    m.querySelector('[data-ok]').onclick = () => done(inp.value.trim() || null);
    inp.onkeydown = e => { if (e.key === 'Enter') done(inp.value.trim() || null); if (e.key === 'Escape') done(null); };
  });
}

async function showSaved() {
  const back = el('div', { class: 'modal-back' }), m = el('div', { class: 'modal' });
  back.append(m); document.body.append(back);
  const close = () => back.remove();
  back.addEventListener('pointerdown', e => { if (e.target === back) close(); });
  const render = async () => {
    const list = (await dbGet(listKey)) || [];
    m.innerHTML = `<div class="modal-head"><h3>Saved pictures</h3><button class="icon-btn" data-x>✕</button></div>
      <div class="modal-body">${list.length ? '' : '<p class="muted">Nothing saved yet. Open a picture, colour it, then press 💾 Save. After that, your changes save by themselves.</p>'}
        <div class="saved-list"></div></div>
      <div class="modal-foot row gap wrap"><span class="muted tiny grow" style="text-align:left">Kept in this browser. Save to a file to move one to another computer or keep a backup.</span>
        ${img && labels ? '<button class="btn ghost small" data-copy>Save as a copy…</button><button class="btn ghost small" data-tofile>⬇ Save to a file</button>' : ''}
        <label class="btn ghost small">Open a file<input type="file" accept=".fspic" hidden data-fromfile></label></div>`;
    m.querySelector('[data-x]').onclick = close;
    const sl = m.querySelector('.saved-list');
    for (const e of list) {
      const r = el('div', { class: 'saved-row' + (e.id === saved.id ? ' on' : '') });
      r.innerHTML = `${e.thumb ? `<img src="${e.thumb}" alt="">` : '<span class="ph"></span>'}
        <div class="grow"><b>${esc(e.name)}</b><small class="muted">${new Date(e.date).toLocaleString()}${e.id === saved.id ? ' · open now' : ''}</small></div>
        <button class="btn small" data-open>Open</button><button class="icon-btn" data-ren title="Rename">✎</button><button class="icon-btn" data-del title="Delete">🗑</button>`;
      r.querySelector('[data-open]').onclick = async () => { close(); await openSaved(e.id); };
      r.querySelector('[data-ren]').onclick = async () => {
        const n = await askName('Rename', e.name); if (!n) return;
        const st = await dbGet('recolour:' + e.id); if (st) { st.name = n; await dbPut('recolour:' + e.id, st); }
        await dbPut(listKey, list.map(x => x.id === e.id ? { ...x, name: n } : x));
        if (saved.id === e.id) { saved.name = n; showName(); autosaveSoon(); }
        render();
      };
      r.querySelector('[data-del]').onclick = async () => {
        if (!confirm(`Delete “${e.name}”? This can't be undone.`)) return;
        await dbPut('recolour:' + e.id, undefined);
        await dbPut(listKey, list.filter(x => x.id !== e.id));
        if (saved.id === e.id) { saved = { id: null, name: '' }; showName(); }
        render();
      };
      sl.append(r);
    }
    m.querySelector('[data-copy]')?.addEventListener('click', async () => {
      const n = await askName('Save a copy as', (saved.name || 'My picture') + ' copy'); if (!n) return;
      saved = { id: store.uid(), name: n };
      await saveNamed(); render();
    });
    m.querySelector('[data-tofile]')?.addEventListener('click', async () => {
      const bytes = await fileBytes();
      download(`${(saved.name || 'picture').replace(/[^\w\- ]+/g, '').trim() || 'picture'}.fspic`, bytes);
    });
    m.querySelector('[data-fromfile]').onchange = e => { const f = e.target.files[0]; if (f) { close(); openFile(f); } };
  };
  render();
}

function savePicture() {
  const was = [hover, hoverA, sel, view, tool];
  hover = -1; hoverA = 0; sel = null; view = 'after'; tool = 'pick'; draw(true);
  document.querySelector('#page-recolour [data-canvas]').toBlob(b => {
    const a = el('a', { href: URL.createObjectURL(b), download: 'recoloured.png' }); a.click();
    [hover, hoverA, sel, view, tool] = was; draw();
  });
}
