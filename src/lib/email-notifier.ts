// ---------------------------------------------------------------------------
// email-notifier.ts
// ---------------------------------------------------------------------------
// Thin wrapper around Resend's REST API. No SDK — fetch is enough, and
// keeping it SDK-free means zero new dependencies to maintain.
//
// Config:
//   RESEND_API_KEY           — Resend API key (starts with "re_")
//   EMAIL_FROM               — verified sender, e.g. "QualifyDMs <alerts@yourdomain.com>"
//                              Defaults to "QualifyDMs <onboarding@resend.dev>"
//                              for local / pre-DNS dev if unset.
//
// If RESEND_API_KEY is missing, sendEmail() logs a warning + returns
// { ok:false } without throwing. Callers treat email as best-effort.
// ---------------------------------------------------------------------------

export interface SendEmailInput {
  to: string;
  subject: string;
  /** Plain-text body (required). HTML body is derived from this. */
  text: string;
  /** Optional HTML override. If absent, we produce a simple HTML from text. */
  html?: string;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
  skipped?: string;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'QualifyDMs <onboarding@resend.dev>';

export async function sendEmail(
  input: SendEmailInput
): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      '[email-notifier] RESEND_API_KEY not set — skipping email send. Target was:',
      input.to,
      'subject:',
      input.subject
    );
    return { ok: false, skipped: 'no_api_key' };
  }
  if (!input.to || !input.subject || !input.text) {
    return { ok: false, error: 'missing_required_fields' };
  }

  const from = process.env.EMAIL_FROM || DEFAULT_FROM;
  const html = input.html ?? toSimpleHtml(input.text);

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      console.error(
        `[email-notifier] Resend returned ${res.status}: ${body.slice(0, 300)}`
      );
      return { ok: false, error: `${res.status}:${body.slice(0, 300)}` };
    }
    const data = (await res.json().catch(() => null)) as { id?: string } | null;
    return { ok: true, id: data?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[email-notifier] fetch failed:', msg);
    return { ok: false, error: msg };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toSimpleHtml(text: string): string {
  const lines = escapeHtml(text).split(/\n/);
  const body = lines
    .map((line) =>
      line.trim() === '' ? '<br/>' : `<p style="margin:0 0 12px 0;">${line}</p>`
    )
    .join('');
  return `<div style="font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:560px;">${body}</div>`;
}
