import { Schema, model, Document, Types } from 'mongoose';
import {
  CLIENT_ID_INDEX_KEYS,
  CLIENT_ID_INDEX_OPTIONS,
} from './client-id-index';

export interface IExpense extends Document {
  description: string;
  amount: number;
  category: Types.ObjectId;
  date: Date;
  user: Types.ObjectId;
  // Sync fields
  _syncStatus?: 'synced' | 'pending' | 'conflict' | 'error' | 'offline';
  _lastModified?: Date;
  _version?: number;
  _resolutionConflictId?: string;
  _isDeleted?: boolean;
  _conflictData?: any;
  _clientId?: string; // For offline sync
  // Mongoose timestamps
  createdAt?: Date;
  updatedAt?: Date;
  _serverRecordedAt?: Date;
}

const expenseSchema = new Schema(
  {
    description: { type: String, required: true },
    amount: { type: Number, required: true },
    category: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    date: { type: Date, required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Internal observation time. Historical/client-created timestamps are not telemetry.
    _serverRecordedAt: { type: Date, immutable: true, select: false },
    // Sync fields
    _syncStatus: {
      type: String,
      enum: ['synced', 'pending', 'conflict', 'error', 'offline'],
      default: 'synced',
    },
    _lastModified: { type: Date, default: Date.now },
    _version: { type: Number, default: 1 },
    _resolutionConflictId: { type: String },
    _isDeleted: { type: Boolean, default: false },
    _conflictData: { type: Schema.Types.Mixed },
    _clientId: { type: String },
  },
  { timestamps: true }
);

expenseSchema.pre('save', function () {
  if (this.isNew) this.set('_serverRecordedAt', new Date());
});
const hideObservationTime = (
  _document: unknown,
  value: Record<string, unknown>
) => {
  delete value._serverRecordedAt;
  return value;
};
expenseSchema.set('toJSON', { transform: hideObservationTime });
expenseSchema.set('toObject', { transform: hideObservationTime });
expenseSchema.index({ _serverRecordedAt: -1, user: 1 });
expenseSchema.index({ user: 1, _serverRecordedAt: -1 });

// Index for sync operations
expenseSchema.index({ user: 1, _lastModified: -1 });
expenseSchema.index({ user: 1, _syncStatus: 1 });
// Bounded admin analytics and its record drill-down use stored creation dates.
expenseSchema.index({ createdAt: -1, _isDeleted: 1 });
// Covers the activation funnel aggregation (group by owner, latest record).
expenseSchema.index({ _isDeleted: 1, user: 1, createdAt: -1 });
// Client identities are the durable idempotency key for offline CREATE retries.
// Scope it by owner so two accounts can legitimately use the same local key.
expenseSchema.index(CLIENT_ID_INDEX_KEYS, CLIENT_ID_INDEX_OPTIONS);

const Expense = model<IExpense>('Expense', expenseSchema);
export { Expense };
