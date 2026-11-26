// Filament library, prices and settings, kept in this browser (localStorage).
import { BAMBU } from './bambu-colours.js';
import { hexToLab, deltaE } from './colour.js';

const KEY = 'fs-store-v1';

// Bambu AU store normal prices (AUD), read from au.store.bambulab.com on 2026-11-27: the cheapest option of each
// (a 1 kg refill where there is one). Types marked "est" weren't on the store that day, so they're my guesses.
// The store runs bulk sales often (Black Friday 2026: PLA Basic $13.19 each for 10+). Edit them on the Shopping page.
export const DEFAULT_PRICES = {
  'PLA Basic': 23.99, 'PLA Matte': 23.99, 'PLA Silk+': 23.99, 'PLA Silk': 23.99 /* est */, 'PLA Lite': 19.99 /* est */,
  'PLA Translucent': 28.99, 'PLA Palette': 28.99, 'PLA Pure': 27.99, 'PLA Tough+': 31.99, 'PLA Tough': 31.99 /* est */,
  'PLA Sparkle': 38.99, 'PLA Galaxy': 38.99, 'PLA Marble': 38.99, 'PLA Metal': 38.99, 'PLA Wood': 38.99, 'PLA Glow': 38.99,
  'PLA Dynamic': 38.99 /* est */, 'PLA Aero': 67.99, 'PLA-CF': 48.99,
  'PETG Basic': 21.99, 'PETG HF': 23.99 /* est */, 'PETG Matte': 21.99, 'PETG Translucent': 23.99, 'PETG-CF': 48.99,
  'ABS': 23.99, 'ABS-GF': 45.99, 'ASA': 45.99, 'ASA Aero': 76.99, 'ASA-CF': 56.99,
  'TPU 95A HF': 64.99, 'TPU for AMS': 59.99, 'TPU 95A': 59.99 /* est */, 'TPU 90A': 59.99 /* est */, 'TPU 85A': 59.99 /* est */,
  'PC': 61.99, 'PC FR': 83.99, 'PA6-CF': 65.99, 'PA6-GF': 91.99, 'PAHT-CF': 76.99, 'PPA-CF': 229.99,
  'PET-CF': 68.99, 'PPS-CF': 198.99, 'PVA': 61.99,
  'Support for PLA/PETG': 53.99, 'Support for PLA': 53.99 /* est */, 'Support for ABS': 22.99, 'Support for PA/PET': 61.99,
};
export const PRICES_CHECKED = '27 Nov 2026';
export const FALLBACK_PRICE = 39.99;

// Density in g/cm³, for turning volume into grams.
export function density(type = '') {
  const t = type.toUpperCase();
  if (t.includes('TPU')) return 1.21;
  if (t.includes('PETG') || t.includes('PET')) return 1.27;
  if (t.includes('ASA')) return 1.07;
  if (t.includes('ABS')) return 1.05;
  if (t.includes('PC')) return 1.2;
  if (t.includes('PA') && !t.includes('PLA')) return 1.12;
  if (t.includes('AERO')) return 0.8;
  return 1.24;
}

// Which Bambu Studio / Orca preset to name for a filament on an A1.
export function presetFor(type = '') {
  const known = ['ABS', 'ABS-GF', 'ASA-CF', 'PA6-CF', 'PA6-GF', 'PAHT-CF', 'PC', 'PC FR', 'PET-CF', 'PETG Basic', 'PETG HF', 'PETG Matte', 'PETG Translucent',
    'PLA Aero', 'PLA Basic', 'PLA Dynamic', 'PLA Galaxy', 'PLA Glow', 'PLA Lite', 'PLA Marble', 'PLA Matte', 'PLA Metal', 'PLA Palette', 'PLA Pure', 'PLA Silk', 'PLA Silk+',
    'PLA Sparkle', 'PLA Tough', 'PLA Tough+', 'PLA Translucent', 'PLA Wood', 'PLA-CF', 'PVA', 'TPU 90A', 'TPU 95A', 'TPU 95A HF', 'TPU for AMS'];
  if (known.includes(type)) return { preset: `Bambu ${type} @BBL A1`, vendor: 'Bambu Lab', base: baseType(type) };
  if (type === 'ASA Aero') return { preset: 'Bambu ASA-Aero @BBL A1', vendor: 'Bambu Lab', base: 'ASA' };
  if (type === 'ASA') return { preset: 'Generic ASA @BBL A1', vendor: 'Generic', base: 'ASA' };
  const base = baseType(type);
  const generic = { PLA: 'Generic PLA', PETG: 'Generic PETG', ABS: 'Generic ABS', ASA: 'Generic ASA', TPU: 'Generic TPU', PC: 'Generic PC', PA: 'Generic PA', PVA: 'Generic PVA' }[base] || 'Generic PLA';
  return { preset: `${generic} @BBL A1`, vendor: 'Generic', base };
}
export function baseType(type = '') {
  const t = type.toUpperCase();
  for (const b of ['PETG', 'PLA', 'ABS', 'ASA', 'TPU', 'PVA', 'PET', 'PC', 'PPA', 'PPS', 'PA']) if (t.startsWith(b) || t.includes(b)) return b === 'PET' ? 'PET' : b;
  return 'PLA';
}
export const FILAMENT_IDS = Object.fromEntries(BAMBU.map(r => [r[0], r[4]]));

export const TYPES = [...new Set(BAMBU.map(r => r[0]))];

export const uid = () => Math.random().toString(36).slice(2, 10);

const defaults = () => ({
  spools: [],            // { id, type, name, hex:[..], code, owned, grams, qty, note, custom }
  prices: {},            // type -> AUD per 1 kg spool (overrides DEFAULT_PRICES)
  reelCost: 5,           // a 1 kg spool on a reel costs about this much more than a refill
  addReels: false,
  bulkPct: 0,            // store discount for buying several
  shipping: 0,
  amsSlots: 4,
  shopNeeds: {},         // key -> { qty } for extra items on the list
});

let S = load();
const subs = new Set();

function load() {
  try { return Object.assign(defaults(), JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { return defaults(); }
}
export function save() { localStorage.setItem(KEY, JSON.stringify(S)); subs.forEach(f => f()); }
export const state = () => S;
export const onChange = f => { subs.add(f); return () => subs.delete(f); };

export function priceFor(type) {
  const p = S.prices[type] ?? DEFAULT_PRICES[type] ?? FALLBACK_PRICE;
  return S.addReels ? p + (+S.reelCost || 0) : p;
}
const EST = new Set(['PLA Silk', 'PLA Lite', 'PLA Tough', 'PLA Dynamic', 'PETG HF', 'TPU 95A', 'TPU 90A', 'TPU 85A', 'Support for PLA']);
export const priceNote = type => (EST.has(type) || !(type in DEFAULT_PRICES)) ? '/* est */' : '';
export const basePrice = type => S.prices[type] ?? DEFAULT_PRICES[type] ?? FALLBACK_PRICE;

export function catalog() {
  return BAMBU.map(([type, name, hex, code, fid]) => ({ key: `bambu:${code}:${type}`, type, name, hex, code, fid }));
}

export const spoolById = id => S.spools.find(s => s.id === id);
export function findSpool(type, name) {
  return S.spools.find(s => s.type === type && s.name.toLowerCase() === name.toLowerCase());
}

// Add a filament (from the Bambu list or custom). owned=false puts it on the wish list.
export function addSpool(f, owned) {
  const existing = findSpool(f.type, f.name);
  if (existing) {
    if (owned && !existing.owned) { existing.owned = true; existing.grams = existing.grams || 1000; save(); }
    return existing;
  }
  const s = { id: uid(), type: f.type, name: f.name, hex: [...f.hex], code: f.code || '', owned: !!owned, grams: owned ? 1000 : 0, qty: 1, note: '', custom: !!f.custom };
  S.spools.push(s);
  save();
  return s;
}
export function removeSpool(id) { S.spools = S.spools.filter(s => s.id !== id); save(); }

// Closest filaments to a colour. pool: 'owned' | 'library' | 'all'
export function nearest(hex, pool = 'owned', n = 3) {
  const lab = hexToLab(hex);
  let list;
  if (pool === 'owned') list = S.spools.filter(s => s.owned);
  else if (pool === 'library') list = S.spools;
  else {
    const mine = new Set(S.spools.map(s => s.type + '|' + s.name));
    list = [...S.spools, ...catalog().filter(c => !mine.has(c.type + '|' + c.name))];
  }
  return list.map(s => ({ f: s, d: deltaE(lab, hexToLab(s.hex[0])) })).sort((a, b) => a.d - b.d).slice(0, n);
}

export function storeLink(f) {
  const q = encodeURIComponent(`${f.type} ${f.name}`);
  return `https://au.store.bambulab.com/search?q=${q}`;
}

export function exportLibrary() { return JSON.stringify(S, null, 1); }
export function importLibrary(text) { S = Object.assign(defaults(), JSON.parse(text)); save(); }
