// "Choose a filament" pop-up: your spools, your wish list, the whole Bambu range, or a custom colour.
import * as store from './store.js';
import { swatchCss, matchWords } from './colour.js';
import { el, esc } from './ui.js';

let lastTab = 'mine';
let lastType = 'PLA Basic';

export function pickFilament({ title = 'Choose a filament', near = null, allowNone = false, noneLabel = 'Keep as it is' } = {}) {
  return new Promise(resolve => {
    const S = store.state();
    const dlg = el('div', { class: 'modal-back' });
    const box = el('div', { class: 'modal' });
    dlg.append(box);
    const close = v => { dlg.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') close(undefined); };
    document.addEventListener('keydown', onKey);
    dlg.addEventListener('pointerdown', e => { if (e.target === dlg) close(undefined); });

    let tab = S.spools.some(s => s.owned) ? lastTab : 'bambu';
    let q = '';

    const render = () => {
      const tabs = [['mine', 'My spools'], ['want', 'Wish list'], ['bambu', 'Bambu store'], ['custom', 'Custom colour']];
      box.innerHTML = `
        <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-x>✕</button></div>
        ${near ? `<div class="near-row"><span class="sw big" style="background:${near}"></span><div><b>Closest to this colour</b><div class="near-list"></div></div></div>` : ''}
        <div class="tabs small">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
        <div class="modal-body"></div>
        ${allowNone ? `<div class="modal-foot"><button class="btn ghost" data-none>${esc(noneLabel)}</button></div>` : ''}`;
      box.querySelector('[data-x]').onclick = () => close(undefined);
      box.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = lastTab = b.dataset.tab; render(); });
      if (allowNone) box.querySelector('[data-none]').onclick = () => close(null);
      if (near) {
        const nl = box.querySelector('.near-list');
        for (const { f, d } of store.nearest(near, 'all', 5)) {
          const b = chip(f, `${matchWords(d)}${f.id ? (f.owned ? ' · have' : ' · wish list') : ''}`);
          b.onclick = () => close(f.id ? f : store.addSpool(f, false));
          nl.append(b);
        }
      }
      const body = box.querySelector('.modal-body');
      if (tab === 'mine' || tab === 'want') {
        const list = S.spools.filter(s => s.owned === (tab === 'mine'));
        if (!list.length) body.innerHTML = `<p class="muted">${tab === 'mine' ? 'No spools yet. Add the ones you have on the Filaments page, or pick from the Bambu store tab.' : 'Nothing on your wish list yet.'}</p>`;
        const grid = el('div', { class: 'chip-grid' });
        for (const s of list) { const b = chip(s, s.owned ? `${s.grams ?? '?'} g left` : 'wish list'); b.onclick = () => close(s); grid.append(b); }
        body.append(grid);
      } else if (tab === 'bambu') {
        body.innerHTML = `<div class="row gap"><select data-type>${store.TYPES.map(t => `<option ${t === lastType ? 'selected' : ''}>${esc(t)}</option>`).join('')}<option value="*" ${lastType === '*' ? 'selected' : ''}>All types</option></select>
          <input data-q placeholder="Search colours" value="${esc(q)}"></div><p class="muted tiny">Picking one you don't have adds it to your wish list.</p><div class="chip-grid"></div>`;
        const grid = body.querySelector('.chip-grid');
        const fill = () => {
          grid.innerHTML = '';
          const ql = q.toLowerCase();
          const items = store.catalog().filter(c => (lastType === '*' || c.type === lastType) && (!ql || (c.name + ' ' + c.type).toLowerCase().includes(ql)));
          for (const c of items.slice(0, 400)) {
            const mine = store.findSpool(c.type, c.name);
            const b = chip(c, mine ? (mine.owned ? 'have' : 'wish list') : c.type);
            b.onclick = () => close(mine || store.addSpool(c, false));
            grid.append(b);
          }
          if (!items.length) grid.innerHTML = '<p class="muted">No matches.</p>';
        };
        body.querySelector('[data-type]').onchange = e => { lastType = e.target.value; fill(); };
        body.querySelector('[data-q]').oninput = e => { q = e.target.value; fill(); };
        fill();
      } else {
        body.innerHTML = `<div class="form">
          <label>Colour <input type="color" data-c value="${near || '#e86a92'}"></label>
          <label>Name <input data-n placeholder="e.g. Sunlu peach"></label>
          <label>Type <input data-t list="types-list" value="PLA Basic"></label>
          <label class="check"><input type="checkbox" data-o checked> I have this one</label>
          <button class="btn" data-add>Use this colour</button></div>`;
        body.querySelector('[data-add]').onclick = () => {
          const hex = body.querySelector('[data-c]').value.toUpperCase();
          const name = body.querySelector('[data-n]').value.trim() || hex;
          const type = body.querySelector('[data-t]').value.trim() || 'PLA';
          close(store.addSpool({ type, name, hex: [hex], custom: true }, body.querySelector('[data-o]').checked));
        };
      }
    };
    render();
    document.body.append(dlg);
  });
}

export function chip(f, sub = '') {
  const b = el('button', { class: 'chip' });
  b.innerHTML = `<span class="sw" style="background:${swatchCss(f.hex)}"></span><span class="chip-t"><b>${esc(f.name)}</b><small>${esc(sub || f.type)}</small></span>`;
  b.title = `${f.type} – ${f.name}`;
  return b;
}
