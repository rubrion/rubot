/**
 * Outbound email via Resend, with a dev-mode console-log fallback.
 *
 * When `RESEND_API_KEY` is empty (typical for local dev), the helpers
 * log the action URL to the worker console instead of actually sending
 * mail. This keeps the manager bootstrap flow runnable without a
 * Resend account.
 *
 * Brand-specific strings (`from` address, display name) come from env
 * — no hardcoded brand naming in this file.
 */

const RESEND_API = "https://api.resend.com/emails";
const DEFAULT_FROM = "Rubot <noreply@example.com>";
const DEFAULT_BRAND = "Rubot";
const BRAND_COLOR = "#f59e0b"; // amber-500 — visual default, override in CSS

interface MailEnv {
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  MAIL_BRAND_NAME?: string;
}

function baseHtml(brand: string, title: string, preheader: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#e5e7eb;">
  <span style="display:none;max-height:0;overflow:hidden;">${preheader}&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</span>
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table width="100%" style="max-width:520px;" cellpadding="0" cellspacing="0" role="presentation">
          <tr>
            <td style="padding-bottom:24px;text-align:center;">
              <span style="font-size:22px;font-weight:700;color:${BRAND_COLOR};letter-spacing:-0.5px;">${brand}</span>
            </td>
          </tr>
          <tr>
            <td style="background:#111827;border:1px solid #1f2937;border-radius:12px;padding:36px 40px;">
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding-top:24px;text-align:center;font-size:12px;color:#6b7280;">
              You received this email because an account was created for ${brand}.<br />
              If this wasn't you, you can safely ignore this message.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function ctaButton(label: string, url: string): string {
  return `<a href="${url}"
    style="display:inline-block;margin-top:24px;padding:12px 28px;background:${BRAND_COLOR};color:#111827;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;"
  >${label}</a>`;
}

async function sendEmail(
  env: MailEnv,
  to: string,
  subject: string,
  html: string,
  text: string,
  devLogLabel: string,
  devLogUrl: string,
): Promise<void> {
  const apiKey = env.RESEND_API_KEY || "";
  if (!apiKey) {
    console.log(
      `[email] dev-mode (no RESEND_API_KEY) — ${devLogLabel} for ${to}: ${devLogUrl}`,
    );
    return;
  }

  const from = env.MAIL_FROM || DEFAULT_FROM;
  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`resend_error: ${res.status} ${body}`);
  }
}

export async function sendConfirmationEmail(
  env: MailEnv,
  to: string,
  confirmUrl: string,
): Promise<void> {
  const brand = env.MAIL_BRAND_NAME || DEFAULT_BRAND;
  const subject = `Confirm your ${brand} account`;
  const html = baseHtml(
    brand,
    subject,
    "Confirm your email to activate your account.",
    `<h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#f9fafb;">Confirm your email</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#9ca3af;line-height:1.6;">
      Thanks for signing up. Click the button below to verify your email address and activate your account.
    </p>
    ${ctaButton("Confirm email address", confirmUrl)}
    <p style="margin-top:24px;font-size:13px;color:#6b7280;line-height:1.5;">
      This link expires in <strong style="color:#d1d5db;">24 hours</strong>.<br />
      If the button doesn't work, paste this URL into your browser:<br />
      <a href="${confirmUrl}" style="color:${BRAND_COLOR};word-break:break-all;">${confirmUrl}</a>
    </p>`,
  );
  const text = `Confirm your ${brand} account\n\nVisit the link below to confirm your email:\n\n${confirmUrl}\n\nThis link expires in 24 hours.`;

  await sendEmail(env, to, subject, html, text, "confirmation URL", confirmUrl);
}

export async function sendPasswordResetEmail(
  env: MailEnv,
  to: string,
  resetUrl: string,
): Promise<void> {
  const brand = env.MAIL_BRAND_NAME || DEFAULT_BRAND;
  const subject = `Reset your ${brand} password`;
  const html = baseHtml(
    brand,
    subject,
    "A password reset was requested for your account.",
    `<h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#f9fafb;">Reset your password</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#9ca3af;line-height:1.6;">
      We received a request to reset the password for your account. Click the button below to choose a new password.
    </p>
    ${ctaButton("Reset password", resetUrl)}
    <p style="margin-top:24px;font-size:13px;color:#6b7280;line-height:1.5;">
      This link is valid for <strong style="color:#d1d5db;">1 hour</strong>.<br />
      If the button doesn't work, paste this URL into your browser:<br />
      <a href="${resetUrl}" style="color:${BRAND_COLOR};word-break:break-all;">${resetUrl}</a>
    </p>
    <p style="margin-top:20px;font-size:13px;color:#6b7280;">
      If you did not request a password reset, no action is needed — your password has not been changed.
    </p>`,
  );
  const text = `Reset your ${brand} password\n\nVisit the link below to choose a new password:\n\n${resetUrl}\n\nThis link expires in 1 hour.`;

  await sendEmail(env, to, subject, html, text, "reset URL", resetUrl);
}
