import { Schema, model, Document, Types } from 'mongoose';

/**
 * AppSettings — dashboard-managed, non-secret content the consumer app reads
 * (support contacts, legal documents, FAQ, maintenance notice, version policy).
 *
 * Singleton document (`key: 'app'`). A section that was never configured is
 * simply absent: clients keep their built-in default for it.
 */

export interface ILocalizedText {
  ar?: string;
  en?: string;
}

export interface IAppSettings extends Document {
  key: 'app';
  support?: {
    email?: string;
    /** Digits only, international format without "+" (for https://wa.me/<digits>). */
    whatsapp?: string;
    website?: string;
    hours?: ILocalizedText;
    links?: { label: ILocalizedText; url: string }[];
  };
  legal?: {
    terms?: {
      version: string;
      updatedAt?: Date;
      title?: ILocalizedText;
      body: ILocalizedText;
    };
    privacy?: {
      version: string;
      updatedAt?: Date;
      title?: ILocalizedText;
      body: ILocalizedText;
    };
  };
  faq?: { question: ILocalizedText; answer: ILocalizedText }[];
  maintenance?: { enabled: boolean; message?: ILocalizedText };
  versioning?: {
    minVersion?: string;
    latestVersion?: string;
    storeUrl?: string;
  };
  /** Increments on every successful update; used for optimistic concurrency. */
  revision: number;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const localized = { _id: false, ar: String, en: String };

const legalDocument = {
  _id: false,
  version: { type: String, required: true },
  updatedAt: Date,
  title: localized,
  body: localized,
};

const AppSettingsSchema = new Schema<IAppSettings>(
  {
    key: { type: String, enum: ['app'], default: 'app', unique: true },
    support: {
      _id: false,
      type: {
        email: String,
        whatsapp: String,
        website: String,
        hours: localized,
        links: [
          {
            _id: false,
            label: localized,
            url: { type: String, required: true },
          },
        ],
      },
    },
    legal: {
      _id: false,
      type: {
        terms: { type: legalDocument },
        privacy: { type: legalDocument },
      },
    },
    faq: [
      {
        _id: false,
        question: localized,
        answer: localized,
      },
    ],
    maintenance: {
      _id: false,
      type: { enabled: { type: Boolean, default: false }, message: localized },
    },
    versioning: {
      _id: false,
      type: { minVersion: String, latestVersion: String, storeUrl: String },
    },
    revision: { type: Number, default: 0, min: 0 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const AppSettings = model<IAppSettings>(
  'AppSettings',
  AppSettingsSchema
);
