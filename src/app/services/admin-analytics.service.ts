import { PipelineStage } from 'mongoose';
import { PlanSlug } from '../types/plan.types';
import { User } from '../models/user.model';
import { Expense } from '../models/expense.model';
import { SyncConflict, SyncOperation } from '../models/sync.model';

export type AnalyticsDays = 7 | 30 | 90;
export type AnalyticsKind = 'newUsers' | 'recordingUsers' | 'expenses';
export interface AnalyticsFilters {
  plan?: string;
  type?: 'income' | 'outcome';
}
const DAY = 86_400_000;
// A retained consumer account may be disabled. Disabled is not deleted.
const consumers = { role: 'user', _isDeleted: { $ne: true } };
const live = { _isDeleted: { $ne: true } };
const dateKey = {
  $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' },
};
const ownerScope: PipelineStage[] = [
  {
    $lookup: {
      from: 'users',
      localField: 'user',
      foreignField: '_id',
      pipeline: [
        { $match: consumers },
        { $project: { _id: 1, fullName: 1, username: 1, email: 1 } },
      ],
      as: 'owner',
    },
  },
  { $match: { 'owner.0': { $exists: true } } },
];

function consumerScope(filters: AnalyticsFilters) {
  return {
    ...consumers,
    ...(filters.plan ? { plan: filters.plan as PlanSlug } : {}),
  };
}

function filteredOwnerScope(filters: AnalyticsFilters): PipelineStage[] {
  if (!filters.plan) return ownerScope;
  return [
    {
      $lookup: {
        from: 'users',
        localField: 'user',
        foreignField: '_id',
        pipeline: [
          { $match: consumerScope(filters) },
          { $project: { _id: 1, fullName: 1, username: 1, email: 1 } },
        ],
        as: 'owner',
      },
    },
    { $match: { 'owner.0': { $exists: true } } },
  ];
}

function recordTypeScope(filters: AnalyticsFilters): PipelineStage[] {
  if (!filters.type) return [];
  return [
    {
      $lookup: {
        from: 'categories',
        localField: 'category',
        foreignField: '_id',
        pipeline: [
          { $match: { type: filters.type } },
          { $project: { _id: 1 } },
        ],
        as: 'matchingCategory',
      },
    },
    { $match: { 'matchingCategory.0': { $exists: true } } },
    { $unset: 'matchingCategory' },
  ];
}

export function analyticsPeriod(days: AnalyticsDays, now = new Date()) {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  return {
    start: new Date(end.getTime() - days * DAY),
    end,
    previousStart: new Date(end.getTime() - days * DAY * 2),
  };
}

export function compareMetric(current: number, previous: number) {
  return {
    current,
    previous,
    changePercent:
      previous === 0
        ? null
        : Math.round(((current - previous) / previous) * 1000) / 10,
  };
}

function recordingCount(
  from: Date,
  to: Date
): PipelineStage.FacetPipelineStage[] {
  return [
    { $match: { createdAt: { $gte: from, $lt: to } } },
    {
      $group: {
        _id: '$user',
        records: { $sum: 1 },
      },
    },
    {
      $group: { _id: null, records: { $sum: '$records' }, users: { $sum: 1 } },
    },
    { $project: { _id: 0, records: 1, users: 1 } },
  ];
}

export class AdminAnalyticsService {
  async overview(
    days: AnalyticsDays,
    now = new Date(),
    filters: AnalyticsFilters = {}
  ) {
    const { start, end, previousStart } = analyticsPeriod(days, now);
    const [
      userDays,
      expenseResults,
      totalUsers,
      conflictResults,
      errorResults,
    ] = await Promise.all([
      User.aggregate([
        {
          $match: {
            ...consumerScope(filters),
            createdAt: { $gte: previousStart, $lt: end },
          },
        },
        { $group: { _id: dateKey, count: { $sum: 1 } } },
      ]),
      Expense.aggregate([
        { $match: { ...live, createdAt: { $gte: previousStart, $lt: end } } },
        ...filteredOwnerScope(filters),
        ...recordTypeScope(filters),
        {
          $facet: {
            daily: [
              {
                $group: {
                  _id: { date: dateKey, user: '$user' },
                  count: { $sum: 1 },
                },
              },
              {
                $group: {
                  _id: '$_id.date',
                  count: { $sum: '$count' },
                  users: { $sum: 1 },
                },
              },
            ],
            current: recordingCount(start, end),
            previous: recordingCount(previousStart, start),
            categories: [
              { $match: { createdAt: { $gte: start } } },
              { $group: { _id: '$category', count: { $sum: 1 } } },
              {
                $lookup: {
                  from: 'categories',
                  localField: '_id',
                  foreignField: '_id',
                  as: 'categoryInfo',
                },
              },
              // Titles are grouped intentionally: consumer-owned categories can share a name.
              {
                $group: {
                  _id: {
                    $ifNull: [
                      { $arrayElemAt: ['$categoryInfo.title', 0] },
                      null,
                    ],
                  },
                  count: { $sum: '$count' },
                },
              },
              { $sort: { count: -1, _id: 1 } },
              { $limit: 5 },
            ],
          },
        },
      ]),
      User.countDocuments(consumerScope(filters)),
      SyncConflict.aggregate([
        { $match: { resolvedAt: null } },
        ...ownerScope,
        {
          $group: {
            _id: '$user',
            count: { $sum: 1 },
            oldestAt: { $min: '$detectedAt' },
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: '$count' },
            affectedUsers: { $sum: 1 },
            oldestAt: { $min: '$oldestAt' },
          },
        },
        {
          $project: {
            _id: 0,
            count: 1,
            affectedUsers: 1,
            oldestAt: 1,
          },
        },
      ]),
      SyncOperation.aggregate([
        { $match: { status: 'error' } },
        ...ownerScope,
        {
          $group: {
            _id: '$user',
            count: { $sum: 1 },
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: '$count' },
            affectedUsers: { $sum: 1 },
          },
        },
        { $project: { _id: 0, count: 1, affectedUsers: 1 } },
      ]),
    ]);
    const expenses = expenseResults[0];
    const usersByDate = new Map<string, number>(
      userDays.map((row) => [row._id, row.count])
    );
    const expensesByDate = new Map<string, { count: number; users: number }>(
      expenses.daily.map((row: any) => [row._id, row])
    );
    const series = Array.from({ length: days }, (_, index) => {
      const date = new Date(start.getTime() + index * DAY)
        .toISOString()
        .slice(0, 10);
      const previousDate = new Date(previousStart.getTime() + index * DAY)
        .toISOString()
        .slice(0, 10);
      const values = (key: string) => ({
        newUsers: usersByDate.get(key) || 0,
        expenses: expensesByDate.get(key)?.count || 0,
        recordingUsers: expensesByDate.get(key)?.users || 0,
      });
      return {
        date,
        previousDate,
        current: values(date),
        previous: values(previousDate),
      };
    });
    const current = expenses.current[0] || { records: 0, users: 0 };
    const previous = expenses.previous[0] || { records: 0, users: 0 };
    return {
      period: {
        days,
        timezone: 'UTC',
        start: start.toISOString(),
        endExclusive: end.toISOString(),
        previousStart: previousStart.toISOString(),
        generatedAt: now.toISOString(),
      },
      scope: 'retained-consumer-accounts',
      filters: { plan: filters.plan || null, type: filters.type || null },
      totalUsers,
      metrics: {
        newUsers: compareMetric(
          series.reduce((sum, row) => sum + row.current.newUsers, 0),
          series.reduce((sum, row) => sum + row.previous.newUsers, 0)
        ),
        recordingUsers: compareMetric(current.users, previous.users),
        expenses: compareMetric(current.records, previous.records),
      },
      series,
      categories: expenses.categories.map((row: any) => ({
        title: row._id,
        count: row.count,
        share: current.records
          ? Math.round((row.count / current.records) * 1000) / 10
          : 0,
      })),
      operations: {
        openConflicts: conflictResults[0] || {
          count: 0,
          affectedUsers: 0,
          oldestAt: null,
        },
        failedOperations: errorResults[0] || { count: 0, affectedUsers: 0 },
      },
    };
  }

  async records(
    kind: AnalyticsKind,
    days: AnalyticsDays,
    day: string | undefined,
    page: number,
    now = new Date(),
    asOf?: string,
    filters: AnalyticsFilters = {}
  ) {
    // Anchor drill-downs to the overview even if UTC midnight passes between requests.
    const anchor = asOf ? new Date(`${asOf}T00:00:00.000Z`) : now;
    if (
      !Number.isFinite(anchor.getTime()) ||
      (asOf && anchor.toISOString().slice(0, 10) !== asOf) ||
      (asOf && anchor > analyticsPeriod(days, now).end)
    ) {
      throw new RangeError('Invalid analytics period anchor.');
    }
    const period = analyticsPeriod(days, anchor);
    const start = day ? new Date(`${day}T00:00:00.000Z`) : period.start;
    const end = day ? new Date(start.getTime() + DAY) : period.end;
    if (
      !Number.isFinite(start.getTime()) ||
      start < period.start ||
      end > period.end ||
      (day && start.toISOString().slice(0, 10) !== day)
    ) {
      throw new RangeError(
        'Day must be a valid date within the selected completed period.'
      );
    }
    const dates = { $gte: start, $lt: end };
    let pipeline: PipelineStage[];
    if (kind === 'newUsers') {
      pipeline = [
        { $match: { ...consumerScope(filters), createdAt: dates } },
        {
          $project: {
            title: {
              $ifNull: ['$fullName', { $ifNull: ['$username', '$email'] }],
            },
            subtitle: '$email',
            createdAt: 1,
          },
        },
      ];
    } else {
      pipeline = [
        { $match: { ...live, createdAt: dates } },
        ...filteredOwnerScope(filters),
        ...recordTypeScope(filters),
      ];
      if (kind === 'recordingUsers') {
        pipeline.push(
          {
            $group: {
              _id: '$user',
              owner: { $first: { $arrayElemAt: ['$owner', 0] } },
              recordCount: { $sum: 1 },
              createdAt: { $max: '$createdAt' },
            },
          },
          {
            $project: {
              title: {
                $ifNull: [
                  '$owner.fullName',
                  { $ifNull: ['$owner.username', '$owner.email'] },
                ],
              },
              subtitle: '$owner.email',
              createdAt: 1,
              recordCount: 1,
            },
          }
        );
      } else {
        pipeline.push({
          $project: {
            title: '$description',
            subtitle: { $arrayElemAt: ['$owner.email', 0] },
            createdAt: 1,
          },
        });
      }
    }
    pipeline.push({
      $facet: {
        rows: [
          { $sort: { createdAt: -1, _id: 1 } },
          { $skip: (page - 1) * 10 },
          { $limit: 10 },
        ],
        total: [{ $count: 'count' }],
      },
    });
    const result =
      kind === 'newUsers'
        ? await User.aggregate(pipeline)
        : await Expense.aggregate(pipeline);
    return {
      rows: result[0].rows,
      total: result[0].total[0]?.count || 0,
      page,
      limit: 10,
      start: start.toISOString(),
      endExclusive: end.toISOString(),
      filters: { plan: filters.plan || null, type: filters.type || null },
    };
  }
}

export const adminAnalyticsService = new AdminAnalyticsService();
