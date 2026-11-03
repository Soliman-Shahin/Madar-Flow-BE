import { Schema, model, Types } from 'mongoose';

/**
 * One thing a person has saved: gold, foreign cash, a bank certificate, an
 * investment, or anything else. Amounts are in the owner's own currency at the
 * time of purchase; today's value is worked out on the phone from live prices.
 *
 * `clientId` is generated on the phone, so a retried save never duplicates and
 * the phone can work offline. `clientUpdatedAt` decides which copy is newer.
 */
export type AssetType = 'gold' | 'currency' | 'certificate' | 'investment' | 'other';

export interface IAsset {
  user: Types.ObjectId;
  clientId: string;
  type: AssetType;
  name: string;
  status: 'held' | 'sold';
  purchasedAt: Date;
  costAmount: number;
  costCurrency: string;
  /** Shape depends on `type`; validated on the way in (validations/asset.validation.ts). */
  details: Record<string, unknown>;
  note?: string;
  soldAt?: Date;
  saleAmount?: number;
  isDeleted: boolean;
  clientUpdatedAt: Date;
}

const assetSchema = new Schema<IAsset>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    clientId: { type: String, required: true, maxlength: 64 },
    type: {
      type: String,
      enum: ['gold', 'currency', 'certificate', 'investment', 'other'],
      required: true,
    },
    name: { type: String, required: true, maxlength: 80 },
    status: { type: String, enum: ['held', 'sold'], default: 'held' },
    purchasedAt: { type: Date, required: true },
    costAmount: { type: Number, required: true, min: 0 },
    costCurrency: { type: String, required: true, match: /^[A-Z]{3}$/ },
    details: { type: Schema.Types.Mixed, default: {} },
    note: { type: String, maxlength: 200 },
    soldAt: { type: Date },
    saleAmount: { type: Number, min: 0 },
    isDeleted: { type: Boolean, default: false },
    clientUpdatedAt: { type: Date, required: true },
  },
  { timestamps: true }
);

assetSchema.index({ user: 1, clientId: 1 }, { unique: true });
assetSchema.index({ user: 1, isDeleted: 1, type: 1 });

export const Asset = model<IAsset>('Asset', assetSchema);
