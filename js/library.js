// Filaments page (what you have + browsing the Bambu range) and the Shopping page.
import * as store from './store.js';
import { swatchCss, inkFor } from './colour.js';
import { el, esc, money, toast, download } from './ui.js';

let browseType = 'PLA Basic', browseQ = '';
let designNeeds = [];     // [{ spool, grams, from }] set by the 3D page and the recolour page
const needsBy = {};
export function setDesignNeeds(from, list) { needsBy[from] = list; designNeeds = Object.values(needsBy).flat(); if (document.querySelector('#page-shop.on')) renderShop(); }

/* ---------------- Filaments ---------------- */
export function renderFilaments() {
  const root = document.getElementById('page-filaments');
  const S = store.state();
  const owned = S.spools.filter(s => s.owned), want = S.spools.filter(s => !s.owned);
  root.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>My spools <span class="count">${owned.length}</span></h2>
        <div class="row gap"><button class="btn ghost small" data-backup>Save a backup</button><label class="btn ghost small">Load a backup<input type="file" accept=".json" hidden data-restore></label></div></div>
      ${owned.length ? '' : '<p class="muted">Nothing here yet. Find your spools in the Bambu range below and tap <b>Have</b>, or add a custom one.</p>'}
      <div class="spool-grid" data-owned></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Wish list <span class="count">${want.length}</span></h2><a class="btn ghost small" href="#shop">Open shopping list →</a></div>
      ${want.length ? '' : '<p class="muted">Tap <b>Want</b> on any colour below, or pick colours you don\'t have while recolouring or painting. They land here.</p>'}
      <div class="spool-grid" data-want></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Browse the Bambu range</h2><span class="muted tiny">${store.catalog().length} colours from Bambu Studio's list</span></div>
      <div class="row gap wrap"><select data-type>${store.TYPES.map(t => `<option ${t === browseType ? 'selected' : ''}>${esc(t)}</option>`).join('')}<option value="*" ${browseType === '*' ? 'selected' : ''}>All types</option></select>
        <input data-q placeholder="Search, e.g. pink" value="${esc(browseQ)}"></div>
      <div class="cat-grid" data-cat></div>
    </section>
    <section class="card">
      <h2>Add a custom filament</h2>
      <p class="muted tiny">For other brands, or a Bambu colour that isn't in the list. Tip: match the colour from a photo of a printed sample in daylight, not the spool label.</p>
      <div class="form row gap wrap">
        <label>Colour <input type="color" data-cc value="#E86A92"></label>
        <label>Name <input data-cn placeholder="e.g. Elegoo peach"></label>
        <label>Type <input data-ct list="types-list" value="PLA Basic"></label>
        <label>Price for 1 kg <input data-cp type="number" step="0.01" placeholder="optional"></label>
        <button class="btn" data-cadd-have>I have it</button><button class="btn ghost" data-cadd-want>I want it</button>
      </div>
    </section>`;

  const card = s => {
    const c = el('div', { class: 'spool' });
    c.innerHTML = `<div class="spool-sw" style="background:${swatchCss(s.hex)};color:${inkFor(s.hex[0])}"><span>${esc(s.type)}</span></div>
      <div class="spool-body"><b>${esc(s.name)}</b>
      ${s.owned ? `<label class="tiny">Left <input type="number" min="0" step="10" value="${s.grams ?? 1000}" data-g> g</label>` : `<label class="tiny">Buy <input type="number" min="1" step="1" value="${s.qty || 1}" data-qty> × ${money(store.priceFor(s.type))}</label>`}
      <div class="row gap tiny-btns">${s.owned ? '<button data-used title="Move to the wish list">Used up</button>' : '<button data-got title="Move to my spools">Got it</button>'}<button data-del title="Remove">✕</button></div></div>`;
    c.querySelector('[data-g]')?.addEventListener('change', e => { s.grams = Math.max(0, +e.target.value || 0); store.save(); });
    c.querySelector('[data-qty]')?.addEventListener('change', e => { s.qty = Math.max(1, +e.target.value || 1); store.save(); });
    c.querySelector('[data-used]')?.addEventListener('click', () => { s.owned = false; s.grams = 0; store.save(); renderFilaments(); });
    c.querySelector('[data-got]')?.addEventListener('click', () => { s.owned = true; s.grams = 1000 * (s.qty || 1); store.save(); renderFilaments(); toast(`${s.name} moved to your spools`); });
    c.querySelector('[data-del]').addEventListener('click', () => { if (confirm(`Remove ${s.type} ${s.name}?`)) { store.removeSpool(s.id); renderFilaments(); } });
    return c;
  };
  owned.forEach(s => root.querySelector('[data-owned]').append(card(s)));
  want.forEach(s => root.querySelector('[data-want]').append(card(s)));

  const cat = root.querySelector('[data-cat]');
  const fill = () => {
    cat.innerHTML = '';
    const ql = browseQ.toLowerCase();
    const items = store.catalog().filter(c => (browseType === '*' || c.type === browseType) && (!ql || (c.name + ' ' + c.type).toLowerCase().includes(ql)));
    for (const c of items) {
      const mine = store.findSpool(c.type, c.name);
      const d = el('div', { class: 'cat' + (mine ? (mine.owned ? ' have' : ' want') : '') });
      d.innerHTML = `<div class="cat-sw" style="background:${swatchCss(c.hex)}">${mine ? `<span class="badge">${mine.owned ? '✓ have' : '♡ want'}</span>` : ''}</div>
        <div class="cat-t"><b>${esc(c.name)}</b><small>${esc(c.type)} · ${money(store.priceFor(c.type))}</small></div>
        <div class="cat-btns"><button data-h>Have</button><button data-w>Want</button></div>`;
      d.querySelector('[data-h]').onclick = () => { const s = store.addSpool(c, true); s.owned = true; s.grams = s.grams || 1000; store.save(); renderFilaments(); toast(`Added ${c.name} to your spools`); };
      d.querySelector('[data-w]').onclick = () => { store.addSpool(c, false); renderFilaments(); toast(`${c.name} is on your wish list`); };
      cat.append(d);
    }
    if (!items.length) cat.innerHTML = '<p class="muted">No matches.</p>';
  };
  root.querySelector('[data-type]').onchange = e => { browseType = e.target.value; fill(); };
  root.querySelector('[data-q]').oninput = e => { browseQ = e.target.value; fill(); };
  fill();

  const addCustom = owned => {
    const hex = root.querySelector('[data-cc]').value.toUpperCase();
    const name = root.querySelector('[data-cn]').value.trim();
    const type = root.querySelector('[data-ct]').value.trim() || 'PLA';
    if (!name) return toast('Give it a name first');
    const s = store.addSpool({ type, name, hex: [hex], custom: true }, owned);
    const p = parseFloat(root.querySelector('[data-cp]').value);
    if (p > 0 && !store.state().prices[type]) { store.state().prices[type] = p; store.save(); }
    renderFilaments(); toast(`Added ${s.name}`);
  };
  root.querySelector('[data-cadd-have]').onclick = () => addCustom(true);
  root.querySelector('[data-cadd-want]').onclick = () => addCustom(false);
  root.querySelector('[data-backup]').onclick = () => download(`filament-library-${new Date().toISOString().slice(0, 10)}.json`, store.exportLibrary(), 'application/json');
  root.querySelector('[data-restore]').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { store.importLibrary(await f.text()); renderFilaments(); toast('Backup loaded'); } catch { toast('That file is not a filament backup'); }
  };
}

/* ---------------- Shopping ---------------- */
export function renderShop() {
  const root = document.getElementById('page-shop');
  const S = store.state();
  const lines = [];
  for (const s of S.spools.filter(s => !s.owned)) lines.push({ s, qty: s.qty || 1, why: 'Wish list' });
  // Spools you have, but a design needs more than is left.
  const need = {};
  for (const n of designNeeds) { if (!n.spool) continue; need[n.spool.id] = (need[n.spool.id] || { spool: n.spool, grams: 0, from: new Set() }); need[n.spool.id].grams += n.grams; need[n.spool.id].from.add(n.from); }
  for (const { spool, grams, from } of Object.values(need)) {
    if (!spool.owned) continue;
    const short = grams - (spool.grams ?? 0);
    if (short > 0) lines.push({ s: spool, qty: Math.ceil(short / 1000), why: `Need ~${Math.round(grams)} g for the ${[...from].join(' + ')}, ${Math.round(spool.grams ?? 0)} g left` });
  }
  const spoolCount = lines.reduce((a, l) => a + l.qty, 0);
  const sub = lines.reduce((a, l) => a + l.qty * store.priceFor(l.s.type), 0);
  const disc = sub * (S.bulkPct || 0) / 100;
  const total = sub - disc + (lines.length ? +S.shipping || 0 : 0);
  const types = [...new Set([...lines.map(l => l.s.type), ...S.spools.map(s => s.type)])].sort();

  root.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>Shopping list</h2><span class="muted tiny">${spoolCount} spool${spoolCount === 1 ? '' : 's'}</span></div>
      ${lines.length ? '' : '<p class="muted">Nothing to buy. Add colours to your wish list on the Filaments page, or choose colours you don\'t have when recolouring or painting.</p>'}
      <div class="shop-list" data-list></div>
      ${lines.length ? `<div class="totals">
        <div><span>Subtotal</span><b>${money(sub)}</b></div>
        ${disc ? `<div><span>Discount (${S.bulkPct}%)</span><b>−${money(disc)}</b></div>` : ''}
        ${+S.shipping ? `<div><span>Shipping</span><b>${money(+S.shipping)}</b></div>` : ''}
        <div class="grand"><span>Estimated total (AUD)</span><b>${money(total)}</b></div></div>
        <div class="row gap wrap"><button class="btn" data-copy>Copy list</button><a class="btn ghost" href="https://au.store.bambulab.com/collections/bambu-lab-3d-printer-filament" target="_blank" rel="noopener">Open the Bambu AU store</a></div>` : ''}
      <p class="muted tiny">Prices are the Bambu AU store's normal prices (checked ${store.PRICES_CHECKED}), mostly for a 1 kg refill. The store often runs bulk sales (Black Friday 2026: $13.19 a spool for 10+), so check before you buy, and set the bulk discount or fix a price below so the totals stay right. A few specialty filaments come in smaller spools.</p>
    </section>
    <section class="card">
      <h2>Prices and options</h2>
      <div class="form row gap wrap">
        <label class="check"><input type="checkbox" data-refill ${S.addReels ? 'checked' : ''}> I need reels too (not just refills)</label>
        <label>A reel adds $<input type="number" step="0.5" min="0" value="${S.reelCost}" data-rs style="width:5em"></label>
        <label>Bulk discount <input type="number" step="1" min="0" max="80" value="${S.bulkPct}" data-bulk style="width:4em">%</label>
        <label>Shipping $<input type="number" step="0.5" min="0" value="${S.shipping}" data-ship style="width:5em"></label>
        <label>AMS slots <input type="number" min="1" max="16" value="${S.amsSlots}" data-ams style="width:4em"></label>
      </div>
      <table class="price-table"><thead><tr><th>Type</th><th>Normal price (AUD)</th><th></th></tr></thead><tbody data-prices></tbody></table>
      <details><summary>All other types</summary><table class="price-table"><tbody data-prices-all></tbody></table></details>
    </section>`;

  const list = root.querySelector('[data-list]');
  for (const l of lines) {
    const r = el('div', { class: 'shop-line' });
    r.innerHTML = `<span class="sw big" style="background:${swatchCss(l.s.hex)}"></span>
      <div class="grow"><b>${esc(l.s.type)} · ${esc(l.s.name)}</b><small class="muted">${esc(l.why)}</small></div>
      <span class="qty">${l.qty} × ${money(store.priceFor(l.s.type))}</span><b>${money(l.qty * store.priceFor(l.s.type))}</b>
      <a class="btn ghost small" href="${store.storeLink(l.s)}" target="_blank" rel="noopener">Find in store</a>`;
    list.append(r);
  }
  const priceRow = t => {
    const tr = el('tr');
    const custom = S.prices[t] != null;
    tr.innerHTML = `<td>${esc(t)}</td><td><input type="number" step="0.01" min="0" value="${store.basePrice(t)}" style="width:6em"></td><td>${custom ? '<button class="link" data-reset>use my estimate</button>' : `<span class="muted tiny">${/\* est/.test(store.priceNote(t)) ? 'my guess' : 'store price'}</span>`}</td>`;
    tr.querySelector('input').onchange = e => { S.prices[t] = Math.max(0, +e.target.value || 0); store.save(); renderShop(); };
    tr.querySelector('[data-reset]')?.addEventListener('click', () => { delete S.prices[t]; store.save(); renderShop(); });
    return tr;
  };
  types.forEach(t => root.querySelector('[data-prices]').append(priceRow(t)));
  if (!types.length) root.querySelector('[data-prices]').innerHTML = '<tr><td colspan="3" class="muted">Types you own or want show here.</td></tr>';
  store.TYPES.filter(t => !types.includes(t)).forEach(t => root.querySelector('[data-prices-all]').append(priceRow(t)));

  const num = (sel, key, f = Number) => root.querySelector(sel).onchange = e => { S[key] = f(e.target.value); store.save(); renderShop(); };
  root.querySelector('[data-refill]').onchange = e => { S.addReels = e.target.checked; store.save(); renderShop(); };
  num('[data-rs]', 'reelCost', v => Math.max(0, +v || 0));
  num('[data-bulk]', 'bulkPct', v => Math.min(80, Math.max(0, +v || 0)));
  num('[data-ship]', 'shipping', v => Math.max(0, +v || 0));
  num('[data-ams]', 'amsSlots', v => Math.min(16, Math.max(1, Math.round(+v) || 4)));
  root.querySelector('[data-copy]')?.addEventListener('click', () => {
    const text = lines.map(l => `${l.qty} × Bambu ${l.s.type} – ${l.s.name}${S.addReels ? ' (with reel)' : ' (refill)'}  ${money(l.qty * store.priceFor(l.s.type))}`).join('\n') + `\nEstimated total: ${money(total)} AUD`;
    navigator.clipboard.writeText(text).then(() => toast('Copied'));
  });
}
