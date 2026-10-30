import { Schema, model, Document } from 'mongoose';

/**
 * Anonymous product-usage events, sent by the consumer app only after the user
 * explicitly opted in.
 *
 * Privacy by construction:
 * - No account reference: there is no user id, email, IP address or user-agent
 *   field on this document. Events are tied only to a random per-install id that
 *   the app creates when the user opts in and discards when they opt out.
 * - No financial data and no free text: `name` is one of a fixed list.
 * - Events expire automatically (see TELEMETRY_RETENTION_DAYS).
 */
export const TELEMETRY_EVENT_NAMES = [
  'app_open',
  'signup_completed',
  'transaction_added',
  'category_added',
  'export_completed',
  'sync_completed',
  'biometric_enabled',
] as const;
export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

export const TELEMETRY_PLATFORMS = ['android', 'ios', 'web'] as const;
export const TELEMETRY_LANGUAGES = ['ar', 'en'] as const;

export const TELEMETRY_RETENTION_DAYS = 180;

export interface ITelemetryEvent extends Document {
  installId: string;
  name: TelemetryEventName;
  /** When the event happened (client clock, clamped to the server's time window). */
  at: Date;
  appVersion: string;
  platform: (typeof TELEMETRY_PLATFORMS)[number];
  lang: (typeof TELEMETRY_LANGUAGES)[number];
}

const TelemetryEventSchema = new Schema<ITelemetryEvent>(
  {
    installId: { type: String, required: true, maxlength: 64 },
    name: { type: String, required: true, enum: TELEMETRY_EVENT_NAMES },
    at: { type: Date, required: true },
    appVersion: { type: String, required: true, maxlength: 20 },
    platform: { type: String, required: true, enum: TELEMETRY_PLATFORMS },
    lang: { type: String, required: true, enum: TELEMETRY_LANGUAGES },
  },
  { versionKey: false, timestamps: false }
);

TelemetryEventSchema.index({ name: 1, at: -1 });
TelemetryEventSchema.index({ installId: 1, at: -1 });
// Automatic deletion after the retention period.
TelemetryEventSchema.index(
  { at: 1 },
  { expireAfterSeconds: TELEMETRY_RETENTION_DAYS * 24 * 60 * 60 }
);

export const TelemetryEvent = model<ITelemetryEvent>(
  'TelemetryEvent',
  TelemetryEventSchema
);
