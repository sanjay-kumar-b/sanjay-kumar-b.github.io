// The /search/ page: live filtering with the query and track kept in the URL.
import { loadIndex, search, toTerms, cardHtml, type SearchItem } from './search-core';

const input = document.getElementById('search-page-input') as HTMLInputElement | null;
const out = document.getElementById('results');
const count = document.getElementById('count');
const filters = [...document.querySelectorAll<HTMLButtonElement>('#filters [data-cat]')];
const clear = document.querySelector<HTMLButtonElement>('[data-clear]');

let items: SearchItem[] = [];
let q = '';
let cat = '';

function readUrl() {
  const p = new URLSearchParams(location.search);
  q = (p.get('q') ?? '').slice(0, 200);
  const track = p.get('track') ?? '';
  cat = filters.some((f) => f.dataset.cat === track) ? track : '';
}

function writeUrl() {
  const p = new URLSearchParams();
  if (q.trim()) p.set('q', q.trim());
  if (cat) p.set('track', cat);
  const qs = p.toString();
  history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
}

function paintFilters() {
  filters.forEach((f) => f.setAttribute('aria-pressed', String((f.dataset.cat ?? '') === cat)));
}

function render() {
  if (!out || !count) return;
  const terms = toTerms(q);
  const list = search(items, q, cat);
  const n = list.length;
  if (clear) clear.hidden = !q;
  count.textContent = terms.length ? `${n} ${n === 1 ? 'result' : 'results'} for “${q.trim()}”` : `${n} ${n === 1 ? 'guide' : 'guides'}`;
  out.setAttribute('aria-busy', 'false');
  if (!n) {
    out.innerHTML = '<div class="empty"><h2>Nothing matched</h2><p>Try a broader word, a different spelling, or <a href="/categories/">browse by topic</a>.</p></div>';
    return;
  }
  out.innerHTML = list.map((it) => cardHtml(it, terms)).join('');
}

function showError() {
  if (!out || !count) return;
  count.textContent = '';
  out.setAttribute('aria-busy', 'false');
  out.innerHTML = '<div class="empty"><h2>Search isn\'t available right now</h2><p>The search index could not be loaded.</p><button class="btn" type="button" data-retry>Try again</button> <a class="btn" href="/articles/">Browse all articles</a></div>';
  out.querySelector('[data-retry]')?.addEventListener('click', start);
}

function start() {
  out?.setAttribute('aria-busy', 'true');
  loadIndex().then((data) => { items = data; render(); }).catch(showError);
}

if (input && out) {
  readUrl();
  input.value = q;
  paintFilters();
  input.addEventListener('input', () => { q = input.value; render(); writeUrl(); });
  clear?.addEventListener('click', () => { q = ''; input.value = ''; render(); writeUrl(); input.focus(); });
  filters.forEach((f) => f.addEventListener('click', () => { cat = f.dataset.cat ?? ''; paintFilters(); render(); writeUrl(); }));
  start();
}
