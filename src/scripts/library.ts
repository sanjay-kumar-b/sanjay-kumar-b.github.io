// Filter, sort and layout controls for a list of server-rendered cards (articles, category and tag pages).
// All cards are in the HTML already; this only hides, reorders and re-lays them out. State lives in the URL.
const grid = document.querySelector<HTMLElement>('[data-lib-grid]');
const toolbar = document.querySelector<HTMLElement>('[data-lib-toolbar]');

if (grid) {
  const items = [...grid.querySelectorAll<HTMLElement>('[data-lib-item]')];
  const q = document.querySelector<HTMLInputElement>('[data-lib-q]');
  const sortEl = document.querySelector<HTMLSelectElement>('[data-lib-sort]');
  const catBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-lib-cats] [data-v]')];
  const lvBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-lib-levels] [data-v]')];
  const viewBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-lib-view]')];
  const countEl = document.querySelector<HTMLElement>('[data-lib-count]');
  const empty = document.querySelector<HTMLElement>('[data-lib-empty]');

  const state = { q: '', cat: '', level: '', sort: 'new', view: 'grid' };
  const valid = (btns: HTMLButtonElement[], v: string) => btns.some((b) => (b.dataset.v ?? '') === v);

  // ----- read state from the URL (and the saved layout choice) -----
  const p = new URLSearchParams(location.search);
  state.q = (p.get('q') ?? '').slice(0, 120);
  const c = p.get('cat') ?? '';
  const l = p.get('level') ?? '';
  const s = p.get('sort') ?? '';
  state.cat = valid(catBtns, c) ? c : '';
  state.level = valid(lvBtns, l) ? l : '';
  state.sort = ['new', 'old', 'az', 'short', 'long'].includes(s) ? s : 'new';
  let savedView = '';
  try { savedView = localStorage.getItem('lib-view') ?? ''; } catch { /* storage unavailable */ }
  const v = p.get('view') ?? savedView;
  state.view = v === 'list' ? 'list' : 'grid';

  const num = (el: HTMLElement, k: string) => Number(el.dataset[k]) || 0;
  const sorters: Record<string, (a: HTMLElement, b: HTMLElement) => number> = {
    new: (a, b) => num(b, 'date') - num(a, 'date'),
    old: (a, b) => num(a, 'date') - num(b, 'date'),
    az: (a, b) => (a.dataset.title ?? '').localeCompare(b.dataset.title ?? ''),
    short: (a, b) => num(a, 'mins') - num(b, 'mins') || num(b, 'date') - num(a, 'date'),
    long: (a, b) => num(b, 'mins') - num(a, 'mins') || num(b, 'date') - num(a, 'date'),
  };
  // Stable base order = the order the server rendered (newest first), so ties never shuffle.
  const base = new Map(items.map((el, i) => [el, i]));
  let lastSort = '';

  function apply(write = true) {
    const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const el of items) {
      const hay = el.dataset.hay ?? '';
      const ok =
        (!state.cat || el.dataset.cat === state.cat) &&
        (!state.level || (el.dataset.levels ?? '').split(' ').includes(state.level)) &&
        terms.every((t) => hay.includes(t));
      el.hidden = !ok;
      if (ok) shown++;
    }
    if (state.sort !== lastSort) {
      const ordered = [...items].sort((a, b) => sorters[state.sort](a, b) || (base.get(a)! - base.get(b)!));
      const frag = document.createDocumentFragment();
      ordered.forEach((el) => frag.appendChild(el));
      // Keep the empty-state node last so it never ends up between cards.
      grid!.appendChild(frag);
      lastSort = state.sort;
    }
    grid!.classList.toggle('grid--list', state.view === 'list');
    if (empty) empty.hidden = shown !== 0;
    grid!.hidden = shown === 0;
    if (countEl) {
      const filtered = !!(state.q || state.cat || state.level);
      countEl.textContent = filtered ? `${shown} of ${items.length} ${items.length === 1 ? 'guide' : 'guides'}` : `${items.length} ${items.length === 1 ? 'guide' : 'guides'}`;
    }
    const press = (btns: HTMLButtonElement[], val: string) => btns.forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v ?? '') === val)));
    press(catBtns, state.cat);
    press(lvBtns, state.level);
    viewBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.libView === state.view)));
    if (q && q.value !== state.q) q.value = state.q;
    if (sortEl && sortEl.value !== state.sort) sortEl.value = state.sort;
    if (write) {
      const o = new URLSearchParams();
      if (state.q.trim()) o.set('q', state.q.trim());
      if (state.cat) o.set('cat', state.cat);
      if (state.level) o.set('level', state.level);
      if (state.sort !== 'new') o.set('sort', state.sort);
      if (state.view === 'list') o.set('view', 'list');
      const qs = o.toString();
      history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
    }
  }

  q?.addEventListener('input', () => { state.q = q.value; apply(); });
  sortEl?.addEventListener('change', () => { state.sort = sortEl.value; apply(); });
  catBtns.forEach((b) => b.addEventListener('click', () => { state.cat = b.dataset.v ?? ''; apply(); }));
  lvBtns.forEach((b) => b.addEventListener('click', () => { state.level = b.dataset.v ?? ''; apply(); }));
  viewBtns.forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.libView === 'list' ? 'list' : 'grid';
    try { localStorage.setItem('lib-view', state.view); } catch { /* storage unavailable */ }
    apply();
  }));
  document.querySelector('[data-lib-reset]')?.addEventListener('click', () => {
    Object.assign(state, { q: '', cat: '', level: '', sort: 'new' });
    apply();
    q?.focus();
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) apply(false); });

  // Without the toolbar (tiny lists) there is nothing to filter: leave the page exactly as rendered.
  if (toolbar) apply(false);
}
