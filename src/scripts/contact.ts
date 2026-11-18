// Contact form: posts to the configured form service, or falls back to the visitor's email app.
const form = document.getElementById('contact-form') as HTMLFormElement | null;
const statusEl = document.getElementById('form-status');
const submit = form?.querySelector<HTMLButtonElement>('[type="submit"]');

function say(text: string, state: 'ok' | 'error' | '') {
  if (!statusEl) return;
  statusEl.textContent = text;
  if (state) statusEl.setAttribute('data-state', state);
  else statusEl.removeAttribute('data-state');
}

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const mail = form.dataset.mail ?? '';
  const endpoint = form.dataset.endpoint ?? '';

  // Honeypot: real people never fill this in. Pretend it worked, send nothing.
  if (data.get('_gotcha')) { say('Thanks, your message was sent.', 'ok'); form.reset(); return; }

  if (endpoint) {
    if (submit) submit.disabled = true;
    say('Sending…', '');
    try {
      const res = await fetch(endpoint, { method: 'POST', body: data, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      form.reset();
      say('Thanks, your message was sent. I will reply by email.', 'ok');
    } catch {
      say(`Your message could not be sent. Please email ${mail} directly.`, 'error');
    } finally {
      if (submit) submit.disabled = false;
    }
    return;
  }

  const body = `From: ${data.get('name')} (${data.get('email')})\n\n${data.get('message')}`;
  location.href = `mailto:${mail}?subject=${encodeURIComponent('Message from SF SKODE')}&body=${encodeURIComponent(body)}`;
  say(`Your email app should open with the message ready to send. If it does not, write to ${mail}.`, 'ok');
});

export {};
