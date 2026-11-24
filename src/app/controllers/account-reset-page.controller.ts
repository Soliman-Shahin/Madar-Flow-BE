import { Request, Response } from 'express';
import { BRAND } from '../config/brand.config';

/**
 * Public landing page for password-reset e-mails.
 *
 * The reset e-mail must contain an https link: Gmail and other mail clients strip or disable
 * custom-scheme links such as madarflow://. This page is that https link; it then offers a button
 * that opens the app through its deep link (madarflow://auth/reset-password?token=...), and a
 * link to the web dashboard for staff accounts. It only renders HTML: it never reads, validates
 * or consumes the token (that happens in POST /v1/user/password/reset).
 */

const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!
  );

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7fb;--card:#fff;--text:#1d2433;--muted:#5d6678;--border:#e2e5ec;--primary:#2f5bea}
@media (prefers-color-scheme:dark){:root{--bg:#0f131a;--card:#171c25;--text:#e8ebf2;--muted:#9aa3b5;--border:#2a3140;--primary:#7d9bff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic",sans-serif}
main{max-width:520px;margin:0 auto;padding:32px 16px 48px}
.brand{font-weight:700;font-size:18px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 8px}h2{font-size:17px;margin:0 0 6px}
p{color:var(--muted);margin:8px 0}
.btn{display:block;text-align:center;margin:16px 0 4px;padding:14px;border-radius:10px;background:var(--primary);color:#fff;font-weight:700;text-decoration:none}
.link{display:block;text-align:center;margin-top:6px}
[dir=rtl]{text-align:right}footer{font-size:13px;color:var(--muted);text-align:center}
a{color:var(--primary)}
`;

function render(res: Response, status: number, body: string) {
  res
    .status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    })
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Reset your password · ${BRAND.productName}</title><style>${STYLE}</style></head><body><main><div class="brand">${BRAND.productName}</div>${body}<footer>${escapeHtml(BRAND.attribution)} · <a href="mailto:${BRAND.supportEmail}">${BRAND.supportEmail}</a></footer></main></body></html>`
    );
}

function webResetUrl(token: string): string | null {
  const base = process.env.FRONTEND_URL;
  if (!base) return null;
  try {
    const url = new URL('/reset-password', base);
    if (url.protocol !== 'https:') return null;
    url.searchParams.set('token', token);
    return url.toString();
  } catch {
    return null;
  }
}

export const showResetPasswordPage = (req: Request, res: Response) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';

  if (!TOKEN.test(token)) {
    return render(
      res,
      400,
      `<div class="card"><h1>This reset link is not valid</h1><p>The link is incomplete or has been changed. Please request a new password reset from the app.</p><div dir="rtl" lang="ar"><h2>رابط إعادة التعيين غير صالح</h2><p>الرابط ناقص أو تم تعديله. يرجى طلب إعادة تعيين جديدة من التطبيق.</p></div></div>`
    );
  }

  const appLink = `madarflow://auth/reset-password?token=${encodeURIComponent(token)}`;
  const web = webResetUrl(token);
  const webBlock = web
    ? `<a class="link" href="${escapeHtml(web)}" rel="noreferrer">Using the web dashboard? Continue here · تستخدم لوحة الويب؟ تابع من هنا</a>`
    : '';

  return render(
    res,
    200,
    `<div class="card"><h1>Reset your password</h1><p>Tap the button on the phone where Madar Flow is installed to open the app and choose a new password. The link works once and expires 20 minutes after it was requested.</p><a class="btn" href="${escapeHtml(appLink)}">Open Madar Flow</a><p>If the app does not open, make sure Madar Flow is installed and up to date, then tap the button again.</p><div dir="rtl" lang="ar"><h2>إعادة تعيين كلمة المرور</h2><p>اضغط على الزر من الهاتف المثبّت عليه مدار فلو لفتح التطبيق واختيار كلمة مرور جديدة. يعمل الرابط مرة واحدة وتنتهي صلاحيته بعد 20 دقيقة من طلبه.</p><a class="btn" href="${escapeHtml(appLink)}">افتح مدار فلو</a><p>إذا لم يفتح التطبيق فتأكد من تثبيت مدار فلو وتحديثه، ثم اضغط الزر مرة أخرى.</p></div>${webBlock}</div><div class="card"><p>If you did not request this, you can safely ignore the e-mail. Your password will not change. · إذا لم تطلب ذلك فتجاهل الرسالة، ولن تتغير كلمة مرورك.</p></div>`
  );
};
