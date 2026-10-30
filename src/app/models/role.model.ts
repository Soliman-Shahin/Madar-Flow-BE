import { Schema, model, Document, Model } from 'mongoose';
import { Permission } from '../types/permissions.types';

export interface RoleDocument extends Document {
  name: string;
  slug: string;
  description?: string;
  permissions: Permission[];
  isSystem: boolean; // Cannot be deleted if true
}

const RoleSchema = new Schema<RoleDocument>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    description: {
      type: String,
      trim: true,
    },
    permissions: {
      type: [String],
      default: [],
    },
    isSystem: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Indexes

const Role = model<RoleDocument, Model<RoleDocument>>('Role', RoleSchema);
export { Role };
