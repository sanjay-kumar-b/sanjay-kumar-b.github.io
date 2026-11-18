/** Announce a message to screen readers via the polite live region in the layout. */
export function announce(message: string) {
  const el = document.getElementById('sr-status');
  if (!el) return;
  el.textContent = '';
  // Re-set on the next frame so repeating the same message is announced again.
  requestAnimationFrame(() => { el.textContent = message; });
}

/** Copy text to the clipboard. Falls back to a hidden textarea where the async API is unavailable (http, old browsers). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Run `fn` at most once per animation frame (for scroll/resize/pointer handlers). */
export function frame<T extends unknown[]>(fn: (...args: T) => void) {
  let queued = false;
  let last: T;
  return (...args: T) => {
    last = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...last); });
  };
}

export const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

/** True when the visitor asked the OS for less motion. Read at call time so a changed setting is respected. */
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** True for a real mouse/trackpad (hover-capable) device. */
export const finePointer = () => matchMedia('(hover: hover) and (pointer: fine)').matches;

/** Clamp a number between lo and hi. */
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Same as copyText, re-exported under the name the hero script uses. */
export const copyTextSafe = copyText;
