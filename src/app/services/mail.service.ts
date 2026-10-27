import logger from './logger.service';
import { BRAND } from '../config/brand.config';

export class MailService {
  static async sendPasswordReset(email: string, token: string): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM_EMAIL;
    const destination = process.env.PASSWORD_RESET_URL;
    if (!apiKey || !from || !destination)
      throw new Error('Password reset mail is not configured');
    const url = new URL(destination);
    url.searchParams.set('token', token);
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: `Reset your ${BRAND.productName} password`,
        html: `<p><strong>${BRAND.productName}</strong></p><p>We received a request to reset your password.</p><p><a href="${url.toString()}">Reset your password</a></p><p>This link expires in 20 minutes. If you did not request this, you can safely ignore this email.</p>`,
        text: `${BRAND.productName}\n\nReset your password: ${url.toString()}\n\nThis link expires in 20 minutes. If you did not request this, you can safely ignore this email.`,
      }),
    });
    if (!response.ok) {
      logger.error('Password reset email delivery failed');
      throw new Error('Password reset mail delivery failed');
    }
  }

  static async sendAccountDeletionLink(
    email: string,
    token: string
  ): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM_EMAIL;
    const destination = process.env.ACCOUNT_DELETION_URL;
    if (!apiKey || !from || !destination)
      throw new Error('Account deletion mail is not configured');
    const url = new URL(destination);
    url.searchParams.set('token', token);
    const link = url.toString();
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: `Confirm ${BRAND.productName} account deletion`,
        html: `<p><strong>${BRAND.productName}</strong></p><p>We received a request to permanently delete your account and all of its data.</p><p><a href="${link}">Review and confirm account deletion</a></p><p>This link expires in 30 minutes. If you did not request this, ignore this email and your account will stay active.</p><hr><p dir="rtl">وصلنا طلب لحذف حسابك وكل بياناته نهائيًا. <a href="${link}">راجع وأكّد حذف الحساب</a>. تنتهي صلاحية الرابط خلال 30 دقيقة. إذا لم تطلب ذلك، تجاهل هذه الرسالة وسيظل حسابك نشطًا.</p>`,
        text: `${BRAND.productName}\n\nConfirm account deletion: ${link}\n\nThis link expires in 30 minutes. If you did not request this, ignore this email and your account will stay active.`,
      }),
    });
    if (!response.ok) {
      logger.error('Account deletion email delivery failed');
      throw new Error('Account deletion mail delivery failed');
    }
  }
}
