import * as store from './store.js';
import { renderFilaments, renderShop } from './library.js';
import { renderRecolour } from './recolour.js';
import { renderStudio } from './studio.js';

const pages = { filaments: renderFilaments, shop: renderShop, recolour: renderRecolour, paint: renderStudio };
const ids = { filaments: 'page-filaments', shop: 'page-shop', recolour: 'page-recolour', paint: 'page-studio' };

function route() {
  let p = location.hash.slice(1) || (store.state().spools.length ? 'paint' : 'filaments');
  if (!pages[p]) p = 'filaments';
  for (const [k, id] of Object.entries(ids)) document.getElementById(id).classList.toggle('on', k === p);
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + p));
  document.body.dataset.page = p;
  pages[p]();
  updateBadge();
}
function updateBadge() {
  const n = store.state().spools.filter(s => !s.owned).length;
  const b = document.querySelector('[data-shopcount]');
  b.textContent = n || '';
  b.hidden = !n;
}
store.onChange(updateBadge);
window.addEventListener('hashchange', route);

// datalist of types for the custom forms
const dl = document.getElementById('types-list');
dl.innerHTML = store.TYPES.map(t => `<option value="${t}">`).join('');
route();
