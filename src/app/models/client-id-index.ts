/**
 * Per-owner uniqueness of offline client identities (`_clientId`), shared by
 * expenses and categories.
 *
 * Partial, not sparse: a sparse compound index still indexes documents that
 * have `user` but no `_clientId` (as null), so a second such document for the
 * same user would fail with E11000. The partial filter only indexes string ids.
 */
export const CLIENT_ID_INDEX_KEYS = { user: 1, _clientId: 1 } as const;
export const CLIENT_ID_INDEX_NAME = 'user_1__clientId_1_partial';
export const CLIENT_ID_INDEX_OPTIONS = {
  name: CLIENT_ID_INDEX_NAME,
  unique: true,
  partialFilterExpression: { _clientId: { $type: 'string' } },
};
