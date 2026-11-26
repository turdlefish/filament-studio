// Reading STL / 3MF and writing a 3MF that Bambu Studio and OrcaSlicer open with the colours in place.
import { unzipSync, zipSync, strToU8, strFromU8 } from '../vendor/fflate.module.js';
import { presetFor } from './store.js';
import { hexToLab, deltaE } from './colour.js';

export const BED = { x: 256, y: 256 };   // Bambu A1 build plate (mm)
let nextId = 1;
export const newPartId = () => 'p' + (nextId++);

/* ---------- painted-triangle codes (same scheme PrusaSlicer, Bambu Studio and Orca use) ---------- */
// One whole triangle in filament n (1-based): "4", "8", "0C", "1C", "2C"…
export function encodeState(n) {
  if (!n) return '';
  if (n === 1) return '4';
  if (n === 2) return '8';
  return (n - 3).toString(16).toUpperCase() + 'C';
}
// Read a code back. Split triangles (fine brush strokes) come back as the filament covering most of the triangle.
export function decodeState(str) {
  if (!str) return 0;
  const bits = [];
  for (let i = str.length - 1; i >= 0; i--) {
    const v = parseInt(str[i], 16);
    for (let b = 0; b < 4; b++) bits.push((v >> b) & 1);
  }
  let p = 0;
  const read = n => { let v = 0; for (let i = 0; i < n; i++) v |= (bits[p++] || 0) << i; return v; };
  const tally = new Map();
  const walk = w => {
    const split = read(2);
    if (split) { read(2); const kids = split + 1; for (let c = 0; c < kids; c++) walk(w / kids); }
    else { let n = read(2); if (n === 3) n = 3 + read(4); tally.set(n, (tally.get(n) || 0) + w); }
  };
  try { walk(1); } catch { return 0; }
  let best = 0, bw = -1;
  for (const [n, w] of tally) if (w > bw) { bw = w; best = n; }
  return best;
}

/* ---------- welding loose triangles into shared corners ---------- */
function weld(flat) {           // flat: Float32Array of 9 numbers per triangle
  const map = new Map(), pos = [], index = new Uint32Array(flat.length / 3);
  for (let i = 0; i < flat.length; i += 3) {
    const key = Math.round(flat[i] * 1e4) + ',' + Math.round(flat[i + 1] * 1e4) + ',' + Math.round(flat[i + 2] * 1e4);
    let id = map.get(key);
    if (id === undefined) { id = pos.length / 3; map.set(key, id); pos.push(flat[i], flat[i + 1], flat[i + 2]); }
    index[i / 3] = id;
  }
  return { positions: new Float32Array(pos), index };
}

/* ---------- STL ---------- */
export function parseSTL(buf, name) {
  const dv = new DataView(buf);
  let flat;
  const triCount = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  if (buf.byteLength === 84 + triCount * 50 && triCount > 0) {
    flat = new Float32Array(triCount * 9);
    for (let t = 0; t < triCount; t++) {
      const o = 84 + t * 50 + 12;
      for (let k = 0; k < 9; k++) flat[t * 9 + k] = dv.getFloat32(o + k * 4, true);
    }
  } else {
    const text = new TextDecoder().decode(buf);
    const nums = [];
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    let m;
    while ((m = re.exec(text))) nums.push(+m[1], +m[2], +m[3]);
    flat = new Float32Array(nums);
  }
  const { positions, index } = weld(flat);
  const base = name.replace(/\.[^.]+$/, '');
  return { name: base, objects: [{ name: base, parts: [makePart(base, positions, index)] }], slots: null, layers: [] };
}

function makePart(name, positions, index, tri = null, orig = null, slot = 1) {
  return { id: newPartId(), name, positions, index, tri: tri || new Uint8Array(index.length / 3), orig, dirty: null, slot };
}

/* ---------- 3MF ---------- */
const attr = (s, k) => { const m = new RegExp('(?:^|\\s)' + k.replace(':', '\\:') + '="([^"]*)"').exec(s); return m ? m[1] : null; };
const ident = () => [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const parseT = s => s ? s.trim().split(/\s+/).map(Number) : ident();
// 3MF matrices: p' = p * M (row vector), given as m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32
const mul = (a, b) => {       // apply a then b
  const r = new Array(12);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    r[i * 3 + j] = (i < 3 ? 0 : b[9 + j]) + a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return r;
};

function parseModelXml(xml, path, store) {
  const unit = attr(xml.slice(0, 2000), 'unit') || 'millimeter';
  const scale = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[unit] || 1;
  let pos = 0;
  const builds = [];
  while (true) {
    const s = xml.indexOf('<object', pos);
    if (s < 0) break;
    const tagEnd = xml.indexOf('>', s);
    const head = xml.slice(s + 7, tagEnd);
    const end = xml.indexOf('</object>', tagEnd);
    const id = attr(head, 'id');
    const obj = { id, name: attr(head, 'name'), mesh: null, comps: [] };
    const ms = xml.indexOf('<mesh', tagEnd);
    if (ms >= 0 && ms < end) {
      const verts = [];
      const vre = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
      vre.lastIndex = ms;
      const triStart = xml.indexOf('<triangles', ms);
      let m;
      while ((m = vre.exec(xml)) && m.index < (triStart > 0 ? triStart : end)) verts.push(+m[1] * scale, +m[2] * scale, +m[3] * scale);
      const idx = [], paint = [];
      let any = false;
      const tre = /<triangle\s([^>]*)>/g;
      tre.lastIndex = triStart;
      while ((m = tre.exec(xml)) && m.index < end) {
        const a = m[1];
        const v = /v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/.exec(a) || [0, attr(a, 'v1'), attr(a, 'v2'), attr(a, 'v3')];
        idx.push(+v[1], +v[2], +v[3]);
        let p = null;
        const pi = a.indexOf('paint_color="');
        if (pi >= 0) p = a.slice(pi + 13, a.indexOf('"', pi + 13));
        else { const qi = a.indexOf('mmu_segmentation="'); if (qi >= 0) p = a.slice(qi + 18, a.indexOf('"', qi + 18)); }
        paint.push(p); if (p) any = true;
      }
      obj.mesh = { positions: new Float32Array(verts), index: new Uint32Array(idx), paint: any ? paint : null };
    } else {
      const cre = /<component\s([^>]*)>/g;
      cre.lastIndex = tagEnd;
      let m;
      while ((m = cre.exec(xml)) && m.index < end) {
        const a = m[1];
        obj.comps.push({ objectid: attr(a, 'objectid'), path: attr(a, 'p:path') || path, transform: parseT(attr(a, 'transform')) });
      }
    }
    store.set(path + '#' + id, obj);
    pos = end + 9;
  }
  const bs = xml.indexOf('<build', pos);
  if (bs >= 0) {
    const ire = /<item\s([^>]*)>/g; ire.lastIndex = bs; let m;
    while ((m = ire.exec(xml))) { if (attr(m[1], 'printable') === '0') continue; builds.push({ objectid: attr(m[1], 'objectid'), transform: parseT(attr(m[1], 'transform')) }); }
  }
  return builds;
}

export function parse3MF(buf, name) {
  const files = unzipSync(new Uint8Array(buf));
  const text = p => { const k = Object.keys(files).find(f => f.toLowerCase() === p.toLowerCase().replace(/^\//, '')); return k ? strFromU8(files[k]) : null; };
  const store = new Map();
  const mainPath = '/3D/3dmodel.model';
  const main = text(mainPath) || text(Object.keys(files).find(f => f.endsWith('.model')));
  if (!main) throw new Error('No model inside this 3MF');
  // Other model files (Bambu keeps meshes in 3D/Objects/*.model)
  for (const f of Object.keys(files)) if (f.endsWith('.model') && '/' + f !== mainPath) parseModelXml(strFromU8(files[f]), '/' + f, store);
  const builds = parseModelXml(main, mainPath, store);

  // Bambu / Orca settings: filament per object and part, and the filament list.
  const settings = { obj: {}, part: {}, names: {}, sub: {} };
  const ms = text('Metadata/model_settings.config') || text('Metadata/Slic3r_PE_model.config');
  if (ms) {
    const doc = new DOMParser().parseFromString(ms, 'text/xml');
    for (const o of doc.querySelectorAll('object')) {
      const oid = o.getAttribute('id');
      for (const md of o.children) if (md.tagName === 'metadata' && md.getAttribute('key') === 'extruder') settings.obj[oid] = +md.getAttribute('value');
      for (const md of o.children) if (md.tagName === 'metadata' && md.getAttribute('key') === 'name') settings.names[oid] = md.getAttribute('value');
      for (const p of o.querySelectorAll('part, volume')) {
        const pid = p.getAttribute('id') || p.getAttribute('firstid');
        if (p.getAttribute('subtype')) settings.sub[oid + ':' + pid] = p.getAttribute('subtype');
        for (const md of p.querySelectorAll('metadata')) {
          if (md.getAttribute('key') === 'extruder') settings.part[oid + ':' + pid] = +md.getAttribute('value');
          if (md.getAttribute('key') === 'name') settings.names[oid + ':' + pid] = md.getAttribute('value');
        }
      }
    }
  }
  let slots = null;
  const ps = text('Metadata/project_settings.config');
  if (ps) {
    try {
      const j = JSON.parse(ps);
      if (Array.isArray(j.filament_colour)) slots = j.filament_colour.map((c, i) => ({ hex: c.slice(0, 7).toUpperCase(), type: (j.filament_settings_id?.[i] || '').replace(/^Bambu |^Generic | @.*$/g, '') || j.filament_type?.[i] || 'PLA', spoolId: null }));
    } catch { /* not JSON (PrusaSlicer ini) */ }
  }
  const layers = [];
  const cg = text('Metadata/custom_gcode_per_layer.xml');
  if (cg) {
    const doc = new DOMParser().parseFromString(cg, 'text/xml');
    const plate = doc.querySelector('plate');
    if (plate) for (const l of plate.querySelectorAll('layer')) if (l.getAttribute('type') === '2' || l.getAttribute('gcode') === 'tool_change') layers.push({ z: +l.getAttribute('top_z'), slot: +l.getAttribute('extruder') });
  }

  // Build objects: each build item is an object; each mesh under it is a part.
  const objects = [];
  let skipped = 0;
  for (const b of builds) {
    const root = store.get(mainPath + '#' + b.objectid);
    if (!root) continue;
    const oid = b.objectid;
    const object = { name: settings.names[oid] || root.name || name, parts: [] };
    const objSlot = settings.obj[oid] || 1;
    const visit = (o, t, path) => {
      const sub = settings.sub[oid + ':' + o.id];
      if (o.mesh && sub && sub !== 'normal_part') { skipped++; }   // modifiers, support blockers… are slicer helpers, not printed
      else if (o.mesh) {
        const { positions, index, paint } = o.mesh;
        const world = new Float32Array(positions.length);
        for (let i = 0; i < positions.length; i += 3) {
          const x = positions[i], y = positions[i + 1], z = positions[i + 2];
          world[i] = x * t[0] + y * t[3] + z * t[6] + t[9];
          world[i + 1] = x * t[1] + y * t[4] + z * t[7] + t[10];
          world[i + 2] = x * t[2] + y * t[5] + z * t[8] + t[11];
        }
        let tri = null;
        if (paint) { tri = new Uint8Array(paint.length); const cache = new Map(); paint.forEach((p, i) => { if (!p) return; let v = cache.get(p); if (v === undefined) { v = decodeState(p); cache.set(p, v); } tri[i] = v; }); }
        const slot = settings.part[oid + ':' + o.id] || objSlot;
        object.parts.push(makePart(settings.names[oid + ':' + o.id] || o.name || `${object.name} part ${object.parts.length + 1}`, world, index, tri, paint, slot));
      }
      for (const c of o.comps) {
        const child = store.get(c.path + '#' + c.objectid) || store.get(path + '#' + c.objectid);
        if (child) visit(child, mul(c.transform, t), c.path);
      }
    };
    visit(root, b.transform, mainPath);
    if (object.parts.length) objects.push(object);
  }
  if (!objects.length) throw new Error('This 3MF has no printable objects');
  return { name: name.replace(/\.[^.]+$/, ''), objects, slots, layers, fromSlicer: !!ps, skipped };
}

/* ---------- writing ---------- */
const fmt = v => { const r = Math.round(v * 1e5) / 1e5; return Object.is(r, -0) ? '0' : String(r); };
const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// project: { name, objects:[{name, parts:[part]}], slots:[{hex,type,name}], layers:[{z,slot}] }
// Full Bambu Studio project settings: A1 printer + 0.20mm Standard, and Bambu's own profile for each filament.
// profiles = the module js/bambu-a1-profiles.js
export function projectSettings(slots, profiles) {
  const { TEMPLATE, PER_FILAMENT, FILAMENTS, FALLBACK, PROFILE_VERSION } = profiles;
  const n = slots.length;
  const pre = slots.map(s => presetFor(s.type));
  const prof = pre.map(p => FILAMENTS[p.preset] || FILAMENTS['Generic PLA @BBL A1']);
  const out = { ...TEMPLATE };
  for (const k of PER_FILAMENT) out[k] = prof.flatMap(p => p[k] ?? FALLBACK[k]);
  out.filament_colour = slots.map(s => s.hex.toUpperCase());
  out.filament_settings_id = prof.map(p => p.filament_settings_id[0]);
  out.filament_ids = prof.map(p => p.filament_ids[0]);
  if ('filament_self_index' in out) out.filament_self_index = slots.map((_, i) => String(i + 1));
  if ('filament_map' in out) out.filament_map = slots.map(() => '1');
  if ('default_filament_colour' in out) out.default_filament_colour = slots.map(() => '');
  // purge amounts between colours: more when going from dark to light
  const lab = slots.map(s => hexToLab(s.hex));
  out.flush_volumes_matrix = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const v = i === j ? 0 : Math.min(800, Math.round(120 + 5 * Math.max(0, lab[j][0] - lab[i][0]) + 1.5 * deltaE(lab[i], lab[j])));
    out.flush_volumes_matrix.push(String(v));
  }
  out.flush_volumes_vector = Array(n * 2).fill('140');
  out.different_settings_to_system = Array(n + 2).fill('');
  out.version = PROFILE_VERSION;
  out.from = 'project'; out.name = 'project_settings';
  return out;
}

export function build3MF(project, profiles) {
  const res = [], buildItems = [], settingsObjs = [], plateInst = [];
  let id = 1;
  for (const obj of project.objects) {
    // object centre → build transform, meshes stored around it (as Bambu Studio does)
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const p of obj.parts) for (let i = 0; i < p.positions.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p.positions[i + k]); mx[k] = Math.max(mx[k], p.positions[i + k]); }
    const c = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    const partIds = [];
    for (const p of obj.parts) {
      const pid = id++;
      partIds.push(pid);
      const chunks = [` <object id="${pid}" type="model">\n  <mesh>\n   <vertices>\n`];
      const P = p.positions;
      let buf = [];
      for (let i = 0; i < P.length; i += 3) {
        buf.push(`    <vertex x="${fmt(P[i] - c[0])}" y="${fmt(P[i + 1] - c[1])}" z="${fmt(P[i + 2] - c[2])}"/>`);
        if (buf.length > 20000) { chunks.push(buf.join('\n') + '\n'); buf = []; }
      }
      chunks.push(buf.join('\n') + '\n   </vertices>\n   <triangles>\n'); buf = [];
      const I = p.index;
      for (let t = 0; t < I.length / 3; t++) {
        let code = '';
        if (p.orig && p.orig[t] && !(p.dirty && p.dirty[t])) code = p.orig[t];
        else if (p.tri[t]) code = encodeState(p.tri[t]);
        buf.push(`    <triangle v1="${I[t * 3]}" v2="${I[t * 3 + 1]}" v3="${I[t * 3 + 2]}"${code ? ` paint_color="${code}"` : ''}/>`);
        if (buf.length > 20000) { chunks.push(buf.join('\n') + '\n'); buf = []; }
      }
      chunks.push(buf.join('\n') + '\n   </triangles>\n  </mesh>\n </object>\n');
      res.push(chunks.join(''));
    }
    const oid = id++;
    res.push(` <object id="${oid}" type="model">\n  <components>\n${partIds.map(pid => `   <component objectid="${pid}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`).join('\n')}\n  </components>\n </object>\n`);
    buildItems.push(`  <item objectid="${oid}" transform="1 0 0 0 1 0 0 0 1 ${fmt(c[0])} ${fmt(c[1])} ${fmt(c[2])}" printable="1"/>`);
    const faceCount = obj.parts.reduce((a, p) => a + p.index.length / 3, 0);
    settingsObjs.push(`  <object id="${oid}">
    <metadata key="name" value="${xmlEsc(obj.name)}"/>
    <metadata key="extruder" value="${obj.parts[0].slot || 1}"/>
    <metadata face_count="${faceCount}"/>
${obj.parts.map((p, i) => `    <part id="${partIds[i]}" subtype="normal_part">
      <metadata key="name" value="${xmlEsc(p.name)}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="extruder" value="${p.slot || 1}"/>
      <mesh_stat face_count="${p.index.length / 3}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>`).join('\n')}
  </object>`);
    plateInst.push(`    <model_instance>\n      <metadata key="object_id" value="${oid}"/>\n      <metadata key="instance_id" value="0"/>\n      <metadata key="identify_id" value="${100 + oid}"/>\n    </model_instance>`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
 <metadata name="Application">${profiles.FOR_ORCA ? 'OrcaSlicer-2.3.1' : 'BambuStudio-' + profiles.PROFILE_VERSION}</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="Title">${xmlEsc(project.name)}</metadata>
 <metadata name="CreationDate">${today}</metadata>
 <metadata name="ModificationDate">${today}</metadata>
 <resources>
${res.join('')} </resources>
 <build>
${buildItems.join('\n')}
 </build>
</model>
`;
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
${settingsObjs.join('\n')}
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
${plateInst.join('\n')}
  </plate>
</config>
`;
  const slots = project.slots.length ? project.slots : [{ hex: '#FFFFFF', type: 'PLA Basic' }];
  const settings = projectSettings(slots, profiles);
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`),
    '3D/3dmodel.model': strToU8(model),
    'Metadata/model_settings.config': strToU8(modelSettings),
    'Metadata/project_settings.config': strToU8(JSON.stringify(settings, null, 4)),
  };
  if (project.layers.length) {
    const ls = [...project.layers].sort((a, b) => a.z - b.z);
    files['Metadata/custom_gcode_per_layer.xml'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<custom_gcodes_per_layer>
<plate>
<plate_info id="1"/>
${ls.map(l => `<layer top_z="${fmt(l.z)}" type="2" extruder="${l.slot}" color="${slots[l.slot - 1]?.hex || '#FFFFFF'}" extra="" gcode="tool_change"/>`).join('\n')}
<mode value="MultiAsSingle"/>
</plate>
</custom_gcodes_per_layer>
`);
  }
  return zipSync(files, { level: 6 });
}
