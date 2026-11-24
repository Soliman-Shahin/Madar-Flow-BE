import { MailService } from '../services/mail.service';
import { BRAND } from '../config/brand.config';

describe('MailService (Resend requests)', () => {
  const saved = { ...process.env };
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    process.env.RESEND_API_KEY = 're_test_key_not_real';
    process.env.RESEND_FROM_EMAIL = 'Madar Flow <no-reply@mail.example.test>';
    process.env.PASSWORD_RESET_URL = 'https://api.example.test/account/reset-password';
    process.env.ACCOUNT_DELETION_URL = 'https://api.example.test/account/delete/confirm';
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true } as Response);
  });

  afterEach(() => {
    fetchMock.mockRestore();
    process.env = { ...saved };
  });

  const bodyOf = () => JSON.parse(String(fetchMock.mock.calls[0][1].body));

  it('password reset: replies go to the support mailbox and the link is https with the token', async () => {
    await MailService.sendPasswordReset('user@example.test', 'abc123token');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.resend.com/emails');
    const body = bodyOf();
    expect(body.to).toEqual(['user@example.test']);
    expect(body.reply_to).toBe(BRAND.supportEmail);
    expect(body.from).toBe('Madar Flow <no-reply@mail.example.test>');
    expect(body.html).toContain(
      'href="https://api.example.test/account/reset-password?token=abc123token"'
    );
    expect(body.html).not.toContain('madarflow://');
  });

  it('account deletion: replies go to the support mailbox', async () => {
    await MailService.sendAccountDeletionLink('user@example.test', 'deltoken');
    const body = bodyOf();
    expect(body.reply_to).toBe(BRAND.supportEmail);
    expect(body.html).toContain('https://api.example.test/account/delete/confirm?token=deltoken');
  });

  it('analytics report: replies go to the support mailbox', async () => {
    await MailService.sendAnalyticsReport(
      'staff@example.test',
      { subject: 's', html: '<p>h</p>', text: 't' },
      'idem-1'
    );
    expect(bodyOf().reply_to).toBe(BRAND.supportEmail);
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBe('idem-1');
  });

  it('a failed Resend response is surfaced as an error', async () => {
    fetchMock.mockResolvedValue({ ok: false } as Response);
    await expect(
      MailService.sendPasswordReset('user@example.test', 'abc123token')
    ).rejects.toThrow('delivery failed');
  });
});
