import express from 'express';
import request from 'supertest';
import { AppSettings } from '../models/app-settings.model';
import legalPageRoutes from '../routes/legal-page.route';
import { renderLegalText } from '../controllers/legal-page.controller';
import { enhancedErrorHandler } from '../middleware/error-handler-enhanced';

const app = express();
app.use(legalPageRoutes);
app.use(enhancedErrorHandler);

const privacy = {
  version: '1.0',
  title: { en: 'Privacy Policy', ar: 'سياسة الخصوصية' },
  body: {
    en: '# Who we are\nMadar Flow by Orbit Madar.\n\n# Contact\nWrite to info@orbit-madar.com or see https://orbit-madar.com',
    ar: '# من نحن\nمدار فلو من أوربت مدار.',
  },
};

describe('public legal pages', () => {
  it('returns a clear 404 page before anything is configured', async () => {
    const res = await request(app).get('/privacy');
    expect(res.status).toBe(404);
    expect(res.text).toContain('not available yet');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('renders the privacy policy in English by default', async () => {
    await AppSettings.create({ key: 'app', legal: { privacy } });
    const res = await request(app).get('/privacy');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<html lang="en" dir="ltr">');
    expect(res.text).toContain('<h1>Privacy Policy</h1>');
    expect(res.text).toContain('<h2>Who we are</h2>');
    expect(res.text).toContain('Version 1.0');
    expect(res.text).toContain('hreflang="ar"');
    expect(res.text).toContain(
      '<a href="https://orbit-madar.com" rel="noopener noreferrer">https://orbit-madar.com</a>'
    );
  });

  it('renders Arabic right-to-left via ?lang=ar or Accept-Language', async () => {
    await AppSettings.create({ key: 'app', legal: { privacy } });
    const byQuery = await request(app).get('/privacy?lang=ar');
    expect(byQuery.text).toContain('<html lang="ar" dir="rtl">');
    expect(byQuery.text).toContain('<h1>سياسة الخصوصية</h1>');
    const byHeader = await request(app)
      .get('/privacy')
      .set('Accept-Language', 'ar-EG,ar;q=0.9,en;q=0.5');
    expect(byHeader.text).toContain('dir="rtl"');
  });

  it('falls back to the other language when only one is configured', async () => {
    await AppSettings.create({
      key: 'app',
      legal: { terms: { version: '1.0', body: { en: '# Terms\nOnly English.' } } },
    });
    const res = await request(app).get('/terms?lang=ar');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Only English.');
    expect(res.text).not.toContain('hreflang');
  });

  it('escapes HTML in dashboard-managed text', async () => {
    await AppSettings.create({
      key: 'app',
      legal: {
        privacy: {
          version: '1.0',
          title: { en: '<img src=x onerror=alert(1)>' },
          body: { en: '# <script>alert(1)</script>\n"quoted" & <b>bold</b>' },
        },
      },
    });
    const res = await request(app).get('/privacy');
    expect(res.text).not.toContain('<script>');
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).not.toContain('<b>bold</b>');
    expect(res.text).toContain('&lt;script&gt;');
  });

  it('only auto-links http(s) URLs and sends a locked-down CSP', async () => {
    await AppSettings.create({
      key: 'app',
      legal: {
        privacy: {
          version: '1.0',
          body: { en: 'See javascript:alert(1) and https://ok.example/path?a=1&b=2' },
        },
      },
    });
    const res = await request(app).get('/privacy');
    expect(res.text).not.toContain('href="javascript:');
    expect(res.text).toContain('href="https://ok.example/path?a=1&amp;b=2"');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  it('parses headings and paragraphs like the mobile app does', () => {
    expect(renderLegalText('# A\nline1\nline2\n\nplain')).toBe(
      '<h2>A</h2><p>line1<br>line2</p><p>plain</p>'
    );
  });
});
