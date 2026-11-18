// Generic accessible tabs for every [data-tabs] container (track explorer, learning paths).
// Panels are rendered on the server with all but the first hidden; without JavaScript they are all shown.
document.querySelectorAll<HTMLElement>('[data-tabs]').forEach((box) => {
  const tabs = [...box.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = [...box.querySelectorAll<HTMLElement>('[data-tabpanel]')];
  if (!tabs.length || tabs.length !== panels.length) return;
  const vertical = box.querySelector('[role="tablist"]')?.getAttribute('aria-orientation') === 'vertical';
  let idx = Math.max(0, tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true'));

  const select = (n: number, focus = false) => {
    idx = (n + tabs.length) % tabs.length;
    tabs.forEach((t, k) => { t.setAttribute('aria-selected', String(k === idx)); t.tabIndex = k === idx ? 0 : -1; });
    tabs.forEach((t, k) => t.toggleAttribute('data-passed', k <= idx));
    panels.forEach((p, k) => { p.hidden = k !== idx; });
    box.style.setProperty('--idx', String(idx));
    box.style.setProperty('--prog', String(tabs.length > 1 ? idx / (tabs.length - 1) : 0));
    if (focus) tabs[idx].focus();
  };
  tabs.forEach((t, k) => {
    t.addEventListener('click', () => select(k));
    t.addEventListener('keydown', (e) => {
      const next = vertical ? 'ArrowDown' : 'ArrowRight';
      const prev = vertical ? 'ArrowUp' : 'ArrowLeft';
      if (e.key === next) { e.preventDefault(); select(idx + 1, true); }
      else if (e.key === prev) { e.preventDefault(); select(idx - 1, true); }
      else if (e.key === 'Home') { e.preventDefault(); select(0, true); }
      else if (e.key === 'End') { e.preventDefault(); select(tabs.length - 1, true); }
    });
  });
  select(idx);
});
