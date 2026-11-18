// Shared by the command palette and the /search/ page.
export interface SearchItem {
  id: string;
  title: string;
  description: string;
  category: string;
  categorySlug: string;
  short: string;
  accent: string;
  tags: string[];
  date: string;
  mins: number;
  api?: string;
  text: string;
  thumb?: { src: string; w: number; h: number } | null;
  level?: { first: string; last: string; label: string } | null;
}

let cache: Promise<SearchItem[]> | null = null;

/** Fetch the search index once. A failed attempt is not cached, so retrying works. */
export function loadIndex(): Promise<SearchItem[]> {
  cache ??= fetch('/search.json', { headers: { Accept: 'application/json' } })
    .then((r) => {
      if (!r.ok) throw new Error(`search.json ${r.status}`);
      return r.json() as Promise<SearchItem[]>;
    })
    .catch((err) => {
      cache = null;
      throw err;
    });
  return cache;
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const toTerms = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

interface Hay { t: string; tw: string[]; d: string; tags: string[]; x: string }
const hay = new WeakMap<SearchItem, Hay>();
function hayFor(it: SearchItem): Hay {
  let h = hay.get(it);
  if (!h) {
    const t = it.title.toLowerCase();
    h = { t, tw: t.split(/[^a-z0-9+#.]+/).filter(Boolean), d: it.description.toLowerCase(), tags: it.tags.map((x) => x.toLowerCase()), x: it.text.toLowerCase() };
    hay.set(it, h);
  }
  return h;
}

function score(it: SearchItem, terms: string[]): number {
  const h = hayFor(it);
  let total = 0;
  for (const w of terms) {
    let s = 0;
    if (h.tw.some((x) => x.startsWith(w))) s += 12;
    else if (h.t.includes(w)) s += 7;
    if (h.tags.includes(w)) s += 10;
    else if (h.tags.some((t) => t.includes(w))) s += 5;
    if (h.d.includes(w)) s += 4;
    if (h.x.includes(w)) s += 1;
    if (!s) return 0; // every term must match somewhere
    total += s;
  }
  if (terms.length > 1 && h.t.includes(terms.join(' '))) total += 15;
  return total;
}

/** Filter by track (category slug) and rank by relevance. With no query, keeps the index order (newest first). */
export function search(items: SearchItem[], query: string, cat = ''): SearchItem[] {
  const pool = cat ? items.filter((i) => i.categorySlug === cat) : items;
  const terms = toTerms(query);
  if (!terms.length) return pool;
  return pool
    .map((it, i) => ({ it, i, s: score(it, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.it);
}

/** Escape `text` and wrap matches of `terms` in <mark>. */
export function highlight(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  if (!terms.length || lower.length !== text.length) return escapeHtml(text);
  const ranges: [number, number][] = [];
  for (const t of terms) {
    let i = 0;
    while ((i = lower.indexOf(t, i)) !== -1) { ranges.push([i, i + t.length]); i += t.length; }
  }
  if (!ranges.length) return escapeHtml(text);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  let out = '';
  let pos = 0;
  for (const [s, e] of merged) {
    out += escapeHtml(text.slice(pos, s)) + '<mark class="hit">' + escapeHtml(text.slice(s, e)) + '</mark>';
    pos = e;
  }
  return out + escapeHtml(text.slice(pos));
}

const dateFmt = new Intl.DateTimeFormat('en-IN', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' });
export const formatDate = (iso: string) => dateFmt.format(new Date(iso));
const safeColor = (c: string) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : '#4d7cff');

/** Same markup as the server-rendered ArticleCard (default variant), so results look identical to the rest of the site. */
export function cardHtml(it: SearchItem, terms: string[]): string {
  const media = it.thumb
    ? `<img class="cover-img" src="${escapeHtml(it.thumb.src)}" width="${it.thumb.w}" height="${it.thumb.h}" alt="" loading="lazy" decoding="async">`
    : `<div class="cover-art"><span class="cover-art__grid" aria-hidden="true"></span><span class="cover-art__label">${escapeHtml(it.short)}</span></div>`;
  const lvl = it.level ? `<span class="level" data-lv="${escapeHtml(it.level.first)}" data-lv-max="${escapeHtml(it.level.last)}"><span class="level__bars" aria-hidden="true"><i></i><i></i><i></i></span>${escapeHtml(it.level.label)}</span>` : '';
  return (
    `<article class="card card--default in" style="--c:${safeColor(it.accent)}" data-spot data-tilt>` +
    `<div class="card__media">${media}${lvl}</div>` +
    `<div class="card__body"><div class="card__top"><span class="tag"><i class="dot"></i>${escapeHtml(it.short)}</span><span class="card__time">${it.mins} min</span></div>` +
    `<h2 class="card__title"><a href="/articles/${encodeURIComponent(it.id)}/">${highlight(it.title, terms)}</a></h2>` +
    `<p class="card__desc">${highlight(it.description, terms)}</p>` +
    `<div class="card__foot"><time datetime="${escapeHtml(it.date)}">${formatDate(it.date)}</time><span class="card__go" aria-hidden="true">Read →</span></div>` +
    `</div></article>`
  );
}
