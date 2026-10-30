import { Schema, model, Document, Types } from 'mongoose';

export interface ISyncOperation extends Document {
  id: string;
  type: 'CREATE' | 'UPDATE' | 'DELETE';
  entityType: 'expense' | 'category' | 'user';
  entityId: string;
  data: any;
  timestamp: Date;
  retryCount: number;
  maxRetries: number;
  status: 'synced' | 'pending' | 'conflict' | 'error' | 'offline';
  error?: string;
  user: Types.ObjectId;
}

export interface IConflictResolution extends Document {
  conflictId?: Types.ObjectId;
  entityId: string;
  entityType: string;
  localData: any;
  serverData: any;
  resolution: 'local' | 'server' | 'merge';
  mergedData?: any;
  timestamp: Date;
  user: Types.ObjectId;
}

export interface ISyncConflict extends Document {
  dedupeKey: string;
  entityId: string;
  entityType: string;
  localData: any;
  serverData: any;
  user: Types.ObjectId;
  detectedAt: Date;
  resolvedAt?: Date;
  resolutionState?: 'resolving' | 'resolved';
  claimedResolution?: 'local' | 'server' | 'merge';
  appliedRevision?: number;
}

export interface ISyncMetadata extends Document {
  lastSyncTime: Date;
  totalEntities: number;
  pendingCount: number;
  conflictCount: number;
  errorCount: number;
  isOnline: boolean;
  isSyncing: boolean;
  user: Types.ObjectId;
}

const syncOperationSchema = new Schema(
  {
    id: { type: String, required: true, unique: true },
    type: {
      type: String,
      enum: ['CREATE', 'UPDATE', 'DELETE'],
      required: true,
    },
    entityType: {
      type: String,
      enum: ['expense', 'category', 'user'],
      required: true,
    },
    entityId: { type: String, required: true },
    data: { type: Schema.Types.Mixed, required: true },
    timestamp: { type: Date, default: Date.now },
    retryCount: { type: Number, default: 0 },
    maxRetries: { type: Number, default: 3 },
    status: {
      type: String,
      enum: ['synced', 'pending', 'conflict', 'error', 'offline'],
      default: 'pending',
    },
    error: { type: String },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

const conflictResolutionSchema = new Schema(
  {
    conflictId: { type: Schema.Types.ObjectId, ref: 'SyncConflict' },
    entityId: { type: String, required: true },
    entityType: { type: String, required: true },
    localData: { type: Schema.Types.Mixed, required: true },
    serverData: { type: Schema.Types.Mixed, required: true },
    resolution: {
      type: String,
      enum: ['local', 'server', 'merge'],
      required: true,
    },
    mergedData: { type: Schema.Types.Mixed },
    timestamp: { type: Date, default: Date.now },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

const syncConflictSchema = new Schema<ISyncConflict>(
  {
    dedupeKey: { type: String, required: true, unique: true },
    entityId: { type: String, required: true },
    entityType: { type: String, required: true },
    localData: { type: Schema.Types.Mixed, required: true },
    serverData: { type: Schema.Types.Mixed, required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    detectedAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date },
    resolutionState: { type: String, enum: ['resolving', 'resolved'] },
    claimedResolution: { type: String, enum: ['local', 'server', 'merge'] },
    appliedRevision: { type: Number },
  },
  { timestamps: true, collection: 'sync_conflicts' }
);

const syncMetadataSchema = new Schema(
  {
    lastSyncTime: { type: Date, default: Date.now },
    totalEntities: { type: Number, default: 0 },
    pendingCount: { type: Number, default: 0 },
    conflictCount: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    isOnline: { type: Boolean, default: true },
    isSyncing: { type: Boolean, default: false },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
  },
  { timestamps: true }
);

// Indexes for sync operations
syncOperationSchema.index({ user: 1, status: 1 });
syncOperationSchema.index({ user: 1, timestamp: -1 });
syncOperationSchema.index({ status: 1, user: 1 });
// Admin trend aggregation scans a timestamp range grouped by status.
syncOperationSchema.index({ timestamp: -1, status: 1 });

conflictResolutionSchema.index({ user: 1, timestamp: -1 });
conflictResolutionSchema.index({ entityId: 1, entityType: 1 });
conflictResolutionSchema.index(
  { conflictId: 1 },
  { unique: true, sparse: true }
);
syncConflictSchema.index({ user: 1, resolvedAt: 1, detectedAt: -1 });
syncConflictSchema.index({ resolvedAt: 1, detectedAt: -1 });

export const SyncOperation = model<ISyncOperation>(
  'SyncOperation',
  syncOperationSchema
);
export const ConflictResolution = model<IConflictResolution>(
  'ConflictResolution',
  conflictResolutionSchema
);
export const SyncConflict = model<ISyncConflict>(
  'SyncConflict',
  syncConflictSchema
);
export const SyncMetadata = model<ISyncMetadata>(
  'SyncMetadata',
  syncMetadataSchema
);
