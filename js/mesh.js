// Geometry helpers: neighbours for fill, splitting big triangles for finer painting, and filament estimates.

// For each triangle, its (up to) 3 neighbours across shared edges. -1 = open edge.
export function adjacency(part) {
  if (part._adj) return part._adj;
  const I = part.index, n = I.length / 3;
  const adj = new Int32Array(n * 3).fill(-1);
  const edges = new Map();
  for (let t = 0; t < n; t++) {
    for (let e = 0; e < 3; e++) {
      const a = I[t * 3 + e], b = I[t * 3 + (e + 1) % 3];
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      const o = edges.get(key);
      if (o === undefined) edges.set(key, t * 3 + e);
      else if (o >= 0) { adj[t * 3 + e] = Math.floor(o / 3); adj[o] = t; edges.set(key, -2); }
    }
  }
  part._adj = adj;
  return adj;
}

export function normals(part) {
  if (part._nrm) return part._nrm;
  const P = part.positions, I = part.index, n = I.length / 3, N = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z) || 1;
    N[t * 3] = x / l; N[t * 3 + 1] = y / l; N[t * 3 + 2] = z / l;
  }
  part._nrm = N;
  return N;
}

// Flood fill across neighbours while the surface stays smooth (angle in degrees), or while the colour stays the same.
export function floodFill(part, start, { maxAngle = 30, sameColour = false } = {}) {
  const adj = adjacency(part), N = normals(part), n = part.index.length / 3;
  const seen = new Uint8Array(n), out = [start];
  seen[start] = 1;
  const cos = Math.cos(maxAngle * Math.PI / 180), startState = part.tri[start];
  for (let q = 0; q < out.length; q++) {
    const t = out[q];
    for (let e = 0; e < 3; e++) {
      const u = adj[t * 3 + e];
      if (u < 0 || seen[u]) continue;
      if (sameColour) { if (part.tri[u] !== startState) continue; }
      else if (N[t * 3] * N[u * 3] + N[t * 3 + 1] * N[u * 3 + 1] + N[t * 3 + 2] * N[u * 3 + 2] < cos) continue;
      seen[u] = 1; out.push(u);
    }
  }
  return out;
}

// Split triangles until no edge is longer than maxEdge (mm). Keeps the colours. Returns false if it would be too big.
export function subdivide(part, maxEdge, limit = 3_000_000) {
  let P = Array.from(part.positions), I = Array.from(part.index), S = Array.from(part.tri);
  const mid = new Map();
  const len2 = (a, b) => (P[a * 3] - P[b * 3]) ** 2 + (P[a * 3 + 1] - P[b * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[b * 3 + 2]) ** 2;
  const m2 = maxEdge * maxEdge;
  const midpoint = (a, b) => {
    const key = a < b ? a + ',' + b : b + ',' + a;
    let v = mid.get(key);
    if (v === undefined) { v = P.length / 3; P.push((P[a * 3] + P[b * 3]) / 2, (P[a * 3 + 1] + P[b * 3 + 1]) / 2, (P[a * 3 + 2] + P[b * 3 + 2]) / 2); mid.set(key, v); }
    return v;
  };
  for (let round = 0; round < 12; round++) {
    // An edge is split if it is too long; both triangles sharing it see the same decision, so no cracks.
    const nI = [], nS = [];
    let changed = false;
    for (let t = 0; t < I.length / 3; t++) {
      const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2], s = S[t];
      const ab = len2(a, b) > m2, bc = len2(b, c) > m2, ca = len2(c, a) > m2;
      const k = ab + bc + ca;
      if (!k) { nI.push(a, b, c); nS.push(s); continue; }
      changed = true;
      if (k === 3) {
        const x = midpoint(a, b), y = midpoint(b, c), z = midpoint(c, a);
        nI.push(a, x, z, x, b, y, z, y, c, x, y, z); nS.push(s, s, s, s);
      } else if (k === 1) {
        if (ab) { const x = midpoint(a, b); nI.push(a, x, c, x, b, c); }
        else if (bc) { const y = midpoint(b, c); nI.push(a, b, y, a, y, c); }
        else { const z = midpoint(c, a); nI.push(a, b, z, z, b, c); }
        nS.push(s, s);
      } else {
        if (!ab) { const y = midpoint(b, c), z = midpoint(c, a); nI.push(a, b, y, a, y, z, z, y, c); }
        else if (!bc) { const x = midpoint(a, b), z = midpoint(c, a); nI.push(a, x, z, x, b, c, x, c, z); }
        else { const x = midpoint(a, b), y = midpoint(b, c); nI.push(a, x, c, x, y, c, x, b, y); }
        nS.push(s, s, s);
      }
    }
    if (nS.length > limit) return false;
    I = nI; S = nS;
    if (!changed) break;
  }
  part.positions = new Float32Array(P);
  part.index = new Uint32Array(I);
  part.tri = new Uint8Array(S);
  part.orig = null; part.dirty = null; part._adj = null; part._nrm = null;
  return true;
}

/* ---------- filament estimate ---------- */
// Clip a triangle to z in [lo, hi]; returns polygon points.
function clipZ(pts, lo, hi) {
  const clip = (poly, keep, val) => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const A = poly[i], B = poly[(i + 1) % poly.length];
      const ia = keep(A[2]), ib = keep(B[2]);
      if (ia) out.push(A);
      if (ia !== ib) { const t = (val - A[2]) / (B[2] - A[2]); out.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, val]); }
    }
    return out;
  };
  let p = pts;
  if (lo > -Infinity) p = clip(p, z => z >= lo, lo);
  if (p.length && hi < Infinity) p = clip(p, z => z <= hi, hi);
  return p;
}

// For one part: per filament, surface area (mm²) and inside volume (mm³), honouring layer bands and painted faces.
// bands: sorted [{z, slot}] – from height z upwards the default filament is slot.
export function partUsage(part, bands) {
  const P = part.positions, I = part.index, n = I.length / 3;
  const area = {}, vol = {};
  const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
  const edges = [-Infinity, ...bands.map(b => b.z), Infinity];
  const slotOf = bi => bi === 0 ? part.slot : bands[bi - 1].slot;
  const below = new Float64Array(bands.length);   // volume under each band edge
  let total = 0;
  const tri = (poly, f) => { for (let i = 1; i < poly.length - 1; i++) f(poly[0], poly[i], poly[i + 1]); };
  const cross = (p0, p1, p2) => { const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2], vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2]; return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]; };
  for (let t = 0; t < n; t++) {
    const A = [P[I[t * 3] * 3], P[I[t * 3] * 3 + 1], P[I[t * 3] * 3 + 2]];
    const B = [P[I[t * 3 + 1] * 3], P[I[t * 3 + 1] * 3 + 1], P[I[t * 3 + 1] * 3 + 2]];
    const C = [P[I[t * 3 + 2] * 3], P[I[t * 3 + 2] * 3 + 1], P[I[t * 3 + 2] * 3 + 2]];
    const zmin = Math.min(A[2], B[2], C[2]), zmax = Math.max(A[2], B[2], C[2]);
    // divergence theorem with F = (0,0,z-h): volume below h = sum over the surface below h of (z-h)·n_z·dA
    const cz = cross(A, B, C)[2];
    total += (A[2] + B[2] + C[2]) / 3 * cz / 2;
    bands.forEach((b, k) => {
      if (zmin >= b.z) return;
      const poly = zmax <= b.z ? [A, B, C] : clipZ([A, B, C], -Infinity, b.z);
      tri(poly, (p0, p1, p2) => { below[k] += ((p0[2] + p1[2] + p2[2]) / 3 - b.z) * cross(p0, p1, p2)[2] / 2; });
    });
    for (let bi = 0; bi < edges.length - 1; bi++) {
      const lo = edges[bi], hi = edges[bi + 1];
      if (zmax < lo || zmin > hi) continue;
      const poly = (zmin >= lo && zmax <= hi) ? [A, B, C] : clipZ([A, B, C], lo, hi);
      if (poly.length < 3) continue;
      tri(poly, (p0, p1, p2) => { const c = cross(p0, p1, p2); add(area, part.tri[t] || slotOf(bi), Math.hypot(c[0], c[1], c[2]) / 2); });
    }
  }
  const cum = [0, ...below, total];
  for (let bi = 0; bi < edges.length - 1; bi++) add(vol, slotOf(bi), Math.abs(cum[bi + 1] - cum[bi]));
  return { area, vol };
}

// Grams per filament for the whole project (rough: walls + infill), plus how many filament swaps.
export function estimate(project, { wall = 0.84, infill = 0.15, layerH = 0.2, wastePerSwap = 0.35, densityOf }) {
  const bands = [...project.layers].sort((a, b) => a.z - b.z);
  const perSlot = {};
  const zr = {};
  let zTop = 0;
  for (const obj of project.objects) for (const part of obj.parts) {
    const { area, vol } = partUsage(part, bands);
    for (const s of new Set([...Object.keys(area), ...Object.keys(vol)])) {
      const A = area[s] || 0, V = Math.max(0, vol[s] || 0);
      const shell = A * wall;
      const mm3 = shell + Math.max(0, V - shell) * infill;
      perSlot[s] = (perSlot[s] || 0) + mm3;
    }
    // height range each filament appears in (for swap counting)
    const P = part.positions, I = part.index;
    for (let t = 0; t < I.length / 3; t++) {
      let z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < 3; k++) { const z = P[I[t * 3 + k] * 3 + 2]; z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      zTop = Math.max(zTop, z1);
      const s = part.tri[t] || part.slot;
      if (!bands.length || part.tri[t]) { const r = zr[s] || (zr[s] = []); r.push([z0, z1]); }
    }
    if (bands.length) {
      let zb = Infinity, zt = -Infinity;
      for (let i = 2; i < P.length; i += 3) { zb = Math.min(zb, P[i]); zt = Math.max(zt, P[i]); }
      const edges = [zb, ...bands.map(b => b.z), zt];
      for (let bi = 0; bi < edges.length - 1; bi++) {
        const s = bi === 0 ? part.slot : bands[bi - 1].slot;
        (zr[s] || (zr[s] = [])).push([Math.max(zb, edges[bi]), Math.min(zt, edges[bi + 1])]);
      }
    }
  }
  // swaps: per layer, how many filaments are present
  const layers = Math.max(1, Math.ceil(zTop / layerH));
  const present = Object.entries(zr).map(([s, ranges]) => {
    const on = new Uint8Array(layers + 1);
    for (const [a, b] of ranges) for (let L = Math.max(0, Math.floor(a / layerH)); L <= Math.min(layers, Math.floor(b / layerH)); L++) on[L] = 1;
    return { s, on };
  });
  let swaps = 0, last = null;
  for (let L = 0; L <= layers; L++) {
    const here = present.filter(p => p.on[L]).map(p => p.s);
    if (!here.length) continue;
    // each layer prints every filament in it once; starting with the one left loaded saves a swap
    swaps += here.length - (last && here.includes(last) ? 1 : 0);
    last = here[here.length - 1];
  }
  swaps = Math.max(0, swaps - 1);   // the first filament is just loaded, not swapped
  const out = {};
  for (const [s, mm3] of Object.entries(perSlot)) {
    const slot = project.slots[s - 1];
    out[s] = { grams: mm3 / 1000 * densityOf(slot?.type) };
  }
  const swapsTotal = present.length > 1 ? swaps : 0;
  const waste = swapsTotal * wastePerSwap;
  // share the purge waste between filaments by how much each is used
  const tot = Object.values(out).reduce((a, o) => a + o.grams, 0) || 1;
  for (const o of Object.values(out)) o.waste = waste * o.grams / tot;
  return { perSlot: out, swaps: swapsTotal, waste, layers };
}
