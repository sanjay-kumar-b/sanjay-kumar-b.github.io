// Command-style search dialog, opened with "/" or Ctrl/Cmd+K, or from the header button.
import { loadIndex, search, toTerms, highlight, escapeHtml, type SearchItem } from './search-core';

const dlg = document.getElementById('palette') as HTMLDialogElement | null;
const input = document.getElementById('palette-input') as HTMLInputElement | null;
const list = document.getElementById('palette-list') as HTMLUListElement | null;
const group = document.getElementById('palette-group');
const allLink = dlg?.querySelector<HTMLAnchorElement>('[data-palette-all]') ?? null;

let items: SearchItem[] = [];
let state: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let active = -1;
let wired = false;

function load() {
  if (state === 'loading' || state === 'ready') return;
  state = 'loading';
  loadIndex()
    .then((data) => { items = data; state = 'ready'; })
    .catch(() => { state = 'error'; })
    .finally(() => { if (dlg?.open) render(); });
}

export function warmUp() { load(); }

function message(text: string, extra = '') {
  if (!list) return;
  list.innerHTML = `<li class="palette__empty" role="presentation">${text}${extra}</li>`;
  input?.removeAttribute('aria-activedescendant');
  active = -1;
}

function setActive(i: number) {
  if (!list || !input) return;
  const opts = list.querySelectorAll<HTMLElement>('[role="option"]');
  if (!opts.length) { active = -1; input.removeAttribute('aria-activedescendant'); return; }
  active = (i + opts.length) % opts.length;
  opts.forEach((o, n) => o.setAttribute('aria-selected', String(n === active)));
  const el = opts[active];
  input.setAttribute('aria-activedescendant', el.id);
  // Keep the active row visible inside the list only (never scroll the page).
  const top = el.offsetTop;
  const bottom = top + el.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top - 8;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 8;
}

function render() {
  if (!list || !input) return;
  const q = input.value.trim();
  if (allLink) allLink.href = q ? `/search/?q=${encodeURIComponent(q)}` : '/search/';
  if (state === 'loading' || state === 'idle') { if (group) group.textContent = 'Search'; return message('Loading the library…'); }
  if (state === 'error') {
    if (group) group.textContent = 'Search';
    return message('Search could not load.', ' <a href="/search/">Open the full search page</a>.');
  }
  const terms = toTerms(q);
  const results = search(items, q).slice(0, terms.length ? 8 : 6);
  if (group) group.textContent = terms.length ? `${results.length} ${results.length === 1 ? 'match' : 'matches'}` : 'Latest guides';
  if (!results.length) return message(`No guides match “${escapeHtml(q)}”. Try a broader word, like a topic or tag.`);
  list.innerHTML = results
    .map((it, i) =>
      `<li role="option" id="pal-opt-${i}" aria-selected="false"><a class="palette__item" href="/articles/${encodeURIComponent(it.id)}/" tabindex="-1">` +
      (it.thumb ? `<img class="palette__thumb" src="${escapeHtml(it.thumb.src)}" width="80" height="45" alt="" loading="lazy" decoding="async">` : '<span class="palette__thumb palette__thumb--none" aria-hidden="true"></span>') +
      `<span class="palette__txt"><span class="palette__title">${highlight(it.title, terms)}</span>` +
      `<span class="palette__sub"><span class="tag" style="--c:${/^#[0-9a-f]{3,8}$/i.test(it.accent) ? it.accent : '#4d7cff'}"><i class="dot"></i>${escapeHtml(it.short)}</span><span class="palette__desc">${highlight(it.description, terms)}</span></span></span>` +
      `</a></li>`)
    .join('');
  setActive(terms.length ? 0 : -1);
}

function wire() {
  if (wired || !dlg || !input || !list) return;
  wired = true;
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const a = active >= 0 ? list.querySelectorAll<HTMLAnchorElement>('[role="option"] a')[active] : null;
      if (a) location.href = a.href;
      else if (input.value.trim()) location.href = `/search/?q=${encodeURIComponent(input.value.trim())}`;
    }
  });
  list.addEventListener('mousemove', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]');
    if (!li) return;
    const idx = [...list.querySelectorAll('[role="option"]')].indexOf(li);
    if (idx !== active) setActive(idx);
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop click
  dlg.querySelector('[data-palette-close]')?.addEventListener('click', () => dlg.close());
}

export function openPalette() {
  if (!dlg || !input || typeof dlg.showModal !== 'function') { location.href = '/search/'; return; }
  wire();
  if (!dlg.open) dlg.showModal();
  input.value = '';
  load();
  render();
  input.focus();
}
