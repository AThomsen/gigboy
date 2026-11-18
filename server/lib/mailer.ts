import nodemailer, { type Transporter } from 'nodemailer';
import { readSmtpConfig } from './authConfig.js';

let transporter: Transporter | null = null;
let from = '';

function getTransporter(): Transporter {
  if (transporter) return transporter;
  const smtp = readSmtpConfig();
  if (!smtp) throw new Error('SMTP is not configured (SMTP_HOST and SMTP_FROM).');
  transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
  });
  from = smtp.from;
  return transporter;
}

/** Logs (but doesn't fail on) an unreachable SMTP server at startup, so a typo shows up early. */
export function checkMailerAtStartup(): void {
  getTransporter()
    .verify()
    .then(() => console.log('SMTP connection verified.'))
    .catch((err) => console.warn('SMTP check failed — sign-in emails will not arrive until this is fixed:', err));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export async function sendSignInEmail(to: string, link: string, code: string, ttlMinutes: number): Promise<void> {
  const spacedCode = `${code.slice(0, 3)} ${code.slice(3)}`;
  const text = [
    'Sign in to Gigboy',
    '',
    `Your sign-in code: ${spacedCode}`,
    '',
    'Or open this link:',
    link,
    '',
    'Using Gigboy as an installed app? Type the code into the app — the link opens in your browser instead.',
    '',
    `The code and link work once and expire in ${ttlMinutes} minutes. If you didn't ask to sign in, you can ignore this email.`,
  ].join('\n');

  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;max-width:480px;margin:0 auto;padding:24px">
<h1 style="font-size:20px;margin:0 0 16px">Sign in to Gigboy</h1>
<p style="margin:0 0 8px">Your sign-in code:</p>
<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:0 0 24px;font-family:ui-monospace,Menlo,monospace">${escapeHtml(spacedCode)}</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1a6fc4;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">Sign in</a></p>
<p style="margin:0 0 16px;color:#555;font-size:14px">Using Gigboy as an installed app? Type the code into the app — the button opens in your browser instead.</p>
<p style="margin:0;color:#777;font-size:13px">The code and link work once and expire in ${ttlMinutes} minutes. If you didn't ask to sign in, you can ignore this email.</p>
</body></html>`;

  await getTransporter().sendMail({
    from,
    to,
    subject: `Your Gigboy sign-in code: ${spacedCode}`,
    text,
    html,
  });
}
