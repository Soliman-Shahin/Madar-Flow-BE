import { User } from '../models/user.model';
import { Subscription } from '../models/subscription.model';
import {
  AnalyticsFilters,
  AnalyticsPeriodSelection,
  resolveAnalyticsPeriod,
} from './admin-analytics.service';

const DAY = 86_400_000;
const consumers = { role: 'user', _isDeleted: { $ne: true } };
const paidTiers = ['pro', 'premium'];

export class SubscriptionAnalyticsService {
  async overview(
    selection: AnalyticsPeriodSelection,
    horizon: 7 | 30,
    page: number,
    now = new Date(),
    filters: Pick<AnalyticsFilters, 'plan'> = {}
  ) {
    const period = resolveAnalyticsPeriod(selection, now);
    const { days, start, end } = period;
    const until = new Date(now.getTime() + horizon * DAY);
    const [accountResults, history] = await Promise.all([
      User.aggregate([
        {
          $match: {
            ...consumers,
            ...(filters.plan ? { plan: filters.plan } : {}),
          },
        },
        {
          $lookup: {
            from: 'subscriptions',
            localField: '_id',
            foreignField: 'user',
            pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }],
            as: 'history',
          },
        },
        {
          $lookup: {
            from: 'subscriptions',
            localField: '_id',
            foreignField: 'user',
            pipeline: [
              {
                $match: {
                  status: { $in: ['active', 'trial'] },
                  startDate: { $lte: now },
                  $and: [
                    { $or: [{ endDate: null }, { endDate: { $gt: now } }] },
                    {
                      $or: [
                        { status: { $ne: 'trial' } },
                        { trialEndsAt: null },
                        { trialEndsAt: { $gt: now } },
                      ],
                    },
                  ],
                },
              },
              { $sort: { startDate: -1, createdAt: -1, _id: -1 } },
              {
                $group: {
                  _id: null,
                  count: { $sum: 1 },
                  latestPlan: { $first: '$plan' },
                },
              },
              {
                $lookup: {
                  from: 'plans',
                  localField: 'latestPlan',
                  foreignField: '_id',
                  pipeline: [{ $project: { slug: 1 } }],
                  as: 'planInfo',
                },
              },
              {
                $project: {
                  count: 1,
                  planSlug: {
                    $ifNull: [{ $arrayElemAt: ['$planInfo.slug', 0] }, null],
                  },
                },
              },
            ],
            as: 'currentHistoryCount',
          },
        },
        {
          $set: {
            paidTier: { $in: ['$plan', paidTiers] },
            latest: { $arrayElemAt: ['$currentHistoryCount', 0] },
          },
        },
        {
          $set: {
            expired: {
              $and: [
                '$paidTier',
                { $ne: [{ $ifNull: ['$planExpiresAt', null] }, null] },
                { $lte: ['$planExpiresAt', now] },
              ],
            },
            latestCurrent: { $gt: [{ $ifNull: ['$latest.count', 0] }, 0] },
          },
        },
        {
          $facet: {
            summary: [
              {
                $group: {
                  _id: null,
                  retainedAccounts: { $sum: 1 },
                  paidTierAssignments: { $sum: { $cond: ['$paidTier', 1, 0] } },
                  unexpiredAssignments: {
                    $sum: {
                      $cond: [
                        { $and: ['$paidTier', { $not: ['$expired'] }] },
                        1,
                        0,
                      ],
                    },
                  },
                  expiredAssignments: { $sum: { $cond: ['$expired', 1, 0] } },
                  noExpiry: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            '$paidTier',
                            {
                              $eq: [
                                { $ifNull: ['$planExpiresAt', null] },
                                null,
                              ],
                            },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  disabledAssignments: {
                    $sum: {
                      $cond: [
                        { $and: ['$paidTier', { $eq: ['$isActive', false] }] },
                        1,
                        0,
                      ],
                    },
                  },
                  missingHistory: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            '$paidTier',
                            { $eq: [{ $size: '$history' }, 0] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  mismatchedHistory: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            '$latestCurrent',
                            { $ne: ['$latest.planSlug', '$plan'] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  duplicateCurrentHistory: {
                    $sum: {
                      $cond: [
                        {
                          $gt: [
                            {
                              $ifNull: [
                                {
                                  $arrayElemAt: [
                                    '$currentHistoryCount.count',
                                    0,
                                  ],
                                },
                                0,
                              ],
                            },
                            1,
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                },
              },
            ],
            expiringRows: [
              {
                $match: {
                  paidTier: true,
                  planExpiresAt: { $gt: now, $lte: until },
                },
              },
              { $sort: { planExpiresAt: 1, _id: 1 } },
              { $skip: (page - 1) * 10 },
              { $limit: 10 },
              {
                $project: {
                  title: {
                    $ifNull: [
                      '$fullName',
                      { $ifNull: ['$username', '$email'] },
                    ],
                  },
                  email: 1,
                  plan: 1,
                  planExpiresAt: 1,
                  isActive: { $ne: ['$isActive', false] },
                },
              },
            ],
            expiringTotal: [
              {
                $match: {
                  paidTier: true,
                  planExpiresAt: { $gt: now, $lte: until },
                },
              },
              { $count: 'count' },
            ],
          },
        },
      ]),
      Subscription.aggregate([
        { $match: { startDate: { $gte: start, $lt: end } } },
        {
          $lookup: {
            from: 'users',
            localField: 'user',
            foreignField: '_id',
            pipeline: [
              {
                $match: {
                  ...consumers,
                  ...(filters.plan ? { plan: filters.plan } : {}),
                },
              },
              { $project: { _id: 1 } },
            ],
            as: 'owner',
          },
        },
        { $match: { 'owner.0': { $exists: true } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$startDate',
                timezone: 'UTC',
              },
            },
            records: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);
    const summary = accountResults[0]?.summary[0] || {};
    const expiring = {
      rows: accountResults[0]?.expiringRows || [],
      total: accountResults[0]?.expiringTotal || [],
    };
    const daily = new Map<string, number>(
      history.map((row) => [row._id, row.records])
    );
    return {
      period: {
        days,
        presetDays: period.presetDays,
        comparison: period.comparison,
        start: start.toISOString(),
        endExclusive: end.toISOString(),
        timezone: 'UTC',
        generatedAt: now.toISOString(),
      },
      horizon,
      filters: { plan: filters.plan || null },
      metrics: Object.fromEntries(
        [
          'retainedAccounts',
          'paidTierAssignments',
          'unexpiredAssignments',
          'expiredAssignments',
          'noExpiry',
          'disabledAssignments',
          'missingHistory',
          'mismatchedHistory',
          'duplicateCurrentHistory',
        ].map((field) => [field, summary[field] || 0])
      ),
      expiring: {
        rows: expiring.rows,
        total: expiring.total[0]?.count || 0,
        page,
        limit: 10,
        until: until.toISOString(),
      },
      history: Array.from({ length: days }, (_, index) => {
        const date = new Date(start.getTime() + index * DAY)
          .toISOString()
          .slice(0, 10);
        return { date, records: daily.get(date) || 0 };
      }),
    };
  }
}
export const subscriptionAnalyticsService = new SubscriptionAnalyticsService();
