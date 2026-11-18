// Article pages: reading progress, table-of-contents scroll-spy, copy buttons, heading anchors, text size.
import { copyText, announce, frame, clamp } from './util';

const prose = document.querySelector<HTMLElement>('[data-prose]');
const bar = document.querySelector<HTMLElement>('[data-progress]');
const meter = document.querySelector<HTMLElement>('[data-meter]');
const pct = document.querySelector<HTMLElement>('[data-pct]');

/* ---------- Heading anchors ---------- */
const heads = prose ? [...prose.querySelectorAll<HTMLElement>('h2[id], h3[id]')] : [];
for (const h of heads) {
  const a = document.createElement('a');
  a.className = 'anchor';
  a.href = `#${h.id}`;
  a.setAttribute('aria-label', 'Link to this section');
  a.textContent = '#';
  h.appendChild(a);
}

/* ---------- Progress + scroll-spy (one scroll handler, one frame) ---------- */
const links = new Map<string, HTMLAnchorElement[]>();
document.querySelectorAll<HTMLAnchorElement>('[data-toc-link]').forEach((a) => {
  const id = decodeURIComponent(a.hash.slice(1));
  const arr = links.get(id) ?? [];
  arr.push(a);
  links.set(id, arr);
});
const sideToc = document.querySelector<HTMLElement>('.toc--side');
let current = '';

/** Scroll `box` just enough to show `el`, without ever scrolling the page itself. */
function keepVisible(box: HTMLElement, el: HTMLElement) {
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < b.top + 8) box.scrollTop -= b.top + 8 - r.top;
  else if (r.bottom > b.bottom - 8) box.scrollTop += r.bottom - b.bottom + 8;
}

function update() {
  let p = 0;
  if (prose) {
    const r = prose.getBoundingClientRect();
    const total = Math.max(r.height - window.innerHeight * 0.6, 1);
    p = clamp(-r.top / total, 0, 1);
    if (bar) bar.style.transform = `scaleX(${p})`;
    if (meter) meter.style.transform = `scaleX(${p})`;
    if (pct) pct.textContent = `${Math.round(p * 100)}%`;
  }
  if (!heads.length || !links.size) return;
  const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 84;
  const line = header + 24;
  let id = '';
  for (const h of heads) {
    if (h.getBoundingClientRect().top <= line) id = h.id;
    else break;
  }
  if (id === current) return;
  current = id;
  links.forEach((arr, key) => arr.forEach((a) => {
    const on = key === id;
    a.toggleAttribute('data-active', on);
    if (on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
  }));
  const active = id ? links.get(id)?.find((a) => sideToc?.contains(a)) : undefined;
  if (active && sideToc) {
    const scroller = sideToc.querySelector<HTMLElement>('ul');
    if (scroller) keepVisible(scroller, active);
  }
}
const onScroll = frame(update);
window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', onScroll);
update();

/* ---------- Text size (saved per browser) ---------- */
const tools = document.querySelector<HTMLElement>('[data-reader-tools]');
if (tools) {
  tools.hidden = false;
  let level = 0;
  try { level = clamp(parseInt(localStorage.getItem('fs') ?? '0', 10) || 0, -2, 3); } catch { /* storage unavailable */ }
  const paint = () => document.documentElement.style.setProperty('--fs', String(1 + level * 0.07));
  paint();
  tools.querySelectorAll<HTMLButtonElement>('[data-fs]').forEach((b) =>
    b.addEventListener('click', () => {
      level = clamp(level + Number(b.dataset.fs), -2, 3);
      try { localStorage.setItem('fs', String(level)); } catch { /* ignore */ }
      paint();
      announce(`Text size ${level === 0 ? 'default' : level > 0 ? `plus ${level}` : `minus ${-level}`}`);
      onScroll();
    }),
  );
}

/* ---------- Copy buttons ---------- */
const timers = new WeakMap<HTMLElement, number>();
function flash(btn: HTMLElement, ok: boolean, idle: string, done: string) {
  const label = btn.querySelector('span') ?? btn;
  window.clearTimeout(timers.get(btn));
  label.textContent = ok ? done : 'Press Ctrl+C';
  btn.dataset.state = ok ? 'done' : 'error';
  timers.set(btn, window.setTimeout(() => { label.textContent = idle; delete btn.dataset.state; }, 1800));
}
prose?.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.code__copy');
  if (!btn) return;
  const text = btn.closest('.code')?.querySelector('pre')?.textContent ?? '';
  const ok = await copyText(text.replace(/\n$/, ''));
  flash(btn, ok, 'Copy', 'Copied');
  announce(ok ? 'Code copied to clipboard' : 'Copy failed. Select the code and press Ctrl+C.');
});
document.querySelectorAll<HTMLButtonElement>('[data-copy-link]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const ok = await copyText(btn.dataset.url ?? location.href);
    flash(btn, ok, 'Copy link', 'Link copied');
    announce(ok ? 'Link copied to clipboard' : 'Copy failed.');
  }),
);
