import { z } from 'zod';

/**
 * Validation for dashboard-managed app content. Everything here is rendered as
 * plain text by clients (never HTML), so the rules are about shape, size and
 * safe schemes — not markup filtering. Control characters are stripped.
 */

// Strip control characters except tab / newline, then trim.
const clean = (value: string) =>
  // eslint-disable-next-line no-control-regex
  value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

const text = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform(clean)
    .pipe(z.string().max(max));

const optionalText = (max: number) => text(max).optional();

const localized = (max: number) =>
  z.object({ ar: optionalText(max), en: optionalText(max) }).strict();

const httpsUrl = z
  .string()
  .max(2048)
  .transform((v) => v.trim())
  .pipe(
    z.string().refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
      } catch {
        return false;
      }
    }, 'Must be a valid https URL')
  );

const semver = z
  .string()
  .regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, 'Use MAJOR.MINOR.PATCH');

const LEGAL_BODY_MAX = 60_000;

const legalDocument = z
  .object({
    version: text(32).pipe(z.string().min(1)),
    title: localized(120).optional(),
    body: localized(LEGAL_BODY_MAX),
  })
  .strict()
  .refine((doc) => !!(doc.body.ar?.length || doc.body.en?.length), {
    message: 'At least one language body is required',
    path: ['body'],
  });

export const supportSchema = z
  .object({
    email: z
      .string()
      .max(254)
      .transform(clean)
      .pipe(z.string().email())
      .optional(),
    whatsapp: z
      .string()
      .transform((v) => v.replace(/[\s()+-]/g, ''))
      .pipe(
        z
          .string()
          .regex(/^\d{8,15}$/, 'Digits only, 8-15, international format')
      )
      .optional(),
    website: httpsUrl.optional(),
    hours: localized(200).optional(),
    links: z
      .array(z.object({ label: localized(60), url: httpsUrl }).strict())
      .max(8)
      .optional(),
  })
  .strict();

export const legalSchema = z
  .object({
    terms: legalDocument.optional(),
    privacy: legalDocument.optional(),
  })
  .strict();

export const faqSchema = z
  .array(
    z
      .object({ question: localized(300), answer: localized(3000) })
      .strict()
      .refine((item) => !!(item.question.ar || item.question.en), {
        message: 'A question is required',
        path: ['question'],
      })
  )
  .max(40);

export const maintenanceSchema = z
  .object({ enabled: z.boolean(), message: localized(500).optional() })
  .strict();

export const versioningSchema = z
  .object({
    minVersion: semver.optional(),
    latestVersion: semver.optional(),
    storeUrl: httpsUrl.optional(),
  })
  .strict();

/**
 * PUT body: `revision` is the revision the editor last loaded (0 when nothing
 * has been saved yet). Provided sections replace the stored section; `null`
 * clears a section back to the client's built-in default.
 */
export const appSettingsUpdateSchema = z
  .object({
    revision: z.number().int().min(0),
    support: supportSchema.nullable().optional(),
    legal: legalSchema.nullable().optional(),
    faq: faqSchema.nullable().optional(),
    maintenance: maintenanceSchema.nullable().optional(),
    versioning: versioningSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (body) =>
      ['support', 'legal', 'faq', 'maintenance', 'versioning'].some(
        (key) => (body as Record<string, unknown>)[key] !== undefined
      ),
    { message: 'At least one section is required' }
  );

export type AppSettingsUpdate = z.infer<typeof appSettingsUpdateSchema>;
