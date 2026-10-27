import { Request, Response } from 'express';
import { BRAND } from '../config/brand.config';
import {
  AccountDeletionError,
  AccountDeletionService,
} from '../services/account-deletion.service';
import logger from '../services/logger.service';

/**
 * Public, server-rendered account deletion pages (Google Play "delete account"
 * URL). No JavaScript; plain HTML forms posting back to the same origin.
 */

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7fb;--card:#fff;--text:#1d2433;--muted:#5d6678;--border:#e2e5ec;--danger:#c62828;--primary:#2f5bea}
@media (prefers-color-scheme:dark){:root{--bg:#0f131a;--card:#171c25;--text:#e8ebf2;--muted:#9aa3b5;--border:#2a3140;--danger:#ef5350;--primary:#7d9bff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic",sans-serif}
main{max-width:560px;margin:0 auto;padding:32px 16px 48px}
.brand{font-weight:700;font-size:18px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 12px}h2{font-size:17px;margin:0 0 8px}
p,li{color:var(--muted)}ul{padding-inline-start:20px;margin:8px 0}
label{display:block;font-weight:600;margin:16px 0 6px}
input[type=email]{width:100%;padding:12px;border:1px solid var(--border);border-radius:10px;background:transparent;color:var(--text);font:inherit}
button{width:100%;margin-top:16px;padding:13px;border:0;border-radius:10px;background:var(--danger);color:#fff;font:inherit;font-weight:700;cursor:pointer}
button.secondary{background:var(--primary)}
.warn{border-color:var(--danger)}.warn h2{color:var(--danger)}
[dir=rtl]{text-align:right}footer{font-size:13px;color:var(--muted);text-align:center}
a{color:var(--primary)}
`;

function render(res: Response, status: number, title: string, body: string) {
  res
    .status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    })
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · ${BRAND.productName}</title><style>${STYLE}</style></head><body><main><div class="brand">${BRAND.productName}</div>${body}<footer>${escapeHtml(BRAND.attribution)} · <a href="mailto:${BRAND.supportEmail}">${BRAND.supportEmail}</a></footer></main></body></html>`
    );
}

const WHAT_IS_DELETED = `
<div class="card warn">
  <h2>What will be deleted</h2>
  <ul>
    <li>Your profile, sign-in methods, and all active sessions</li>
    <li>All transactions, categories, and synced data</li>
    <li>Notifications, notification preferences, and registered devices</li>
    <li>Subscription records linked to the account</li>
  </ul>
  <p>Deletion is permanent and happens immediately after you confirm. Security audit records are kept without your e-mail address.</p>
  <div dir="rtl" lang="ar">
    <h2>ما الذي سيتم حذفه</h2>
    <ul>
      <li>ملفك الشخصي وطرق تسجيل الدخول وكل الجلسات النشطة</li>
      <li>كل المعاملات والتصنيفات والبيانات المتزامنة</li>
      <li>الإشعارات وتفضيلاتها والأجهزة المسجلة</li>
      <li>سجلات الاشتراك المرتبطة بالحساب</li>
    </ul>
    <p>الحذف نهائي ويتم فور التأكيد. تُحفظ سجلات التدقيق الأمني بدون بريدك الإلكتروني.</p>
  </div>
</div>`;

export const showDeletionRequestPage = (_req: Request, res: Response) =>
  render(
    res,
    200,
    'Delete your account',
    `<div class="card">
  <h1>Delete your ${BRAND.productName} account</h1>
  <p>In the app: <strong>Settings → Danger Zone → Delete Account</strong>.</p>
  <p>Without the app: enter the e-mail address of your account. We will send you a link to confirm the deletion.</p>
  <div dir="rtl" lang="ar">
    <h2>حذف حسابك</h2>
    <p>من التطبيق: <strong>الإعدادات ← منطقة الخطر ← حذف الحساب</strong>.</p>
    <p>بدون التطبيق: أدخل البريد الإلكتروني لحسابك وسنرسل لك رابطًا لتأكيد الحذف.</p>
  </div>
  <form method="post" action="/account/delete">
    <label for="email">E-mail · البريد الإلكتروني</label>
    <input id="email" name="email" type="email" required maxlength="254" autocomplete="email">
    <button type="submit" class="secondary">Send confirmation link · إرسال رابط التأكيد</button>
  </form>
</div>${WHAT_IS_DELETED}`
  );

export const submitDeletionRequest = async (req: Request, res: Response) => {
  try {
    await AccountDeletionService.requestDeletionByEmail(req.body?.email);
  } catch {
    logger.error('Account deletion request failed');
  }
  // Identical response for every outcome to prevent account enumeration.
  return render(
    res,
    200,
    'Check your e-mail',
    `<div class="card">
  <h1>Check your e-mail</h1>
  <p>If an account exists for that address, we sent a confirmation link. It expires in 30 minutes.</p>
  <div dir="rtl" lang="ar"><h2>تحقق من بريدك الإلكتروني</h2><p>إذا كان هناك حساب بهذا العنوان، فقد أرسلنا رابط تأكيد تنتهي صلاحيته خلال 30 دقيقة.</p></div>
</div>`
  );
};

const invalidLink = (res: Response) =>
  render(
    res,
    400,
    'Link expired',
    `<div class="card">
  <h1>This link is invalid or has expired</h1>
  <p><a href="/account/delete">Request a new link</a></p>
  <div dir="rtl" lang="ar"><h2>الرابط غير صالح أو منتهي الصلاحية</h2><p><a href="/account/delete">اطلب رابطًا جديدًا</a></p></div>
</div>`
  );

export const showDeletionConfirmPage = async (req: Request, res: Response) => {
  const token = req.query.token;
  if (!(await AccountDeletionService.isDeletionTokenValid(token)))
    return invalidLink(res);
  return render(
    res,
    200,
    'Confirm deletion',
    `${WHAT_IS_DELETED}<div class="card">
  <h1>Permanently delete your account?</h1>
  <p>This cannot be undone.</p>
  <div dir="rtl" lang="ar"><h2>حذف حسابك نهائيًا؟</h2><p>لا يمكن التراجع عن هذا الإجراء.</p></div>
  <form method="post" action="/account/delete/confirm">
    <input type="hidden" name="token" value="${escapeHtml(String(token))}">
    <button type="submit">Delete my account permanently · احذف حسابي نهائيًا</button>
  </form>
</div>`
  );
};

export const submitDeletionConfirm = async (req: Request, res: Response) => {
  try {
    await AccountDeletionService.deleteByEmailToken(req.body?.token, req.ip);
  } catch (error) {
    if (error instanceof AccountDeletionError && error.statusCode === 400)
      return invalidLink(res);
    if (!(error instanceof AccountDeletionError))
      return render(
        res,
        503,
        'Try again',
        `<div class="card"><h1>Something went wrong</h1><p>Your account was not changed. Please open the link from your e-mail again in a few minutes.</p><div dir="rtl" lang="ar"><h2>حدث خطأ</h2><p>لم يتم تغيير حسابك. افتح الرابط من بريدك مرة أخرى بعد دقائق.</p></div></div>`
      );
    return render(
      res,
      500,
      'Deletion failed',
      `<div class="card"><h1>Deletion could not be completed</h1><p>Your account has been disabled. Please contact <a href="mailto:${BRAND.supportEmail}">${BRAND.supportEmail}</a> to finish the deletion.</p><div dir="rtl" lang="ar"><h2>تعذّر إكمال الحذف</h2><p>تم تعطيل حسابك. تواصل مع الدعم لإكمال الحذف.</p></div></div>`
    );
  }
  return render(
    res,
    200,
    'Account deleted',
    `<div class="card">
  <h1>Your account has been deleted</h1>
  <p>All of your data has been removed from our servers. You can uninstall the app to remove any data left on your device.</p>
  <div dir="rtl" lang="ar"><h2>تم حذف حسابك</h2><p>تمت إزالة كل بياناتك من خوادمنا. يمكنك إلغاء تثبيت التطبيق لإزالة أي بيانات متبقية على جهازك.</p></div>
</div>`
  );
};
