import { Model } from 'mongoose';
import { Category } from '../models/category.model';
import { Expense } from '../models/expense.model';
import {
  CLIENT_ID_INDEX_KEYS,
  CLIENT_ID_INDEX_NAME,
  CLIENT_ID_INDEX_OPTIONS,
} from '../models/client-id-index';

export interface ClientIdIndexCollectionReport {
  collection: string;
  /** Name of the legacy sparse index, if it still exists. */
  legacyIndex: string | null;
  partialIndexPresent: boolean;
  /** (user, string _clientId) pairs held by more than one document. */
  duplicateClientIds: number;
  actions: string[];
  error?: string;
}

const sameKeys = (key: Record<string, unknown>) =>
  JSON.stringify(key) === JSON.stringify(CLIENT_ID_INDEX_KEYS);

/**
 * Replaces the legacy sparse `{user, _clientId}` unique index with the partial
 * one, with no gap in uniqueness: the partial index is ensured first and the
 * legacy index is dropped only after the partial index exists. Dry-run
 * unless `apply`. Idempotent: re-running after success does nothing.
 */
async function migrateCollection(
  model: Model<any>,
  apply: boolean
): Promise<ClientIdIndexCollectionReport> {
  const collection = model.collection;
  const report: ClientIdIndexCollectionReport = {
    collection: collection.collectionName,
    legacyIndex: null,
    partialIndexPresent: false,
    duplicateClientIds: 0,
    actions: [],
  };

  const indexes = await collection.indexes();
  const legacy = indexes.find(
    (i) =>
      sameKeys(i.key) &&
      i.name !== CLIENT_ID_INDEX_NAME &&
      !i.partialFilterExpression
  );
  report.legacyIndex = legacy?.name ?? null;
  report.partialIndexPresent = indexes.some(
    (i) => i.name === CLIENT_ID_INDEX_NAME
  );

  const duplicates = await collection
    .aggregate([
      { $match: { _clientId: { $type: 'string' } } },
      {
        $group: {
          _id: { user: '$user', clientId: '$_clientId' },
          n: { $sum: 1 },
        },
      },
      { $match: { n: { $gt: 1 } } },
      { $count: 'pairs' },
    ])
    .toArray();
  report.duplicateClientIds = duplicates[0]?.pairs ?? 0;

  if (!report.partialIndexPresent)
    report.actions.push(`create ${CLIENT_ID_INDEX_NAME}`);
  if (report.legacyIndex) report.actions.push(`drop ${report.legacyIndex}`);
  if (!apply || report.actions.length === 0) return report;

  if (report.duplicateClientIds > 0) {
    report.error =
      'duplicate (user, _clientId) pairs exist; resolve them first (nothing changed)';
    return report;
  }

  try {
    if (!report.partialIndexPresent) {
      await collection.createIndex(
        CLIENT_ID_INDEX_KEYS,
        CLIENT_ID_INDEX_OPTIONS
      );
      report.partialIndexPresent = true;
    }
    const confirmed = (await collection.indexes()).find(
      (i) => i.name === CLIENT_ID_INDEX_NAME
    );
    if (!confirmed?.unique || !confirmed.partialFilterExpression)
      throw new Error(
        `${CLIENT_ID_INDEX_NAME} is missing or not unique/partial after creation`
      );
    if (report.legacyIndex) {
      await collection.dropIndex(report.legacyIndex);
      report.legacyIndex = null;
    }
    report.actions = report.actions.map((a) => `${a} (done)`);
  } catch (error: any) {
    // The legacy index is only dropped after the partial index is confirmed,
    // so a failure here never leaves the collection without uniqueness.
    report.error = error?.codeName || error?.message || 'unknown error';
  }
  return report;
}

export async function migrateClientIdIndexes(
  apply: boolean
): Promise<ClientIdIndexCollectionReport[]> {
  return [
    await migrateCollection(Expense, apply),
    await migrateCollection(Category, apply),
  ];
}
