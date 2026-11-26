// 3D page: open STL / 3MF, paint faces, parts and layers in your filaments, cut it open, export a 3MF for Bambu Studio / Orca.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from '../vendor/three-mesh-bvh.module.js';
import * as store from './store.js';
import { parseSTL, parse3MF, build3MF, BED, newPartId } from './mesh-io.js';
import { floodFill, subdivide, normals, estimate } from './mesh.js';
import { pickFilament } from './picker.js';
import { swatchCss, hexToLab, deltaE, inkFor } from './colour.js';
import { el, esc, money, toast, download, busy, nextFrame } from './ui.js';
import { setDesignNeeds } from './library.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const MAX_BANDS = 16;
let project = null;            // { name, objects:[{name, parts}], slots:[{spoolId,hex,type,name}], layers:[{z,slot}] }
let renderer, scene, camera, controls, bedGroup, modelGroup, brushRing, layerGuide;
let tool = 'brush', slotSel = 1, erasing = false;
const opts = { radius: 3, angle: 30, noBacks: true, xray: false, caps: true, cutAxis: 'off', cutPos: 0.5, cutFlip: false, layerH: 0.2, wall: 0.84, infill: 15, waste: 0.35, together: true };
const undoStack = [], redoStack = [];
const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
const bandUniforms = { uBandZ: { value: new Float32Array(MAX_BANDS) }, uBandCol: { value: Array.from({ length: MAX_BANDS }, () => new THREE.Color()) }, uBandN: { value: 0 } };
let needsRender = true;
window.__studio = () => ({ project, opts, camera, controls, tool, slotSel, hitAt, applyTool, stroke });   // for checking things from the console
let stroke = null;

/* ================= page ================= */
export function renderStudio() {
  const root = document.getElementById('page-studio');
  if (root.dataset.ready) { resize(); refreshSide(); return; }
  root.dataset.ready = 1;
  root.innerHTML = `
  <div class="studio">
    <div class="toolbar" data-tools>
      ${[['view', '✋', 'Look', 'Look around (V): left-drag turns the model'], ['brush', '🖌️', 'Brush', 'Brush (B): paint faces'], ['face', '🔺', 'Triangle', 'One triangle at a time'], ['fill', '🪣', 'Fill', 'Fill a smooth area (F)'], ['same', '🎯', 'Patch', 'Recolour a whole patch of one colour'], ['part', '🧩', 'Part', 'Colour a whole part (P)'], ['layer', '📏', 'Height', 'Change colour from a height up (L)']]
      .map(([k, i, l, t]) => `<button class="tool ${k === tool ? 'on' : ''}" data-tool="${k}" title="${t}"><span>${i}</span><small>${l}</small></button>`).join('')}
      <hr><button class="tool ${erasing ? 'on' : ''}" data-erase title="Rub out paint (E)"><span>🧽</span><small>Rub out</small></button>
      <button class="tool" data-undo title="Undo (Ctrl+Z)"><span>↶</span><small>Undo</small></button>
      <button class="tool" data-redo title="Redo (Ctrl+Y)"><span>↷</span><small>Redo</small></button>
    </div>
    <div class="viewport-wrap">
      <div class="optbar" data-optbar></div>
      <div class="viewport" data-vp>
        <div class="vp-empty" data-empty>
          <h2>Open a model to paint</h2>
          <p>Drop <b>.stl</b> or <b>.3mf</b> files here. A 3MF from Bambu Studio or MakerWorld keeps its paint, parts and filaments.</p>
          <div class="row gap center"><label class="btn">Open files<input type="file" accept=".stl,.3mf" multiple hidden data-open></label><button class="btn ghost" data-sample>Try a sample cup</button></div>
          <label class="check tiny"><input type="checkbox" data-together ${opts.together ? 'checked' : ''}> Several STL files at once are parts of one model (keeps them lined up)</label>
        </div>
        <div class="vp-hint" data-hint></div>
      </div>
    </div>
    <aside class="side" data-side></aside>
  </div>`;
  initThree(root.querySelector('[data-vp]'));
  root.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
  root.querySelector('[data-erase]').onclick = () => { erasing = !erasing; syncTools(); };
  root.querySelector('[data-undo]').onclick = undo;
  root.querySelector('[data-redo]').onclick = redo;
  root.querySelector('[data-open]').onchange = e => openFiles([...e.target.files]);
  root.querySelector('[data-sample]').onclick = loadSample;
  root.querySelector('[data-together]').onchange = e => opts.together = e.target.checked;
  const vp = root.querySelector('[data-vp]');
  vp.addEventListener('dragover', e => { e.preventDefault(); vp.classList.add('over'); });
  vp.addEventListener('dragleave', () => vp.classList.remove('over'));
  vp.addEventListener('drop', e => { e.preventDefault(); vp.classList.remove('over'); openFiles([...e.dataTransfer.files]); });
  document.addEventListener('keydown', onKey);
  renderOptbar();
  refreshSide();
  restore();
}

function onKey(e) {
  if (!document.querySelector('#page-studio.on') || e.target.matches?.('input, select, textarea')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  const k = e.key.toLowerCase();
  if (k === 'b') setTool('brush'); else if (k === 'f') setTool('fill'); else if (k === 'p') setTool('part'); else if (k === 'l') setTool('layer'); else if (k === 'v') setTool('view');
  else if (k === 'e') { erasing = !erasing; syncTools(); }
  else if (k === '[') { opts.radius = Math.max(0.5, opts.radius / 1.25); renderOptbar(); }
  else if (k === ']') { opts.radius = Math.min(60, opts.radius * 1.25); renderOptbar(); }
  else if (/^[1-9]$/.test(k) && project && +k <= project.slots.length) { slotSel = +k; erasing = false; syncTools(); refreshSide(); }
}

function setTool(t) { tool = t; syncTools(); renderOptbar(); }
function syncTools() {
  document.querySelectorAll('#page-studio [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === tool));
  document.querySelector('#page-studio [data-erase]').classList.toggle('on', erasing);
  controls.mouseButtons = tool === 'view' ? { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN } : { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = tool === 'view' ? { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN } : { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
  const hint = {
    view: 'Left-drag turns · right-drag moves · scroll zooms',
    brush: 'Left-drag paints · right-drag turns the model · scroll zooms · [ and ] change the size',
    face: 'Click triangles to paint them one by one',
    fill: 'Click a face: it fills outward until the surface bends more than the angle',
    same: 'Click a colour patch: the whole connected patch changes',
    part: 'Click a part to make the whole part this filament',
    layer: 'Click the model at a height: from there up it prints in this filament',
  }[tool];
  document.querySelector('#page-studio [data-hint]').textContent = (erasing && tool !== 'part' && tool !== 'layer' ? 'Rubbing out · ' : '') + hint;
  if (brushRing) brushRing.visible = false;
  needsRender = true;
}

function renderOptbar() {
  const bar = document.querySelector('#page-studio [data-optbar]');
  const parts = [];
  if (tool === 'brush') parts.push(`<label>Brush size <input type="range" min="0.5" max="40" step="0.5" value="${opts.radius}" data-o="radius"> <b>${opts.radius.toFixed(1)} mm</b></label>`);
  if (tool === 'fill') parts.push(`<label>Stop where it bends more than <input type="range" min="1" max="90" value="${opts.angle}" data-o="angle"> <b>${opts.angle}°</b></label>`);
  if (tool === 'brush') parts.push(`<label class="check"><input type="checkbox" data-o="noBacks" ${opts.noBacks ? 'checked' : ''}> Don't paint through to the far side</label>`);
  if (tool === 'layer') parts.push(`<label>Layer height <input type="number" min="0.04" max="0.4" step="0.04" value="${opts.layerH}" data-o="layerH" style="width:5em"> mm</label>`);
  bar.innerHTML = parts.join('') + `<span class="grow"></span>
    <label class="check"><input type="checkbox" data-o="xray" ${opts.xray ? 'checked' : ''}> See-through</label>
    <span class="cut">Cut open <select data-o="cutAxis"><option value="off">off</option><option value="z" ${opts.cutAxis === 'z' ? 'selected' : ''}>from the top</option><option value="x" ${opts.cutAxis === 'x' ? 'selected' : ''}>side to side</option><option value="y" ${opts.cutAxis === 'y' ? 'selected' : ''}>front to back</option></select>
    ${opts.cutAxis !== 'off' ? `<input type="range" min="0" max="1" step="0.002" value="${opts.cutPos}" data-o="cutPos"><button class="icon-btn" data-flip title="Look at the other half">⇅</button><label class="check"><input type="checkbox" data-o="caps" ${opts.caps ? 'checked' : ''}> Fill the cut</label>` : ''}</span>`;
  bar.querySelectorAll('[data-o]').forEach(i => {
    const k = i.dataset.o;
    const ev = i.type === 'range' ? 'input' : 'change';
    i.addEventListener(ev, () => {
      opts[k] = i.type === 'checkbox' ? i.checked : i.tagName === 'SELECT' ? i.value : +i.value;
      if (k === 'radius' || k === 'angle') i.nextElementSibling.textContent = k === 'radius' ? opts.radius.toFixed(1) + ' mm' : opts.angle + '°';
      if (k === 'cutAxis') renderOptbar();
      if (k === 'xray') applyXray();
      if (['cutAxis', 'cutPos', 'caps'].includes(k)) updateClip();
    });
  });
  bar.querySelector('[data-flip]')?.addEventListener('click', () => { opts.cutFlip = !opts.cutFlip; updateClip(); });
}

/* ================= three.js ================= */
function initThree(vp) {
  renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.localClippingEnabled = true;
  renderer.setClearColor(0xeef0f6);
  vp.prepend(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 0.5, 5000);
  camera.up.set(0, 0, 1);
  camera.position.set(BED.x / 2 + 160, BED.y / 2 - 260, 220);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(BED.x / 2, BED.y / 2, 20);
  controls.enableDamping = true;
  controls.addEventListener('change', () => needsRender = true);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8aa0, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(0.4, -0.6, 1);
  camera.add(key); camera.add(key.target); key.target.position.set(0, 0, -1);
  scene.add(camera);

  bedGroup = new THREE.Group();
  const bed = new THREE.Mesh(new THREE.PlaneGeometry(BED.x, BED.y), new THREE.MeshStandardMaterial({ color: 0x2b2e38, roughness: 0.9 }));
  bed.position.set(BED.x / 2, BED.y / 2, -0.05);
  bedGroup.add(bed);
  const grid = new THREE.GridHelper(BED.x, 16, 0x5b6070, 0x3f4350);
  grid.rotation.x = Math.PI / 2; grid.position.set(BED.x / 2, BED.y / 2, 0);
  bedGroup.add(grid);
  scene.add(bedGroup);
  modelGroup = new THREE.Group();
  scene.add(modelGroup);

  brushRing = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  brushRing.renderOrder = 999; brushRing.visible = false;
  scene.add(brushRing);
  layerGuide = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }));
  layerGuide.visible = false;
  scene.add(layerGuide);

  new ResizeObserver(resize).observe(vp);
  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  dom.addEventListener('pointerleave', () => { brushRing.visible = false; layerGuide.visible = false; needsRender = true; });
  dom.addEventListener('contextmenu', e => e.preventDefault());
  syncTools();
  const loop = () => { requestAnimationFrame(loop); controls.update(); if (needsRender) { needsRender = false; renderer.render(scene, camera); } };
  loop();
}

function resize() {
  const vp = document.querySelector('#page-studio [data-vp]');
  if (!vp || !renderer) return;
  const w = vp.clientWidth, h = vp.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  needsRender = true;
}

// One material for all parts: vertex colours, layer bands by height, darker inside faces.
function makeMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.02, side: THREE.DoubleSide, clippingPlanes: [] });
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, bandUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float painted;\nvarying float vPainted;\nvarying float vWZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPainted = painted;\nvWZ = (modelMatrix * vec4(transformed, 1.0)).z;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uBandZ[${MAX_BANDS}];\nuniform vec3 uBandCol[${MAX_BANDS}];\nuniform int uBandN;\nvarying float vPainted;\nvarying float vWZ;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (vPainted < 0.5) { for (int i = 0; i < ${MAX_BANDS}; i++) { if (i >= uBandN) break; if (vWZ >= uBandZ[i]) diffuseColor.rgb = uBandCol[i]; } }
        if (!gl_FrontFacing) diffuseColor.rgb *= 0.55;`);
  };
  return m;
}

function makeCapMaterial(part) {
  return new THREE.ShaderMaterial({
    uniforms: { ...bandUniforms, uBase: { value: new THREE.Color(slotHex(part.slot)) } },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform float uBandZ[${MAX_BANDS}]; uniform vec3 uBandCol[${MAX_BANDS}]; uniform int uBandN; uniform vec3 uBase; varying vec3 vW;
      void main(){ vec3 c = uBase; for (int i = 0; i < ${MAX_BANDS}; i++) { if (i >= uBandN) break; if (vW.z >= uBandZ[i]) c = uBandCol[i]; }
        float hatch = step(0.5, fract((vW.x + vW.y + vW.z) * 0.35)); gl_FragColor = vec4(c * (0.78 + 0.1 * hatch), 1.0); }`,
    side: THREE.DoubleSide, stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
  });
}

const sharedMat = { mat: null };
function partMaterial() { return sharedMat.mat || (sharedMat.mat = makeMaterial()); }

function slotHex(s) { return project?.slots[s - 1]?.hex || '#B8BCC8'; }

function buildPartMesh(part) {
  const P = part.positions, I = part.index, n = I.length / 3;
  const pos = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) { const v = I[t * 3 + k] * 3; pos.set([P[v], P[v + 1], P[v + 2]], t * 9 + k * 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 9), 3));
  g.setAttribute('painted', new THREE.BufferAttribute(new Float32Array(n * 3), 1));
  g.computeVertexNormals();
  g.computeBoundsTree();
  const mesh = new THREE.Mesh(g, partMaterial());
  mesh.userData.part = part;
  part._mesh = mesh;
  // stencil meshes + cap for the cut view
  const mk = (side, op) => new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side, depthWrite: false, depthTest: false, colorWrite: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op, clippingPlanes: [clipPlane] }));
  part._stB = mk(THREE.BackSide, THREE.IncrementWrapStencilOp);
  part._stF = mk(THREE.FrontSide, THREE.DecrementWrapStencilOp);
  part._cap = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), makeCapMaterial(part));
  part._cap.onAfterRender = r => r.clearStencil();
  part._stB.raycast = part._stF.raycast = part._cap.raycast = () => {};
  recolourPart(part);
  return mesh;
}

function recolourPart(part, tris = null) {
  const g = part._mesh.geometry;
  const col = g.attributes.color.array, pa = g.attributes.painted.array;
  const cache = {};
  const rgb = s => cache[s] || (cache[s] = new THREE.Color(slotHex(s)).convertSRGBToLinear());
  const base = rgb(part.slot);
  const paint = t => {
    const s = part.tri[t];
    const c = s ? rgb(s) : base;
    for (let k = 0; k < 3; k++) { col[t * 9 + k * 3] = c.r; col[t * 9 + k * 3 + 1] = c.g; col[t * 9 + k * 3 + 2] = c.b; pa[t * 3 + k] = s ? 1 : 0; }
  };
  if (tris) tris.forEach(paint); else for (let t = 0; t < part.tri.length; t++) paint(t);
  g.attributes.color.needsUpdate = true;
  g.attributes.painted.needsUpdate = true;
  part._cap.material.uniforms.uBase.value.set(slotHex(part.slot));
  needsRender = true;
}

function allParts() { return project ? project.objects.flatMap(o => o.parts) : []; }

function rebuildScene() {
  modelGroup.clear();
  for (const p of allParts()) {
    if (p._mesh) { p._mesh.geometry.disposeBoundsTree(); p._mesh.geometry.dispose(); }
    modelGroup.add(buildPartMesh(p));
    modelGroup.add(p._stB, p._stF, p._cap);
  }
  document.querySelector('#page-studio [data-empty]').hidden = !!project;
  updateBands(); updateClip(); applyXray();
  needsRender = true;
}

function bounds() {
  const b = new THREE.Box3();
  for (const p of allParts()) if (p._mesh && !p.hidden) { p._mesh.geometry.computeBoundingBox(); b.union(p._mesh.geometry.boundingBox); }
  return b;
}

function frame() {
  const b = bounds(); if (b.isEmpty()) return;
  const c = b.getCenter(new THREE.Vector3()), r = b.getSize(new THREE.Vector3()).length() / 2;
  controls.target.copy(c);
  const dist = r / Math.sin(camera.fov * Math.PI / 360) * 1.1;
  camera.position.copy(c).add(new THREE.Vector3(0.55, -0.75, 0.55).normalize().multiplyScalar(dist));
  camera.near = Math.max(0.1, dist / 200); camera.far = dist * 20; camera.updateProjectionMatrix();
  needsRender = true;
}

function updateBands() {
  const ls = project ? [...project.layers].sort((a, b) => a.z - b.z).slice(0, MAX_BANDS) : [];
  bandUniforms.uBandN.value = ls.length;
  ls.forEach((l, i) => { bandUniforms.uBandZ.value[i] = l.z; bandUniforms.uBandCol.value[i].set(slotHex(l.slot)).convertSRGBToLinear(); });
  for (const p of allParts()) if (p._cap) p._cap.material.uniformsNeedUpdate = true;
  needsRender = true;
}

function updateClip() {
  const on = opts.cutAxis !== 'off' && project;
  const mat = partMaterial();
  mat.clippingPlanes = on ? [clipPlane] : [];
  mat.needsUpdate = true;
  if (on) {
    const b = bounds();
    const ax = { x: 0, y: 1, z: 2 }[opts.cutAxis];
    const lo = b.min.getComponent(ax) - 0.01, hi = b.max.getComponent(ax) + 0.01;
    const at = lo + (hi - lo) * opts.cutPos;
    // keep the far half for side cuts (so you look into it) and the bottom for a cut from the top
    const keepUp = (ax === 2 ? false : true) !== opts.cutFlip;
    const n = new THREE.Vector3(); n.setComponent(ax, keepUp ? 1 : -1);
    clipPlane.normal.copy(n); clipPlane.constant = keepUp ? -at : at;
    const size = b.getSize(new THREE.Vector3()).length() * 2 + 10;
    const c = b.getCenter(new THREE.Vector3()); c.setComponent(ax, at);
    for (const p of allParts()) {
      p._cap.scale.set(size, size, 1);
      p._cap.position.copy(c);
      p._cap.lookAt(c.clone().add(n));
    }
  }
  allParts().forEach((p, i) => {
    const vis = on && opts.caps && !p.hidden;
    p._stB.visible = p._stF.visible = p._cap.visible = vis;
    p._stB.renderOrder = p._stF.renderOrder = 10 + i * 2;
    p._cap.renderOrder = 11 + i * 2;
    p._mesh.visible = !p.hidden;
  });
  needsRender = true;
}

function applyXray() {
  const m = partMaterial();
  m.transparent = opts.xray; m.opacity = opts.xray ? 0.35 : 1; m.depthWrite = !opts.xray; m.needsUpdate = true;
  needsRender = true;
}

/* ================= picking & painting ================= */
const ray = new THREE.Raycaster();
ray.firstHitOnly = false;
function hitAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  const v = new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
  ray.setFromCamera(v, camera);
  const meshes = allParts().filter(p => !p.hidden).map(p => p._mesh);
  const hits = ray.intersectObjects(meshes, false);
  const cut = opts.cutAxis !== 'off';
  return hits.find(h => !cut || clipPlane.distanceToPoint(h.point) >= -1e-6) || null;
}

function onDown(e) {
  if (!project || e.button !== 0 || tool === 'view') return;
  const h = hitAt(e);
  if (!h) return;
  e.preventDefault();
  renderer.domElement.setPointerCapture(e.pointerId);
  stroke = { changes: new Map() };
  applyTool(h, true);
}
function onMove(e) {
  if (!project) return;
  if (tool === 'view') return;
  const h = hitAt(e);
  showCursor(h);
  if (stroke && (tool === 'brush' || tool === 'face') && h) applyTool(h, false);
}
function onUp() {
  if (!stroke) return;
  const ch = stroke.changes; stroke = null;
  if (!ch.size) return;
  const parts = [...ch.keys()];
  const before = new Map(parts.map(p => [p, ch.get(p)]));
  const after = new Map(parts.map(p => [p, new Map([...ch.get(p).keys()].map(t => [t, p.tri[t]]))]));
  pushUndo({ undo: () => applyStates(before), redo: () => applyStates(after) });
  changed();
}
function applyStates(map) {
  for (const [p, m] of map) { for (const [t, s] of m) { p.tri[t] = s; markDirty(p, t); } recolourPart(p, [...m.keys()]); }
}
function markDirty(p, t) { if (p.orig) { (p.dirty || (p.dirty = new Uint8Array(p.tri.length)))[t] = 1; } }

function showCursor(h) {
  brushRing.visible = false; layerGuide.visible = false;
  if (h && tool === 'brush') {
    brushRing.position.copy(h.point);
    brushRing.scale.setScalar(opts.radius);
    const n = h.face.normal.clone();
    brushRing.lookAt(h.point.clone().add(n));
    brushRing.material.color.set(erasing ? '#ffffff' : slotHex(slotSel));
    brushRing.visible = true;
  }
  if (h && tool === 'layer') {
    const b = bounds(), s = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const z = snapZ(h.point.z);
    layerGuide.scale.set(s.x * 1.3 + 4, s.y * 1.3 + 4, 1);
    layerGuide.position.set(c.x, c.y, z);
    layerGuide.material.color.set(slotHex(slotSel));
    layerGuide.visible = true;
    document.querySelector('#page-studio [data-hint]').textContent = `From ${z.toFixed(2)} mm up → filament ${slotSel}. Click to add.`;
  }
  needsRender = true;
}
const snapZ = z => Math.max(opts.layerH, Math.round(z / opts.layerH) * opts.layerH);

function setTri(part, t, s) {
  if (part.tri[t] === s) return false;
  let m = stroke.changes.get(part);
  if (!m) { m = new Map(); stroke.changes.set(part, m); }
  if (!m.has(t)) m.set(t, part.tri[t]);
  part.tri[t] = s;
  markDirty(part, t);
  return true;
}

const tmpSphere = new THREE.Sphere(), tmpV = new THREE.Vector3();
// The picking tree reorders triangles; vertices stay in groups of three, so the first corner tells the real triangle.
const realTri = (part, i) => Math.floor(part._mesh.geometry.index.array[i * 3] / 3);
function applyTool(h, first) {
  const part = h.object.userData.part;
  const value = erasing ? 0 : slotSel;
  if (tool === 'part') {
    if (!first) return;
    const old = part.slot, nw = slotSel;
    if (old === nw) return;
    const go = s => { part.slot = s; recolourPart(part); refreshSide(); };
    go(nw);
    pushUndo({ undo: () => go(old), redo: () => go(nw) });
    stroke = null; changed();
    return;
  }
  if (tool === 'layer') {
    if (!first) return;
    const z = snapZ(h.point.z);
    const old = project.layers.map(l => ({ ...l }));
    project.layers = project.layers.filter(l => Math.abs(l.z - z) > 1e-6);
    project.layers.push({ z, slot: slotSel });
    const nw = project.layers.map(l => ({ ...l }));
    const go = ls => { project.layers = ls.map(l => ({ ...l })); updateBands(); refreshSide(); };
    go(nw);
    pushUndo({ undo: () => go(old), redo: () => go(nw) });
    stroke = null; changed();
    return;
  }
  const touched = [];
  const N = normals(part);
  const hn = h.face.normal;
  const facing = t => !opts.noBacks || (N[t * 3] * hn.x + N[t * 3 + 1] * hn.y + N[t * 3 + 2] * hn.z) > 0.05;
  if (tool === 'face') {
    const t0 = realTri(part, h.faceIndex); if (setTri(part, t0, value)) touched.push(t0);
  } else if (tool === 'brush') {
    const cut = opts.cutAxis !== 'off';
    // dab along the line from the last point so quick strokes don't leave gaps
    const centres = [h.point.clone()];
    if (stroke.last && stroke.lastPart === part) {
      const d = stroke.last.distanceTo(h.point), step = Math.max(0.2, opts.radius * 0.5);
      for (let k = 1; k < Math.min(200, d / step); k++) centres.push(stroke.last.clone().lerp(h.point, k * step / d));
    }
    stroke.last = h.point.clone(); stroke.lastPart = part;
    for (const centre of centres) {
    tmpSphere.set(centre, opts.radius);
    part._mesh.geometry.boundsTree.shapecast({
      intersectsBounds: box => tmpSphere.intersectsBox(box),
      intersectsTriangle: (tri, i) => {
        tri.closestPointToPoint(tmpSphere.center, tmpV);
        if (tmpV.distanceTo(tmpSphere.center) > opts.radius) return false;
        if (cut && clipPlane.distanceToPoint(tri.a) < 0 && clipPlane.distanceToPoint(tri.b) < 0 && clipPlane.distanceToPoint(tri.c) < 0) return false;
        const t = realTri(part, i); if (facing(t) && setTri(part, t, value)) touched.push(t);
        return false;
      },
    });
    }
  } else if (tool === 'fill' || tool === 'same') {
    const list = floodFill(part, realTri(part, h.faceIndex), { maxAngle: opts.angle, sameColour: tool === 'same' });
    for (const t of list) if (setTri(part, t, value)) touched.push(t);
    if (list.length > 1) toast(`${list.length.toLocaleString()} triangles`, 1200);
  }
  if (touched.length) recolourPart(part, touched);
  if (!first && tool !== 'brush' && tool !== 'face') return;
  if (tool === 'fill' || tool === 'same') onUp();
}

/* ================= undo ================= */
function pushUndo(a) { undoStack.push(a); if (undoStack.length > 60) undoStack.shift(); redoStack.length = 0; }
function undo() { const a = undoStack.pop(); if (!a) return toast('Nothing to undo'); a.undo(); redoStack.push(a); changed(); }
function redo() { const a = redoStack.pop(); if (!a) return; a.redo(); undoStack.push(a); changed(); }

/* ================= loading ================= */
async function openFiles(files) {
  files = files.filter(f => /\.(stl|3mf)$/i.test(f.name));
  if (!files.length) return toast('Choose .stl or .3mf files');
  if (project && allParts().length && !confirm('Replace the model that is open now? (Export it first if you want to keep your painting.)')) return;
  busy(`Opening ${files.length === 1 ? files[0].name : files.length + ' files'}…`); await nextFrame();
  try {
    const loaded = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      loaded.push(/\.3mf$/i.test(f.name) ? parse3MF(buf, f.name) : parseSTL(buf, f.name));
    }
    let p;
    if (loaded.length === 1) p = loaded[0];
    else {
      const stls = loaded.filter(l => !l.slots && !l.fromSlicer);
      p = { name: loaded[0].name, objects: [], slots: loaded.find(l => l.slots)?.slots || null, layers: loaded.flatMap(l => l.layers) };
      if (opts.together && stls.length > 1) p.objects.push({ name: stls[0].name, parts: stls.flatMap(l => l.objects.flatMap(o => o.parts)) });
      for (const l of loaded) if (!(opts.together && stls.length > 1 && stls.includes(l))) p.objects.push(...l.objects);
    }
    const skipped = loaded.reduce((a, l) => a + (l.skipped || 0), 0);
    if (skipped) toast(`Left out ${skipped} slicer helper shape${skipped > 1 ? 's' : ''} (modifiers / support blockers). They aren't printed.`, 5000);
    await setProject(p, { place: files.some(f => /\.stl$/i.test(f.name)) || !loaded.some(l => l.fromSlicer) });
  } catch (err) {
    console.error(err);
    toast('Could not open that file: ' + err.message, 5000);
  }
  busy(false);
}

async function setProject(p, { place = true } = {}) {
  // filaments: from the file, matched to your spools where the colour and type agree
  const S = store.state();
  if (p.slots && p.slots.length) {
    p.slots = p.slots.map((s, i) => {
      // same material only (PLA for PLA, PETG for PETG…); an exact type match counts for more
      const cands = S.spools.filter(sp => store.baseType(sp.type) === store.baseType(s.type))
        .map(sp => ({ sp, d: deltaE(hexToLab(s.hex), hexToLab(sp.hex[0])) + (sp.type === s.type ? 0 : 2) + (sp.owned ? 0 : 1) })).sort((a, b) => a.d - b.d);
      const m = cands[0] && cands[0].d < 5 ? cands[0].sp : null;
      if (m) return fromSpool(m);
      // not one of yours: name it after the closest Bambu colour, so it can go on the wish list
      const cat = store.catalog().filter(c => store.baseType(c.type) === store.baseType(s.type)).map(c => ({ c, d: deltaE(hexToLab(s.hex), hexToLab(c.hex[0])) + (c.type === s.type ? 0 : 3) })).sort((a, b) => a.d - b.d)[0];
      if (cat && cat.d < 4) return { spoolId: null, hex: s.hex, type: cat.c.type, name: cat.c.name, cat: cat.c };
      return { spoolId: null, hex: s.hex, type: s.type || 'PLA Basic', name: `Filament ${i + 1} from file` };
    });
  } else {
    const owned = S.spools.filter(s => s.owned);
    const parts = p.objects.flatMap(o => o.parts);
    const used = Math.max(...parts.map(x => x.slot), ...parts.map(x => x.tri.reduce((a, v) => Math.max(a, v), 0)));
    const want = Math.max(1, used, Math.min(S.amsSlots, owned.length));
    p.slots = [];
    for (let i = 0; i < want; i++) p.slots.push(owned[i] ? fromSpool(owned[i]) : { spoolId: null, hex: ['#F2F0EB', '#3C3C46', '#E86A92', '#4FA3E0'][i], type: 'PLA Basic', name: `Filament ${i + 1}` });
  }
  if (place) placeOnBed(p);
  project = p;
  slotSel = Math.min(slotSel, p.slots.length) || 1;
  undoStack.length = redoStack.length = 0;
  rebuildScene();
  frame();
  refreshSide();
  changed(false);
}

const fromSpool = sp => ({ spoolId: sp.id, hex: sp.hex[0], type: sp.type, name: sp.name });

function placeOnBed(p) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const o of p.objects) for (const part of o.parts) for (let i = 0; i < part.positions.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], part.positions[i + k]); mx[k] = Math.max(mx[k], part.positions[i + k]); }
  const inside = mn[0] >= 0 && mn[1] >= 0 && mx[0] <= BED.x && mx[1] <= BED.y && Math.abs(mn[2]) < 0.01;
  if (inside) return;
  const d = [BED.x / 2 - (mn[0] + mx[0]) / 2, BED.y / 2 - (mn[1] + mx[1]) / 2, -mn[2]];
  for (const o of p.objects) for (const part of o.parts) for (let i = 0; i < part.positions.length; i += 3) { part.positions[i] += d[0]; part.positions[i + 1] += d[1]; part.positions[i + 2] += d[2]; }
}

function loadSample() {
  // A cup: outer wall, inner wall, flat bottom. Painted inside to show the cut view.
  const pts = [];
  const R = 32, r = 28, H = 70, base = 4;
  pts.push(new THREE.Vector2(0.001, 0));
  for (let z = 0; z <= H; z += 1) pts.push(new THREE.Vector2(R + Math.sin(z / H * Math.PI) * 3, z));
  pts.push(new THREE.Vector2(R - 1, H + 0.6), new THREE.Vector2(r + 1, H + 0.6));
  for (let z = H; z >= base; z -= 1) pts.push(new THREE.Vector2(r + Math.sin(z / H * Math.PI) * 3 - (z < base + 2 ? (base + 2 - z) * 0.8 : 0), z));
  pts.push(new THREE.Vector2(0.001, base));
  const g = new THREE.LatheGeometry(pts, 96);
  g.rotateX(Math.PI / 2);
  const flat = g.toNonIndexed().attributes.position.array;
  const stlLike = new ArrayBuffer(84 + flat.length / 9 * 50);
  const dv = new DataView(stlLike); dv.setUint32(80, flat.length / 9, true);
  for (let t = 0; t < flat.length / 9; t++) for (let k = 0; k < 9; k++) dv.setFloat32(84 + t * 50 + 12 + k * 4, flat[t * 9 + k], true);
  const p = parseSTL(stlLike, 'Sample cup.stl');
  // fix winding so normals face out (lathe from this profile faces in)
  const part = p.objects[0].parts[0];
  for (let t = 0; t < part.index.length; t += 3) { const a = part.index[t + 1]; part.index[t + 1] = part.index[t + 2]; part.index[t + 2] = a; }
  if (project && allParts().length && !confirm('Replace the model that is open now?')) return;
  setProject(p);
}

/* ================= side panel ================= */
function refreshSide() {
  const side = document.querySelector('#page-studio [data-side]');
  if (!side) return;
  if (!project) { side.innerHTML = '<div class="card"><h3>Filaments in this print</h3><p class="muted tiny">Open a model first.</p></div>'; return; }
  const S = store.state();
  const overAms = project.slots.length > S.amsSlots;
  side.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Filaments in this print</h3><button class="btn ghost small" data-addslot title="Add another filament">+ Add</button></div>
      <div class="slots" data-slots></div>
      ${overAms ? `<p class="warn tiny">That's more than your ${S.amsSlots} AMS slots. It can still print, but you'd swap spools by hand.</p>` : ''}
      <p class="muted tiny">Click a number (or press 1–${Math.min(9, project.slots.length)}) to paint with it. Click the colour to change which filament it is.</p>
    </div>
    <div class="card">
      <div class="card-head"><h3>Parts</h3><span class="muted tiny">${allParts().length}</span></div>
      <div class="parts" data-parts></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Colour by height</h3>${project.layers.length ? '<button class="link" data-clearlayers>remove all</button>' : ''}</div>
      <div data-layers></div>
      <div class="row gap"><input type="number" step="${opts.layerH}" min="0" placeholder="height mm" data-lz style="width:7em"><button class="btn ghost small" data-addlayer>Add change at this height</button></div>
      <p class="muted tiny">Or use the 📏 tool and click the model. Painted faces keep their paint above the change.</p>
    </div>
    <div class="card">
      <div class="card-head"><h3>Filament and cost</h3><button class="link" data-est>work it out</button></div>
      <div data-estimate class="tiny muted">Press "work it out" for a rough guess at grams and cost.</div>
      <details class="tiny"><summary>Guess settings</summary>
        <label>Walls (mm) <input type="number" step="0.1" min="0.4" value="${opts.wall}" data-eo="wall" style="width:5em"></label>
        <label>Infill % <input type="number" step="5" min="0" max="100" value="${opts.infill}" data-eo="infill" style="width:5em"></label>
        <label>Waste per filament swap (g) <input type="number" step="0.05" min="0" value="${opts.waste}" data-eo="waste" style="width:5em"></label>
      </details>
    </div>
    <div class="card">
      <div class="row gap"><button class="btn grow" data-export="bambu">⬇ Save for Bambu Studio</button><button class="btn ghost" data-export="orca">⬇ For Orca</button></div>
      <p class="muted tiny">Open it with <b>File → Open project</b>. Paint, parts, colour changes and the filaments (with Bambu's A1 settings for each) come with it. Check the colours in the slicer's preview before printing.</p>
      <div class="row gap"><label class="btn ghost small">Open other files<input type="file" accept=".stl,.3mf" multiple hidden data-open2></label><button class="btn ghost small" data-shot>Save a picture</button></div>
    </div>`;

  const slots = side.querySelector('[data-slots]');
  project.slots.forEach((s, i) => {
    const n = i + 1;
    const sp = s.spoolId ? store.spoolById(s.spoolId) : null;
    const r = el('div', { class: 'slot' + (n === slotSel && !erasing ? ' sel' : '') });
    r.innerHTML = `<button class="slot-n" style="background:${s.hex};color:${inkFor(s.hex)}" title="Paint with filament ${n}">${n}</button>
      <button class="slot-name grow" title="Change this filament"><b>${esc(s.name)}</b><small>${esc(s.type)}${sp ? (sp.owned ? ' · have' : ' · ♡ wish list') : ' · not in your list'}</small></button>
      ${!sp ? '<button class="btn ghost small" data-want title="Add to your wish list">♡ Want</button>' : ''}${project.slots.length > 1 ? '<button class="icon-btn" data-del title="Remove this filament">✕</button>' : ''}`;
    r.querySelector('.slot-n').onclick = () => { slotSel = n; erasing = false; syncTools(); refreshSide(); };
    r.querySelector('.slot-name').onclick = async () => {
      const f = await pickFilament({ title: `Filament ${n} is…`, near: s.hex });
      if (!f) return;
      project.slots[i] = fromSpool(f);
      allParts().forEach(p => recolourPart(p)); updateBands(); refreshSide(); changed();
    };
    r.querySelector('[data-del]')?.addEventListener('click', () => removeSlot(n));
    r.querySelector('[data-want]')?.addEventListener('click', () => {
      const sp2 = store.addSpool(s.cat || { type: s.type, name: s.name, hex: [s.hex], custom: true }, false);
      project.slots[i] = fromSpool(sp2); refreshSide(); changed(); toast(`${sp2.name} is on your wish list`);
    });
    slots.append(r);
  });
  side.querySelector('[data-addslot]').onclick = async () => {
    const f = await pickFilament({ title: `Filament ${project.slots.length + 1} is…` });
    if (!f) return;
    project.slots.push(fromSpool(f)); slotSel = project.slots.length; erasing = false; syncTools(); refreshSide(); changed();
  };

  const partsBox = side.querySelector('[data-parts]');
  project.objects.forEach(o => {
    if (project.objects.length > 1 || o.parts.length > 1) partsBox.append(el('div', { class: 'obj-name' }, o.name));
    o.parts.forEach(p => {
      const r = el('div', { class: 'part' });
      r.innerHTML = `<button class="icon-btn" data-eye title="Hide / show">${p.hidden ? '🙈' : '👁'}</button>
        <span class="grow"><b>${esc(p.name)}</b><small class="muted">${(p.index.length / 3).toLocaleString()} triangles</small></span>
        <select data-ps title="Filament for the whole part">${project.slots.map((s, i) => `<option value="${i + 1}" ${p.slot === i + 1 ? 'selected' : ''}>${i + 1} · ${esc(s.name)}</option>`).join('')}</select>
        <button class="icon-btn" data-fine title="Make finer for detailed painting">✂</button>`;
      r.querySelector('[data-eye]').onclick = () => { p.hidden = !p.hidden; updateClip(); refreshSide(); };
      r.querySelector('[data-ps]').onchange = e => { const old = p.slot, nw = +e.target.value; const go = s => { p.slot = s; recolourPart(p); refreshSide(); }; go(nw); pushUndo({ undo: () => go(old), redo: () => go(nw) }); changed(); };
      r.querySelector('[data-fine]').onclick = () => makeFiner(p);
      partsBox.append(r);
    });
  });

  const lb = side.querySelector('[data-layers]');
  const ls = [...project.layers].sort((a, b) => a.z - b.z);
  if (!ls.length) lb.innerHTML = '<p class="muted tiny">No colour changes by height.</p>';
  ls.forEach(l => {
    const r = el('div', { class: 'layer-row' });
    r.innerHTML = `<span>From</span><input type="number" step="${opts.layerH}" min="0" value="${+l.z.toFixed(3)}" style="width:6em"> mm up
      <select>${project.slots.map((s, i) => `<option value="${i + 1}" ${l.slot === i + 1 ? 'selected' : ''}>${i + 1} · ${esc(s.name)}</option>`).join('')}</select><button class="icon-btn" title="Remove">✕</button>`;
    const [inp] = r.querySelectorAll('input'), sel = r.querySelector('select');
    inp.onchange = () => { l.z = Math.max(0, +inp.value || 0); updateBands(); changed(); };
    sel.onchange = () => { l.slot = +sel.value; updateBands(); changed(); };
    r.querySelector('button').onclick = () => { project.layers = project.layers.filter(x => x !== l); updateBands(); refreshSide(); changed(); };
    r.onmouseenter = () => { const b = bounds(), s = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3()); layerGuide.scale.set(s.x * 1.3 + 4, s.y * 1.3 + 4, 1); layerGuide.position.set(c.x, c.y, l.z); layerGuide.material.color.set(slotHex(l.slot)); layerGuide.visible = true; needsRender = true; };
    r.onmouseleave = () => { layerGuide.visible = false; needsRender = true; };
    lb.append(r);
  });
  side.querySelector('[data-addlayer]').onclick = () => {
    const z = parseFloat(side.querySelector('[data-lz]').value);
    if (!(z > 0)) return toast('Type a height in mm');
    project.layers.push({ z: snapZ(z), slot: slotSel }); updateBands(); refreshSide(); changed();
  };
  side.querySelector('[data-clearlayers]')?.addEventListener('click', () => { const old = project.layers; project.layers = []; pushUndo({ undo: () => { project.layers = old; updateBands(); refreshSide(); }, redo: () => { project.layers = []; updateBands(); refreshSide(); } }); updateBands(); refreshSide(); changed(); });
  side.querySelector('[data-est]').onclick = runEstimate;
  side.querySelectorAll('[data-eo]').forEach(i => i.onchange = () => { opts[i.dataset.eo] = +i.value; runEstimate(); });
  side.querySelectorAll('[data-export]').forEach(b => b.onclick = () => exportFile(b.dataset.export));
  side.querySelector('[data-open2]').onchange = e => openFiles([...e.target.files]);
  side.querySelector('[data-shot]').onclick = () => { renderer.render(scene, camera); renderer.domElement.toBlob(b => download(`${project.name}.png`, b)); };
  if (lastEstimate) showEstimate(lastEstimate);
}

function removeSlot(n) {
  if (!confirm(`Remove filament ${n}? Anything painted with it goes back to the part's colour.`)) return;
  for (const p of allParts()) {
    for (let t = 0; t < p.tri.length; t++) { if (p.tri[t] === n) { p.tri[t] = 0; markDirty(p, t); } else if (p.tri[t] > n) { p.tri[t]--; markDirty(p, t); } }
    if (p.slot === n) p.slot = 1; else if (p.slot > n) p.slot--;
    if (p.orig) p.dirty = new Uint8Array(p.tri.length).fill(1);
  }
  project.layers = project.layers.filter(l => l.slot !== n).map(l => ({ ...l, slot: l.slot > n ? l.slot - 1 : l.slot }));
  project.slots.splice(n - 1, 1);
  slotSel = Math.min(slotSel, project.slots.length);
  undoStack.length = redoStack.length = 0;
  allParts().forEach(p => recolourPart(p)); updateBands(); refreshSide(); changed();
}

async function makeFiner(p) {
  const size = parseFloat(prompt('Split triangles so no edge is longer than (mm):', '1.5'));
  if (!(size > 0)) return;
  busy('Making the mesh finer…'); await nextFrame();
  const ok = subdivide(p, size);
  busy(false);
  if (!ok) return toast('That would be too many triangles. Try a bigger size.', 4000);
  undoStack.length = redoStack.length = 0;
  rebuildScene(); refreshSide(); changed();
  toast(`${(p.index.length / 3).toLocaleString()} triangles now`);
}

/* ================= estimate ================= */
let lastEstimate = null;
async function runEstimate() {
  if (!project) return;
  const box = document.querySelector('#page-studio [data-estimate]');
  box.textContent = 'Working it out…'; await nextFrame();
  const shown = { ...project, objects: project.objects.map(o => ({ ...o, parts: o.parts.filter(p => !p.hidden) })) };
  const e = estimate(shown, { wall: opts.wall, infill: opts.infill / 100, layerH: opts.layerH, wastePerSwap: opts.waste, densityOf: store.density });
  lastEstimate = e;
  showEstimate(e);
}
function showEstimate(e) {
  const box = document.querySelector('#page-studio [data-estimate]');
  if (!box) return;
  let total = 0;
  const needs = [];
  const rows = Object.entries(e.perSlot).sort((a, b) => a[0] - b[0]).map(([s, v]) => {
    const slot = project.slots[s - 1]; if (!slot) return '';
    const g = v.grams + v.waste;
    const cost = g / 1000 * store.priceFor(slot.type);
    total += cost;
    const sp = slot.spoolId ? store.spoolById(slot.spoolId) : null;
    if (sp) needs.push({ spool: sp, grams: g, from: '3D model' });
    const left = sp?.owned ? (sp.grams ?? 0) : null;
    return `<tr><td><span class="sw" style="background:${slot.hex}"></span> ${s}</td><td>${esc(slot.name)}</td><td>${Math.round(g)} g</td><td>${money(cost)}</td><td>${sp ? (sp.owned ? (left >= g ? '✓' : `<span class="warn">only ${Math.round(left)} g</span>`) : '♡ buy') : '<span class="muted">?</span>'}</td></tr>`;
  }).join('');
  setDesignNeeds('3D model', needs);
  box.classList.remove('muted');
  box.innerHTML = `<table class="est"><thead><tr><th></th><th>Filament</th><th>About</th><th>Cost</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <p><b>Total about ${money(total)}</b>${e.swaps ? ` · ${e.swaps.toLocaleString()} filament swaps, about ${Math.round(e.waste)} g of that is purge waste` : ''}</p>
    <p class="muted">A rough guess from the model's shape. Bambu Studio's sliced numbers are the real ones.</p>`;
}

/* ================= export & keeping your work ================= */
async function exportFile(forWhat = 'bambu') {
  if (!project) return;
  busy('Writing the 3MF…'); await nextFrame();
  try {
    const shown = { ...project, objects: project.objects.map(o => ({ ...o, parts: o.parts.filter(p => !p.hidden) })).filter(o => o.parts.length) };
    const profiles = await import(forWhat === 'orca' ? './orca-a1-profiles.js' : './bambu-a1-profiles.js');
    const data = build3MF(shown, profiles);
    download(`${project.name || 'painted'}${forWhat === 'orca' ? ' (Orca)' : ''}.3mf`, new Blob([data], { type: 'model/3mf' }));
    toast(`Saved. Open it in ${forWhat === 'orca' ? 'OrcaSlicer' : 'Bambu Studio'} with File → Open project.`, 4000);
  } catch (err) { console.error(err); toast('Could not write the file: ' + err.message, 5000); }
  busy(false);
}

let saveT;
function changed(estimateAgain = true) {
  clearTimeout(saveT);
  saveT = setTimeout(persist, 1200);
  if (estimateAgain && lastEstimate) { clearTimeout(changed.et); changed.et = setTimeout(runEstimate, 900); }
}
function db() {
  return new Promise((res, rej) => { const r = indexedDB.open('filament-studio', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function persist() {
  if (!project) return;
  try {
    const plain = { name: project.name, slots: project.slots, layers: project.layers, objects: project.objects.map(o => ({ name: o.name, parts: o.parts.map(p => ({ name: p.name, positions: p.positions, index: p.index, tri: p.tri, orig: p.orig, dirty: p.dirty, slot: p.slot, hidden: !!p.hidden })) })) };
    const d = await db();
    d.transaction('kv', 'readwrite').objectStore('kv').put(plain, 'project');
  } catch (e) { console.warn('Could not keep the project', e); }
}
async function restore() {
  try {
    const d = await db();
    const p = await new Promise(r => { const q = d.transaction('kv').objectStore('kv').get('project'); q.onsuccess = () => r(q.result); q.onerror = () => r(null); });
    if (!p || project) return;
    p.objects.forEach(o => o.parts.forEach(x => x.id = newPartId()));
    project = p;
    // slots follow your library (a colour you changed on the Filaments page updates here)
    project.slots = project.slots.map(s => { const sp = s.spoolId && store.spoolById(s.spoolId); return sp ? fromSpool(sp) : s; });
    rebuildScene(); frame(); refreshSide();
  } catch (e) { console.warn(e); }
}
