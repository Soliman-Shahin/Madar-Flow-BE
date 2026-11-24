import { Request, Response } from 'express';
import { BRAND } from '../config/brand.config';
import { AppSettings } from '../models/app-settings.model';

/**
 * Public, server-rendered Privacy Policy and Terms pages (Google Play requires a public privacy
 * policy URL). The text is the same dashboard-managed content the app shows (App content → Legal),
 * so it is edited in one place. Plain text only: a line starting with "# " is a heading, blank
 * lines separate paragraphs. No JavaScript; everything is HTML-escaped.
 */

type Kind = 'privacy' | 'terms';
type Lang = 'en' | 'ar';

interface LegalDoc {
  version?: string;
  updatedAt?: Date;
  title?: { en?: string; ar?: string };
  body?: { en?: string; ar?: string };
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!
  );

/** Turns bare http(s) URLs into links. Input must already be HTML-escaped. */
const linkify = (escaped: string) =>
  escaped.replace(
    /https?:\/\/[^\s<]+/g,
    (url) =>
      `<a href="${url}" rel="noopener noreferrer">${url}</a>`
  );

export function renderLegalText(body: string): string {
  const out: string[] = [];
  for (const block of body.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('# ')) {
      const [first, ...rest] = trimmed.split('\n');
      out.push(`<h2>${escapeHtml(first.slice(2).trim())}</h2>`);
      const remainder = rest.join('\n').trim();
      if (remainder) {
        out.push(`<p>${linkify(escapeHtml(remainder)).replace(/\n/g, '<br>')}</p>`);
      }
    } else {
      out.push(`<p>${linkify(escapeHtml(trimmed)).replace(/\n/g, '<br>')}</p>`);
    }
  }
  return out.join('');
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7fb;--card:#fff;--text:#1d2433;--muted:#5d6678;--border:#e2e5ec;--primary:#2f5bea}
@media (prefers-color-scheme:dark){:root{--bg:#0f131a;--card:#171c25;--text:#e8ebf2;--muted:#9aa3b5;--border:#2a3140;--primary:#7d9bff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.7 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic",sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 56px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.brand{font-weight:700;font-size:18px}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:26px 0 6px}
.meta{color:var(--muted);font-size:14px;margin:0 0 8px}
p{margin:8px 0;color:var(--text)}
a{color:var(--primary)}
footer{font-size:13px;color:var(--muted);text-align:center;margin-top:20px}
`;

const SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

function pickLang(req: Request): Lang {
  const q = String(req.query.lang ?? '').toLowerCase();
  if (q === 'ar' || q === 'en') return q;
  return /^\s*ar\b/i.test(req.get('accept-language') ?? '') ? 'ar' : 'en';
}

function shell(lang: Lang, title: string, content: string, switchHref?: string) {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const switchLabel = lang === 'ar' ? 'English' : 'العربية';
  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · ${BRAND.productName}</title><style>${STYLE}</style></head><body><main><div class="top"><div class="brand">${BRAND.productName}</div>${
    switchHref
      ? `<a href="${switchHref}" hreflang="${lang === 'ar' ? 'en' : 'ar'}">${switchLabel}</a>`
      : ''
  }</div><div class="card">${content}</div><footer>${escapeHtml(BRAND.attribution)}</footer></main></body></html>`;
}

const pick = (value: { en?: string; ar?: string } | undefined, lang: Lang) =>
  lang === 'ar' ? value?.ar || value?.en : value?.en || value?.ar;

const showLegalPage = (kind: Kind) => async (req: Request, res: Response) => {
  const requested = pickLang(req);
  const settings = await AppSettings.findOne({ key: 'app' }).lean();
  const doc = settings?.legal?.[kind === 'privacy' ? 'privacy' : 'terms'] as
    | LegalDoc
    | undefined;
  // Use the language the text is actually written in, so direction and labels always match it.
  const other: Lang = requested === 'ar' ? 'en' : 'ar';
  const lang: Lang = !doc || doc.body?.[requested] ? requested : other;
  const text = pick(doc?.body, lang);

  if (!doc || !text) {
    const msg =
      lang === 'ar'
        ? 'هذه الصفحة غير متاحة بعد.'
        : 'This page is not available yet.';
    return res
      .status(404)
      .set({ ...SECURITY_HEADERS, 'Cache-Control': 'no-store' })
      .send(shell(lang, 'Not found', `<h1>${escapeHtml(msg)}</h1>`));
  }

  const fallbackTitle =
    kind === 'privacy'
      ? lang === 'ar'
        ? 'سياسة الخصوصية'
        : 'Privacy Policy'
      : lang === 'ar'
        ? 'الشروط والأحكام'
        : 'Terms of Service';
  const title = pick(doc.title, lang) || fallbackTitle;
  const updated = (doc.updatedAt ?? settings?.updatedAt) as Date | undefined;
  const meta = [
    doc.version ? `${lang === 'ar' ? 'الإصدار' : 'Version'} ${doc.version}` : '',
    updated
      ? `${lang === 'ar' ? 'آخر تحديث' : 'Last updated'} ${new Date(updated).toISOString().slice(0, 10)}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const otherLang: Lang = lang === 'ar' ? 'en' : 'ar';
  const hasOther = !!doc.body?.[otherLang];
  const content = `<h1>${escapeHtml(title)}</h1>${
    meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ''
  }${renderLegalText(text)}`;

  return res
    .status(200)
    .set(SECURITY_HEADERS)
    .send(
      shell(
        lang,
        title,
        content,
        hasOther ? `?lang=${otherLang}` : undefined
      )
    );
};

export const showPrivacyPage = showLegalPage('privacy');
export const showTermsPage = showLegalPage('terms');
