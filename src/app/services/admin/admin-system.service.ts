import { User } from '../../models/user.model';
import { Expense } from '../../models/expense.model';
import { Category } from '../../models/category.model';
import logger from '../logger.service';
import mongoose from 'mongoose';
import { safeSortField } from '../../shared/search';

export interface SyncTrendDay {
  date: string;
  total: number;
  synced: number;
  pending: number;
  conflict: number;
  error: number;
  offline: number;
}

/**
 * Admin Service
 *
 * Handles cross-user queries and system-wide aggregations for the Admin Dashboard.
 * Bypasses user-scoped logic found in regular services.
 */

export class AdminSystemService {
  /**
   * Get global system statistics
   */
  async getSystemStats() {
    try {
      const [totalUsers, totalExpenses, totalCategories, recentExpenses] =
        await Promise.all([
          User.countDocuments(),
          Expense.countDocuments(),
          Category.countDocuments(),
          // Get 5 most recent expenses across all users for activity feed
          Expense.find()
            .sort({ date: -1 })
            .limit(5)
            .populate('user', 'email username currency')
            .lean(),
        ]);

      return {
        totalUsers,
        totalExpenses,
        totalCategories,
        recentExpenses,
      };
    } catch (error) {
      logger.error('Error fetching system stats:', error as Error);
      throw error;
    }
  }

  /**
   * Get system health metrics
   */
  async getSystemHealth() {
    try {
      const os = require('os');
      const mongoose = require('mongoose');

      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memUsagePercent = (usedMem / totalMem) * 100;

      const cpus = os.cpus();
      const cpuLoad = os.loadavg();

      const dbState = mongoose.connection.readyState;
      const dbStatus =
        dbState === 1
          ? 'Connected'
          : dbState === 2
            ? 'Connecting'
            : dbState === 0
              ? 'Disconnected'
              : 'Unknown';

      return {
        status: 'OK',
        uptime: process.uptime(),
        memory: {
          total: totalMem,
          free: freeMem,
          used: usedMem,
          usagePercent: memUsagePercent.toFixed(2),
        },
        cpu: {
          cores: cpus.length,
          model: cpus[0].model,
          loadAverage: cpuLoad,
        },
        database: {
          status: dbStatus,
          state: dbState,
        },
        timestamp: new Date(),
      };
    } catch (error) {
      logger.error('Error fetching system health:', error as Error);
      throw error;
    }
  }

  /**
   * Get sync operations across all users
   */
  async getSyncOperations(
    page: number = 1,
    limit: number = 20,
    status?: string,
    sortField: string = 'timestamp',
    sortOrder: number = -1
  ) {
    sortField = safeSortField(sortField, 'timestamp');
    try {
      const SyncOperation = mongoose.model('SyncOperation');
      const query: any = {};
      if (status) query.status = status;

      const skip = (page - 1) * limit;
      const [operations, total] = await Promise.all([
        SyncOperation.find(query)
          .sort({ [sortField]: sortOrder as 1 | -1 })
          .skip(skip)
          .limit(limit)
          .populate('user', 'email username')
          .lean(),
        SyncOperation.countDocuments(query),
      ]);

      return {
        data: operations,
        pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      };
    } catch (error) {
      logger.error('Error fetching admin sync operations:', error as Error);
      throw error;
    }
  }

  /**
   * Get the daily sync operation trend (UTC days, gap-filled).
   *
   * Read-only aggregate used by the sync dashboard. Days are clamped so a
   * malformed query cannot trigger an unbounded aggregation.
   */
  async getSyncTrend(days: number = 14, now: Date = new Date()) {
    const DAY = 86_400_000;
    const range = Math.min(Math.max(Math.trunc(Number(days)) || 14, 1), 90);
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    const start = new Date(today.getTime() - (range - 1) * DAY);
    const endExclusive = new Date(today.getTime() + DAY);

    try {
      const SyncOperation = mongoose.model('SyncOperation');
      const rows: {
        _id: { date?: string; status?: string };
        count?: number;
      }[] = await SyncOperation.aggregate([
        { $match: { timestamp: { $gte: start, $lt: endExclusive } } },
        {
          $group: {
            _id: {
              date: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$timestamp',
                  timezone: 'UTC',
                },
              },
              status: '$status',
            },
            count: { $sum: 1 },
          },
        },
      ]);

      const buckets = new Map<string, SyncTrendDay>();
      for (let index = 0; index < range; index += 1) {
        const date = new Date(start.getTime() + index * DAY)
          .toISOString()
          .slice(0, 10);
        buckets.set(date, {
          date,
          total: 0,
          synced: 0,
          pending: 0,
          conflict: 0,
          error: 0,
          offline: 0,
        });
      }
      for (const row of rows) {
        const bucket = row._id?.date ? buckets.get(row._id.date) : undefined;
        if (!bucket) continue;
        const count = Number(row.count) || 0;
        bucket.total += count;
        switch (row._id?.status) {
          case 'synced':
          case 'pending':
          case 'conflict':
          case 'error':
          case 'offline':
            bucket[row._id.status] += count;
            break;
          default:
            break;
        }
      }

      const series = [...buckets.values()];
      const totals = series.reduce(
        (acc, day) => ({
          total: acc.total + day.total,
          synced: acc.synced + day.synced,
          pending: acc.pending + day.pending,
          conflict: acc.conflict + day.conflict,
          error: acc.error + day.error,
          offline: acc.offline + day.offline,
        }),
        {
          total: 0,
          synced: 0,
          pending: 0,
          conflict: 0,
          error: 0,
          offline: 0,
        }
      );

      return {
        period: {
          days: range,
          timezone: 'UTC',
          start: start.toISOString(),
          endExclusive: endExclusive.toISOString(),
          generatedAt: new Date().toISOString(),
        },
        totals,
        series,
      };
    } catch (error) {
      logger.error('Error fetching sync trend:', error as Error);
      throw error;
    }
  }

  /**
   * Get sync conflicts
   */
  async getSyncConflicts(
    page: number = 1,
    limit: number = 20,
    sortField: string = 'timestamp',
    sortOrder: number = -1
  ) {
    sortField = safeSortField(sortField, 'timestamp');
    try {
      const ConflictResolution = mongoose.model('ConflictResolution');
      const skip = (page - 1) * limit;

      const [conflicts, total] = await Promise.all([
        ConflictResolution.find()
          .sort({ [sortField]: sortOrder as 1 | -1 })
          .skip(skip)
          .limit(limit)
          .populate('user', 'email username')
          .lean(),
        ConflictResolution.countDocuments(),
      ]);

      return {
        data: conflicts,
        pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      };
    } catch (error) {
      logger.error('Error fetching admin sync conflicts:', error as Error);
      throw error;
    }
  }
}
