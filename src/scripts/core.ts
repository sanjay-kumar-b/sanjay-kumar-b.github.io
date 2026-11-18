// Runs on every page: theme, mobile menu, header, reveal-on-scroll, card tilt/spotlight, magnetic buttons,
// counters, back-to-top, search shortcuts. Everything here is progressive enhancement: the pages work without it.
import { frame, isTyping, reduced, finePointer, clamp } from './util';

const root = document.documentElement;

/* ---------- Theme ---------- */
const THEME_COLOR = { dark: '#04060f', light: '#f4f6fd' };
function applyThemeUi() {
  const light = root.getAttribute('data-theme') === 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? THEME_COLOR.light : THEME_COLOR.dark);
  document.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((b) => b.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme'));
  window.dispatchEvent(new CustomEvent('themechange'));
}
function setTheme(next: 'light' | 'dark', x: number, y: number) {
  const apply = () => {
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch { /* storage unavailable: theme still applies for this visit */ }
    applyThemeUi();
  };
  const start = (document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> } }).startViewTransition;
  if (!start || reduced()) { apply(); return; }
  try {
    const t = start.call(document, apply);
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    t.ready
      .then(() => root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 620, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', pseudoElement: '::view-transition-new(root)' },
      ))
      .catch(() => {});
  } catch {
    apply();
  }
}
applyThemeUi();
document.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((b) =>
  b.addEventListener('click', (e) => {
    const rect = b.getBoundingClientRect();
    const x = e.clientX || rect.left + rect.width / 2;
    const y = e.clientY || rect.top + rect.height / 2;
    setTheme(root.getAttribute('data-theme') === 'light' ? 'dark' : 'light', x, y);
  }),
);

/* ---------- Mobile menu (full-screen panel, scroll lock, focus trap) ---------- */
const menuBtn = document.querySelector<HTMLButtonElement>('[data-menu-btn]');
const mnav = document.querySelector<HTMLElement>('[data-mnav]');
const isOpen = () => !!mnav?.hasAttribute('data-open');
function setMenu(open: boolean, restoreFocus = true) {
  if (!menuBtn || !mnav) return;
  mnav.toggleAttribute('data-open', open);
  root.classList.toggle('menu-open', open);
  menuBtn.setAttribute('aria-expanded', String(open));
  menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  if (open) mnav.querySelector<HTMLElement>('a, button')?.focus({ preventScroll: true });
  else if (restoreFocus) menuBtn.focus({ preventScroll: true });
}
if (menuBtn && mnav) {
  menuBtn.addEventListener('click', () => setMenu(!isOpen()));
  mnav.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('a')) setMenu(false, false);
    else if (t === mnav || t.classList.contains('mnav__inner')) setMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') { setMenu(false); return; }
    if (e.key !== 'Tab') return;
    // Keep Tab inside the open menu (plus the button that closes it).
    const items = [menuBtn, ...mnav.querySelectorAll<HTMLElement>('a[href], button')];
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  });
  // Leaving the mobile layout must never leave the menu stuck open.
  matchMedia('(min-width: 901px)').addEventListener('change', (m) => { if (m.matches && isOpen()) setMenu(false, false); });
  // Browser back/forward restores pages from cache: make sure the scroll lock does not survive that.
  window.addEventListener('pageshow', () => { if (!isOpen()) root.classList.remove('menu-open'); });
}

/* ---------- Header: elevated state + sliding nav indicator ---------- */
const header = document.querySelector<HTMLElement>('[data-header]');
if (header) {
  const update = frame(() => header.toggleAttribute('data-scrolled', window.scrollY > 8));
  window.addEventListener('scroll', update, { passive: true });
  update();
}
const nav = document.querySelector<HTMLElement>('[data-nav]');
const ind = document.querySelector<HTMLElement>('[data-nav-ind]');
if (nav && ind) {
  const links = [...nav.querySelectorAll<HTMLAnchorElement>('a')];
  const place = (el: HTMLElement | null) => {
    if (!el) { ind.style.opacity = '0'; return; }
    ind.style.opacity = '1';
    ind.style.setProperty('--x', `${el.offsetLeft}px`);
    ind.style.setProperty('--w', `${el.offsetWidth}px`);
  };
  const current = () => links.find((l) => l.getAttribute('aria-current') === 'page') ?? null;
  const rest = () => place(current());
  links.forEach((l) => {
    l.addEventListener('pointerenter', () => place(l));
    l.addEventListener('focus', () => place(l));
    l.addEventListener('blur', rest);
  });
  nav.addEventListener('pointerleave', rest);
  // First placement without a slide-in animation.
  ind.style.transition = 'none';
  rest();
  requestAnimationFrame(() => requestAnimationFrame(() => { ind.style.transition = ''; }));
  window.addEventListener('resize', frame(rest));
  void document.fonts?.ready.then(rest);
}

/* ---------- Reveal on scroll ---------- */
const reveals = [...document.querySelectorAll<HTMLElement>('[data-reveal]')];
if (reveals.length) {
  if (reduced() || !('IntersectionObserver' in window)) {
    reveals.forEach((el) => el.classList.add('in'));
  } else {
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) { (en.target as HTMLElement).classList.add('in'); io.unobserve(en.target); }
      }
    }, { rootMargin: '0px 0px -5% 0px', threshold: 0.06 });
    reveals.forEach((el) => io.observe(el));
    // Fail-safe: anything already on screen after a moment is shown, whatever the observer did.
    window.setTimeout(() => {
      for (const el of reveals) {
        if (el.classList.contains('in')) continue;
        const r = el.getBoundingClientRect();
        if (r.top < innerHeight && r.bottom > 0) el.classList.add('in');
      }
    }, 1600);
  }
}

/* ---------- Pointer effects: spotlight, tilt, magnetic buttons, cursor glow (real mouse only) ---------- */
if (finePointer() && !reduced()) {
  let cur: HTMLElement | null = null;
  const resetTilt = (el: HTMLElement | null) => { el?.style.removeProperty('--rx'); el?.style.removeProperty('--ry'); };
  const paint = frame((el: HTMLElement, x: number, y: number) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${x - r.left}px`);
    el.style.setProperty('--my', `${y - r.top}px`);
    if (el.hasAttribute('data-tilt') && r.width && r.height) {
      const px = clamp((x - r.left) / r.width, 0, 1) - 0.5;
      const py = clamp((y - r.top) / r.height, 0, 1) - 0.5;
      el.style.setProperty('--ry', `${(px * 6).toFixed(2)}deg`);
      el.style.setProperty('--rx', `${(-py * 6).toFixed(2)}deg`);
    }
  });
  const glow = document.querySelector<HTMLElement>('[data-cursor-glow]');
  const moveGlow = frame((x: number, y: number) => {
    if (!glow) return;
    glow.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    glow.setAttribute('data-on', '');
  });
  let magnet: HTMLElement | null = null;
  const pull = frame((el: HTMLElement, x: number, y: number) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--tx', `${clamp((x - (r.left + r.width / 2)) * 0.18, -8, 8).toFixed(1)}px`);
    el.style.setProperty('--ty', `${clamp((y - (r.top + r.height / 2)) * 0.25, -6, 6).toFixed(1)}px`);
  });
  const release = (el: HTMLElement | null) => { el?.style.removeProperty('--tx'); el?.style.removeProperty('--ty'); };

  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    moveGlow(e.clientX, e.clientY);
    const t = e.target as HTMLElement | null;
    const el = t?.closest?.<HTMLElement>('[data-spot]') ?? null;
    if (cur && cur !== el) resetTilt(cur);
    cur = el;
    if (el) paint(el, e.clientX, e.clientY);
    const m = t?.closest?.<HTMLElement>('[data-magnet]') ?? null;
    if (magnet && magnet !== m) release(magnet);
    magnet = m;
    if (m) pull(m, e.clientX, e.clientY);
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { resetTilt(cur); release(magnet); cur = null; magnet = null; glow?.removeAttribute('data-on'); });
  // Cards move under a still pointer while scrolling: drop the tilt instead of leaving a stale one behind.
  window.addEventListener('scroll', frame(() => { resetTilt(cur); cur = null; }), { passive: true });
}

/* ---------- Counters ---------- */
const counters = [...document.querySelectorAll<HTMLElement>('[data-count]')];
if (counters.length) {
  const run = (el: HTMLElement) => {
    const to = Number(el.dataset.count);
    if (!Number.isFinite(to)) return;
    const t0 = performance.now();
    const dur = 1100;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))).toLocaleString('en-US');
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  if (reduced() || !('IntersectionObserver' in window)) {
    counters.forEach((el) => { el.textContent = Number(el.dataset.count).toLocaleString('en-US'); });
  } else {
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { run(en.target as HTMLElement); io.unobserve(en.target); }
    }, { threshold: 0.4 });
    counters.forEach((el) => { el.textContent = '0'; io.observe(el); });
  }
}

/* ---------- Back to top (with a progress ring) ---------- */
const totop = document.querySelector<HTMLButtonElement>('[data-totop]');
if (totop) {
  const bar = totop.querySelector<SVGCircleElement>('.totop__bar');
  const upd = frame(() => {
    const max = document.documentElement.scrollHeight - innerHeight;
    const p = max > 0 ? clamp(scrollY / max, 0, 1) : 0;
    totop.toggleAttribute('data-show', scrollY > 700);
    bar?.style.setProperty('stroke-dashoffset', String(100 - p * 100));
  });
  window.addEventListener('scroll', upd, { passive: true });
  window.addEventListener('resize', upd);
  upd();
  totop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
    document.getElementById('main')?.focus?.({ preventScroll: true });
  });
}

/* ---------- Keyboard: "T" toggles the theme ---------- */
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 't' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTyping(e.target)) return;
  if (document.querySelector('dialog[open]') || isOpen()) return;
  document.querySelector<HTMLElement>('[data-theme-toggle]')?.click();
});

/* ---------- Search: open the palette from anywhere ---------- */
let palette: typeof import('./palette') | null = null;
async function openSearch() {
  try {
    palette ??= await import('./palette');
    palette.openPalette();
  } catch {
    location.href = '/search/'; // module failed to load: the full search page still works
  }
}
document.querySelectorAll<HTMLElement>('[data-open-search]').forEach((el) => {
  el.addEventListener('click', (e) => { e.preventDefault(); if (isOpen()) setMenu(false, false); void openSearch(); });
  // Warm up the code and the index on intent, so the first open feels instant.
  const warm = () => { void import('./palette').then((m) => m.warmUp()).catch(() => {}); };
  el.addEventListener('pointerenter', warm, { once: true });
  el.addEventListener('focus', warm, { once: true });
});
document.addEventListener('keydown', (e) => {
  const isK = e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey);
  const isSlash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target);
  if (!isK && !isSlash) return;
  if (document.querySelector('dialog[open]:not([data-palette])')) return;
  const onSearchPage = !!document.getElementById('search-page-input');
  if (onSearchPage) { e.preventDefault(); document.getElementById('search-page-input')?.focus(); return; }
  const hero = document.getElementById('hs-input');
  if (hero && e.key === '/' && hero.getBoundingClientRect().top < innerHeight && hero.getBoundingClientRect().bottom > 0) { e.preventDefault(); hero.focus(); return; }
  e.preventDefault();
  void openSearch();
});
