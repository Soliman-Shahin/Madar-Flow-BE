import { Document, Schema, Types, model } from 'mongoose';

export interface ISyncRegistration extends Document {
  receiptId: string;
  user: Types.ObjectId;
  clientOperationId: string;
  operationType: 'CREATE' | 'UPDATE' | 'DELETE';
  entityType: string;
  entityId: string;
  baseVersion?: number;
  fingerprint: string;
  state: 'registered' | 'completed';
}

const schema = new Schema<ISyncRegistration>(
  {
    receiptId: { type: String, required: true, unique: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    clientOperationId: { type: String, required: true, maxlength: 64 },
    operationType: {
      type: String,
      enum: ['CREATE', 'UPDATE', 'DELETE'],
      required: true,
    },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true, maxlength: 200 },
    baseVersion: { type: Number, min: 0 },
    fingerprint: { type: String, required: true, maxlength: 64 },
    state: {
      type: String,
      enum: ['registered', 'completed'],
      default: 'registered',
      required: true,
    },
  },
  { timestamps: true, collection: 'sync_registrations' }
);

schema.index({ user: 1, clientOperationId: 1 }, { unique: true });

export const SyncRegistration = model<ISyncRegistration>(
  'SyncRegistration',
  schema
);
