import { Schema, model, Document, Types } from 'mongoose';
import { Expense } from './expense.model';
import {
  CLIENT_ID_INDEX_KEYS,
  CLIENT_ID_INDEX_OPTIONS,
} from './client-id-index';

export interface ICategory extends Document {
  title: string;
  icon: string;
  color: string;
  type: 'income' | 'outcome';
  order: number;
  user: Types.ObjectId;
  isDefault: boolean;
  isActive: boolean;
  // Sync fields
  _syncStatus?: 'synced' | 'pending' | 'conflict' | 'error' | 'offline';
  _lastModified?: Date;
  _version?: number;
  _resolutionConflictId?: string;
  _isDeleted?: boolean;
  _conflictData?: any;
  _clientId?: string;
  // Mongoose timestamps
  createdAt?: Date;
  updatedAt?: Date;
}

const categorySchema = new Schema(
  {
    title: { type: String, required: true },
    icon: { type: String, required: true },
    color: { type: String, required: true },
    type: {
      type: String,
      enum: ['income', 'outcome'],
      default: 'outcome',
    },
    order: { type: Number, default: 0 },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
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

// Create the Category model using generics
categorySchema.pre(
  'deleteOne',
  { document: true, query: false },
  async function () {
    try {
      // Find the default category for the user

      // @ts-ignore
      const defaultCategory = await this.constructor.findOne({
        user: this.user,
        isDefault: true,
      });

      if (defaultCategory) {
        // Re-assign expenses to the default category
        await Expense.updateMany(
          { category: this._id },
          { $set: { category: defaultCategory._id } }
        );
      } else {
        // Fallback for safety, though this should not be reached for new users
        await Expense.updateMany(
          { category: this._id },
          { $set: { category: null } }
        );
      }
    } catch (error: any) {
      throw error;
    }
  }
);

// Index for sync operations
categorySchema.index({ user: 1, _lastModified: -1 });
categorySchema.index({ user: 1, _syncStatus: 1 });
// Client identities are the durable idempotency key for offline CREATE retries.
categorySchema.index(CLIENT_ID_INDEX_KEYS, CLIENT_ID_INDEX_OPTIONS);
// Index for filtering by user and type (income/outcome)
categorySchema.index({ user: 1, type: 1 });
// Index for ordering categories
categorySchema.index({ user: 1, order: 1 });

const Category = model<ICategory>('Category', categorySchema);
export { Category };
