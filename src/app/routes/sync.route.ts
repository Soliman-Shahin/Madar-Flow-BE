import { Router } from 'express';
import { syncController } from '../controllers/sync.controller';
import { verifyAccessToken } from '../middleware/access.middleware';
import { rateLimitSync } from '../middleware/sync.middleware';
import { validateRequest } from '../middleware/validation.middleware';
import { body, query } from 'express-validator';

const router = Router();

// Apply JWT auth middleware to all sync routes
router.use(verifyAccessToken);

// Per-user limit; it has to sit after authentication to know who is calling.
router.use(rateLimitSync(100, 15 * 60 * 1000));

// ==================== SYNC DATA ROUTES ====================

/**
 * @route GET /sync/pull
 * @desc Pull sync data from server
 * @access Private
 */
router.get(
  '/pull',
  [
    query('lastSyncTime')
      .optional()
      .isISO8601()
      .withMessage('Invalid lastSyncTime format'),
    query('entityType')
      .optional()
      .isIn(['expense', 'category', 'user'])
      .withMessage('Invalid entityType'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Offset must be non-negative'),
    validateRequest,
  ],
  (req: any, res: any, next: any) => {
    syncController.pullData(req, res, next);
  }
);

/**
 * @route POST /sync/push
 * @desc Push sync data to server
 * @access Private
 */
router.post(
  '/push',
  [
    body('entities').isArray().withMessage('Entities must be an array'),
    body('entities.*._entityType')
      .isIn(['expense', 'category', 'user'])
      .withMessage('Invalid entity type'),
    body('entities.*._id').notEmpty().withMessage('Entity ID is required'),
    validateRequest,
  ],
  (req: any, res: any, next: any) => {
    syncController.pushData(req, res, next);
  }
);

/**
 * @route POST /sync/bulk
 * @desc Bulk sync operation
 * @access Private
 */
router.post(
  '/bulk',
  [
    body('entities').isArray().withMessage('Entities must be an array'),
    validateRequest,
  ],
  (req: any, res: any, next: any) => {
    syncController.bulkSync(req, res, next);
  }
);

// ==================== CONFLICT RESOLUTION ROUTES ====================

/**
 * @route GET /sync/conflicts
 * @desc Get user conflicts
 * @access Private
 */
router.get('/conflicts', (req: any, res: any, next: any) => {
  syncController.getConflicts(req, res, next);
});

/**
 * @route POST /sync/conflicts/resolve
 * @desc Resolve a conflict
 * @access Private
 */
router.post(
  '/conflicts/resolve',
  [
    body('entityId').notEmpty().withMessage('Entity ID is required'),
    body('entityType')
      .isIn(['expense', 'category', 'user'])
      .withMessage('Invalid entity type'),
    body('resolution')
      .isIn(['local', 'server', 'merge'])
      .withMessage('Invalid resolution type'),
    body('mergedData')
      .optional()
      .isObject()
      .withMessage('Merged data must be an object'),
    validateRequest,
  ],
  (req: any, res: any, next: any) => {
    syncController.resolveConflict(req, res, next);
  }
);

// ==================== METADATA ROUTES ====================

/**
 * @route GET /sync/metadata
 * @desc Get sync metadata
 * @access Private
 */
router.get('/metadata', (req: any, res: any, next: any) => {
  syncController.getSyncMetadata(req, res, next);
});

/**
 * @route PUT /sync/metadata
 * @desc Update sync metadata
 * @access Private
 */
router.put(
  '/metadata',
  [
    body('lastSyncTime')
      .optional()
      .isISO8601()
      .withMessage('Invalid lastSyncTime format'),
    body('totalEntities')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Total entities must be non-negative'),
    body('pendingCount')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Pending count must be non-negative'),
    body('conflictCount')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Conflict count must be non-negative'),
    body('errorCount')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Error count must be non-negative'),
    body('isOnline')
      .optional()
      .isBoolean()
      .withMessage('isOnline must be boolean'),
    body('isSyncing')
      .optional()
      .isBoolean()
      .withMessage('isSyncing must be boolean'),
    validateRequest,
  ],
  (req: any, res: any, next: any) => {
    syncController.updateSyncMetadata(req, res, next);
  }
);

// ==================== UTILITY ROUTES ====================

/**
 * @route POST /sync/force-sync
 * @desc Force sync all data
 * @access Private
 */
router.post('/force-sync', (req: any, res: any, next: any) => {
  syncController.forceSync(req, res, next);
});

/**
 * @route GET /sync/status
 * @desc Get sync status
 * @access Private
 */
router.get('/status', (req: any, res: any, next: any) => {
  syncController.getSyncStatus(req, res, next);
});

/**
 * @route DELETE /sync/cleanup
 * @desc Cleanup old sync data
 * @access Private
 */
router.delete(
  '/cleanup',
  [
    query('olderThanDays')
      .optional()
      .isInt({ min: 1, max: 365 })
      .withMessage('Days must be between 1 and 365'),
    validateRequest,
  ],
  (req: any, res: any, next: any) => {
    syncController.cleanupSyncData(req, res, next);
  }
);

export default router;
