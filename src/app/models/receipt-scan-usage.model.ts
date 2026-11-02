import { Schema, model, Types } from 'mongoose';

/**
 * How many receipt scans an account has used in a calendar month ("YYYY-MM").
 * Only the online reader is counted (it has a cost); reading on the device is
 * free and never reaches the server.
 */
export interface IReceiptScanUsage {
  user: Types.ObjectId;
  month: string;
  count: number;
}

const receiptScanUsageSchema = new Schema<IReceiptScanUsage>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    month: { type: String, required: true },
    count: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true }
);

receiptScanUsageSchema.index({ user: 1, month: 1 }, { unique: true });

export const ReceiptScanUsage = model<IReceiptScanUsage>(
  'ReceiptScanUsage',
  receiptScanUsageSchema
);
