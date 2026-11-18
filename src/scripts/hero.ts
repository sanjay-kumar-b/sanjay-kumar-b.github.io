// Home page hero: constellation canvas, rotating headline word, code terminal, live search.
import { loadIndex, search, toTerms, highlight, escapeHtml, type SearchItem } from './search-core';
import { reduced, clamp, copyTextSafe } from './util';

const hero = document.querySelector<HTMLElement>('[data-hero]');

/* ====================== 1. Constellation canvas ====================== */
function initFx(canvas: HTMLCanvasElement, host: HTMLElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  interface P { x: number; y: number; vx: number; vy: number; r: number; alt: boolean }
  let w = 0, h = 0, dpr = 1;
  let nodes: P[] = [];
  let raf = 0;
  let inView = true;
  const ptr = { x: -9999, y: -9999, on: false };
  let rgb = '110,170,255';
  let rgb2 = '170,120,255';
  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    rgb = cs.getPropertyValue('--fx-rgb').trim() || rgb;
    rgb2 = cs.getPropertyValue('--fx-rgb2').trim() || rgb2;
  };

  const seed = (n: number) => {
    nodes = Array.from({ length: n }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.028, vy: (Math.random() - 0.5) * 0.028,
      r: 1 + Math.random() * 1.4, alt: Math.random() < 0.3,
    }));
  };
  const resize = () => {
    const nw = host.clientWidth, nh = host.clientHeight;
    if (!nw || !nh) return;
    const ow = w, oh = h;
    w = nw; h = nh;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const want = Math.round(clamp((w * h) / 21000, 22, 78));
    if (!nodes.length || Math.abs(nodes.length - want) > 8) seed(want);
    else if (ow && oh) for (const p of nodes) { p.x = (p.x / ow) * w; p.y = (p.y / oh) * h; }
    draw();
  };

  const LINK = 130;
  const PLINK = 190;
  function draw() {
    ctx!.clearRect(0, 0, w, h);
    ctx!.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > LINK * LINK) continue;
        const al = (1 - Math.sqrt(d2) / LINK) * 0.32;
        ctx!.strokeStyle = `rgba(${a.alt || b.alt ? rgb2 : rgb},${al.toFixed(3)})`;
        ctx!.beginPath(); ctx!.moveTo(a.x, a.y); ctx!.lineTo(b.x, b.y); ctx!.stroke();
      }
      if (ptr.on) {
        const dx = a.x - ptr.x, dy = a.y - ptr.y;
        const d = Math.hypot(dx, dy);
        if (d < PLINK) {
          ctx!.strokeStyle = `rgba(${rgb},${((1 - d / PLINK) * 0.6).toFixed(3)})`;
          ctx!.beginPath(); ctx!.moveTo(a.x, a.y); ctx!.lineTo(ptr.x, ptr.y); ctx!.stroke();
        }
      }
      ctx!.fillStyle = `rgba(${a.alt ? rgb2 : rgb},0.85)`;
      ctx!.beginPath(); ctx!.arc(a.x, a.y, a.r, 0, Math.PI * 2); ctx!.fill();
    }
  }

  let last = 0;
  function loop(t: number) {
    raf = 0;
    if (!inView || document.hidden) return;
    const dt = Math.min(50, t - last || 16);
    last = t;
    for (const p of nodes) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.x < -10) p.x = w + 10; else if (p.x > w + 10) p.x = -10;
      if (p.y < -10) p.y = h + 10; else if (p.y > h + 10) p.y = -10;
      if (ptr.on) {
        const dx = ptr.x - p.x, dy = ptr.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d < 150 && d > 1) { p.x += (dx / d) * 0.012 * dt; p.y += (dy / d) * 0.012 * dt; }
      }
    }
    draw();
    raf = requestAnimationFrame(loop);
  }
  const start = () => { if (!raf && !reduced() && inView && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(loop); } };

  readColors();
  new ResizeObserver(resize).observe(host);
  resize();
  host.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    ptr.x = e.clientX - r.left; ptr.y = e.clientY - r.top; ptr.on = true;
  }, { passive: true });
  host.addEventListener('pointerleave', () => { ptr.on = false; });
  new IntersectionObserver((en) => { inView = en[0]?.isIntersecting ?? true; if (inView) start(); }, { threshold: 0 }).observe(host);
  document.addEventListener('visibilitychange', start);
  window.addEventListener('themechange', () => { readColors(); if (!raf) draw(); });
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => { if (reduced()) { cancelAnimationFrame(raf); raf = 0; draw(); } else start(); });
  start();
}
const canvas = document.querySelector<HTMLCanvasElement>('[data-fx]');
if (canvas && hero) initFx(canvas, hero);

/* ====================== 2. Rotating headline word ====================== */
const rot = document.querySelector<HTMLElement>('[data-rot]');
if (rot) {
  const words = [...rot.querySelectorAll<HTMLElement>('.rot__w')];
  let i = 0;
  const fit = () => { const cur = words[i]; if (cur) rot.style.width = `${Math.ceil(cur.getBoundingClientRect().width)}px`; };
  // Measure with all words laid out in their natural size, then let the width follow the active word.
  const measure = () => { rot.style.width = ''; requestAnimationFrame(fit); };
  void document.fonts?.ready.then(measure);
  window.addEventListener('resize', measure);
  if (words.length > 1) {
    window.setInterval(() => {
      if (document.hidden || reduced()) return;
      const out = words[i];
      i = (i + 1) % words.length;
      const inn = words[i];
      out.removeAttribute('data-on'); out.setAttribute('data-out', ''); out.setAttribute('aria-hidden', 'true');
      inn.removeAttribute('data-out'); inn.setAttribute('data-on', ''); inn.removeAttribute('aria-hidden');
      fit();
      window.setTimeout(() => out.removeAttribute('data-out'), 700);
    }, 2600);
  }
}

/* ====================== 3. Code terminal ====================== */
const term = document.querySelector<HTMLElement>('[data-term]');
if (term) {
  const tabs = [...term.querySelectorAll<HTMLButtonElement>('[data-term-tab]')];
  const panels = [...term.querySelectorAll<HTMLElement>('[data-term-panel]')];
  const guides = [...term.querySelectorAll<HTMLElement>('[data-term-guide]')];
  const copyBtn = term.querySelector<HTMLButtonElement>('[data-term-copy]');
  let idx = 0;
  let auto = !reduced();
  let hover = false;

  const show = (n: number, focus = false) => {
    idx = (n + tabs.length) % tabs.length;
    const id = tabs[idx].dataset.termTab;
    tabs.forEach((t, k) => { t.setAttribute('aria-selected', String(k === idx)); t.tabIndex = k === idx ? 0 : -1; });
    panels.forEach((p) => {
      const on = p.dataset.termPanel === id;
      // Re-adding the attribute on a new frame replays the line-by-line reveal.
      if (on) { p.removeAttribute('data-active'); void p.offsetWidth; p.setAttribute('data-active', ''); }
      else p.removeAttribute('data-active');
    });
    guides.forEach((g) => g.toggleAttribute('data-active', g.dataset.termGuide === id));
    if (focus) tabs[idx].focus();
  };
  tabs.forEach((t, k) => {
    t.addEventListener('click', () => { auto = false; show(k); });
    t.addEventListener('keydown', (e) => {
      const map: Record<string, number> = { ArrowRight: idx + 1, ArrowLeft: idx - 1, Home: 0, End: tabs.length - 1 };
      if (e.key in map) { e.preventDefault(); auto = false; show(map[e.key], true); }
    });
  });
  term.addEventListener('pointerenter', () => { hover = true; });
  term.addEventListener('pointerleave', () => { hover = false; });
  term.addEventListener('focusin', () => { auto = false; });
  window.setInterval(() => {
    if (!auto || hover || document.hidden || !term.getBoundingClientRect().height) return;
    const r = term.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    show(idx + 1);
  }, 7000);

  let timer = 0;
  copyBtn?.addEventListener('click', async () => {
    const raw = panels.find((p) => p.hasAttribute('data-active'))?.dataset.raw ?? '';
    const ok = await copyTextSafe(raw);
    const label = copyBtn.querySelector('span');
    if (label) label.textContent = ok ? 'Copied' : 'Press Ctrl+C';
    copyBtn.toggleAttribute('data-done', ok);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { if (label) label.textContent = 'Copy'; copyBtn.removeAttribute('data-done'); }, 1800);
  });
}

/* ====================== 4. Live search ====================== */
const hs = document.querySelector<HTMLElement>('[data-hs]');
const input = document.getElementById('hs-input') as HTMLInputElement | null;
const list = document.getElementById('hs-list') as HTMLUListElement | null;
if (hs && input && list) {
  let items: SearchItem[] = [];
  let loaded = false;
  let active = -1;

  const open = (on: boolean) => { list.hidden = !on; input.setAttribute('aria-expanded', String(on)); hs.toggleAttribute('data-open', on); if (!on) { active = -1; input.removeAttribute('aria-activedescendant'); } };
  const setActive = (n: number) => {
    const opts = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    if (!opts.length) return;
    active = (n + opts.length) % opts.length;
    opts.forEach((o, k) => o.setAttribute('aria-selected', String(k === active)));
    input.setAttribute('aria-activedescendant', opts[active].id);
    opts[active].scrollIntoView({ block: 'nearest' });
  };
  const render = () => {
    const q = input.value.trim();
    const terms = toTerms(q);
    if (!loaded) { list.innerHTML = '<li class="hs__msg" role="presentation">Loading the library…</li>'; open(true); return; }
    const res = search(items, q).slice(0, terms.length ? 6 : 4);
    if (!res.length) { list.innerHTML = `<li class="hs__msg" role="presentation">No guides match “${escapeHtml(q)}”. Try a broader word.</li>`; open(true); return; }
    list.innerHTML = res.map((it, k) =>
      `<li role="option" id="hs-opt-${k}" aria-selected="false"><a class="hs__item" href="/articles/${encodeURIComponent(it.id)}/" tabindex="-1">` +
      (it.thumb ? `<img src="${escapeHtml(it.thumb.src)}" width="64" height="36" alt="" loading="lazy" decoding="async">` : '<span class="hs__noimg"></span>') +
      `<span class="hs__txt"><span class="hs__title">${highlight(it.title, terms)}</span><span class="hs__sub">${escapeHtml(it.short)} · ${it.mins} min</span></span></a></li>`).join('') +
      `<li class="hs__more" role="presentation"><a href="/search/${q ? `?q=${encodeURIComponent(q)}` : ''}" tabindex="-1">See all results<span aria-hidden="true"> →</span></a></li>`;
    open(true);
    setActive(terms.length ? 0 : -1);
  };
  const load = () => {
    if (loaded) return;
    loadIndex().then((d) => { items = d; loaded = true; if (document.activeElement === input) render(); }).catch(() => { /* the form still submits to /search/ */ });
  };

  input.addEventListener('focus', () => { load(); render(); });
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) render(); else setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Escape') { if (!list.hidden) { e.preventDefault(); open(false); } }
    else if (e.key === 'Enter' && active >= 0 && !list.hidden) {
      const a = list.querySelectorAll<HTMLAnchorElement>('[role="option"] a')[active];
      if (a) { e.preventDefault(); location.href = a.href; }
    }
  });
  // Pointer-down on a suggestion must not blur the field before the click lands.
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => { const a = (e.target as HTMLElement).closest('a'); if (a) location.href = (a as HTMLAnchorElement).href; });
  input.addEventListener('blur', () => window.setTimeout(() => open(false), 120));
  hs.querySelector('form')?.addEventListener('pointerenter', load, { once: true });
}
