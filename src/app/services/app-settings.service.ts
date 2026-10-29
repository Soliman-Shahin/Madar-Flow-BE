import { Types } from 'mongoose';
import { AppSettings } from '../models/app-settings.model';
import { AppError } from '../shared/errors';
import type { AppSettingsUpdate } from '../validations/app-settings.validation';

export const APP_SETTINGS_SECTIONS = [
  'support',
  'legal',
  'faq',
  'maintenance',
  'versioning',
] as const;
export type AppSettingsSection = (typeof APP_SETTINGS_SECTIONS)[number];

type Plain = Record<string, any>;

const stable = (value: unknown) => JSON.stringify(value ?? null);

function sections(doc: Plain | null): Plain {
  const out: Plain = {};
  if (!doc) return out;
  for (const key of APP_SETTINGS_SECTIONS) {
    const value = doc[key];
    // Mongoose defaults arrays to []; an empty section means "not configured".
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (key === 'support' && Array.isArray(value.links) && !value.links.length) {
      const { links, ...rest } = value;
      out[key] = rest;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Legal documents carry their own "last updated" date. It moves only when the
 * version, title or body actually changed, never on unrelated saves.
 */
function stampLegal(
  next: Plain,
  previous: Plain | undefined,
  now: Date
): Plain {
  const out: Plain = {};
  for (const kind of ['terms', 'privacy'] as const) {
    const doc = next[kind];
    if (!doc) continue;
    const before = previous?.[kind];
    const same =
      before &&
      stable({ v: before.version, t: before.title, b: before.body }) ===
        stable({ v: doc.version, t: doc.title, b: doc.body });
    out[kind] = { ...doc, updatedAt: same ? (before.updatedAt ?? now) : now };
  }
  return out;
}

export class AppSettingsService {
  /** Create the singleton on first use. A concurrent creator is not an error. */
  private async ensure(): Promise<void> {
    try {
      await AppSettings.updateOne(
        { key: 'app' },
        { $setOnInsert: { key: 'app', revision: 0 } },
        { upsert: true }
      );
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
    }
  }

  /** Public payload: only configured sections; clients keep defaults for the rest. */
  async getPublic(): Promise<Plain> {
    const doc = await AppSettings.findOne({ key: 'app' }).lean<Plain>();
    return {
      revision: doc?.revision ?? 0,
      updatedAt: doc?.updatedAt ?? null,
      ...sections(doc),
    };
  }

  async getForAdmin(): Promise<Plain> {
    await this.ensure();
    const doc = await AppSettings.findOne({ key: 'app' }).lean<Plain>();
    return {
      revision: doc?.revision ?? 0,
      updatedAt: doc?.updatedAt ?? null,
      updatedBy: doc?.updatedBy ? String(doc.updatedBy) : null,
      ...sections(doc),
    };
  }

  /**
   * Replace the provided sections (`null` clears one). Optimistic concurrency:
   * the write only succeeds when `revision` matches the stored revision.
   */
  async update(
    body: AppSettingsUpdate,
    actorId: string
  ): Promise<{ settings: Plain; changed: AppSettingsSection[] }> {
    await this.ensure();
    const current = await AppSettings.findOne({ key: 'app' }).lean<Plain>();

    const $set: Plain = { updatedBy: new Types.ObjectId(actorId) };
    const $unset: Plain = {};
    const changed: AppSettingsSection[] = [];

    for (const key of APP_SETTINGS_SECTIONS) {
      const value = (body as Plain)[key];
      if (value === undefined) continue;
      if (value === null) {
        $unset[key] = '';
      } else if (key === 'legal') {
        $set[key] = stampLegal(value, current?.legal, new Date());
      } else {
        $set[key] = value;
      }
      changed.push(key);
    }

    const update: Plain = { $set, $inc: { revision: 1 } };
    if (Object.keys($unset).length) update.$unset = $unset;

    const updated = await AppSettings.findOneAndUpdate(
      { key: 'app', revision: body.revision },
      update,
      { returnDocument: 'after', runValidators: true }
    ).lean<Plain>();

    if (!updated) {
      const latest = await AppSettings.findOne({ key: 'app' })
        .select('revision')
        .lean<Plain>();
      throw new AppError(
        'App settings were changed by someone else. Reload and try again.',
        409,
        'REVISION_CONFLICT',
        true,
        { currentRevision: latest?.revision ?? 0 }
      );
    }

    return {
      settings: {
        revision: updated.revision,
        updatedAt: updated.updatedAt,
        updatedBy: updated.updatedBy ? String(updated.updatedBy) : null,
        ...sections(updated),
      },
      changed,
    };
  }
}

export const appSettingsService = new AppSettingsService();
