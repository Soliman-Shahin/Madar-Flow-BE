import { PipelineStage } from 'mongoose';
import { Expense } from '../models/expense.model';
import { User } from '../models/user.model';
import {
  AnalyticsFilters,
  AnalyticsPeriodSelection,
  resolveAnalyticsPeriod,
} from './admin-analytics.service';

const DAY = 86_400_000;
const consumers = { role: 'user', _isDeleted: { $ne: true } };
const consumerScope = (filters: AnalyticsFilters) => ({
  ...consumers,
  ...(filters.plan ? { plan: filters.plan } : {}),
});
const retainedOwners = (filters: AnalyticsFilters): PipelineStage[] => [
  {
    $lookup: {
      from: 'users',
      localField: 'user',
      foreignField: '_id',
      pipeline: [{ $match: consumerScope(filters) }, { $project: { _id: 1 } }],
      as: 'owner',
    },
  },
  { $match: { 'owner.0': { $exists: true } } },
];
const recordTypeScope = (filters: AnalyticsFilters): any[] =>
  filters.type
    ? [
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
      ]
    : [];
const key = (value: Date) => value.toISOString().slice(0, 10);
const midnight = (value: Date) => {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

export class EngagementAnalyticsService {
  async overview(
    selection: AnalyticsPeriodSelection,
    now = new Date(),
    filters: AnalyticsFilters = {}
  ) {
    const period = resolveAnalyticsPeriod(selection, now);
    const { days, start, end, previousStart, previousEnd } = period;
    const coverageRows = await Expense.aggregate([
      {
        $match: {
          _isDeleted: { $ne: true },
          _serverRecordedAt: { $type: 'date' },
        },
      },
      ...retainedOwners(filters),
      ...recordTypeScope(filters),
      {
        $group: {
          _id: null,
          firstObservedAt: { $min: '$_serverRecordedAt' },
          observedRecords: { $sum: 1 },
        },
      },
    ]);
    const firstObservedAt: Date | null =
      coverageRows[0]?.firstObservedAt || null;
    // The first observation day may be partial, so complete coverage starts the next UTC day.
    const completeFrom = firstObservedAt
      ? new Date(midnight(firstObservedAt).getTime() + DAY)
      : null;
    const effectiveStart =
      completeFrom && completeFrom > start ? completeFrom : start;
    const effectivePreviousStart =
      completeFrom && completeFrom > previousStart
        ? completeFrom
        : previousStart;
    const covered = (date: Date) =>
      !!completeFrom && date >= completeFrom && date < end;
    const empty = { daily: [], current: [], previous: [] };
    const activityResults =
      completeFrom && completeFrom < end
        ? await Expense.aggregate([
            {
              $match: {
                _isDeleted: { $ne: true },
                _serverRecordedAt: { $gte: effectivePreviousStart, $lt: end },
              },
            },
            ...retainedOwners(filters),
            ...recordTypeScope(filters),
            {
              $facet: {
                daily: [
                  {
                    $group: {
                      _id: {
                        date: {
                          $dateToString: {
                            format: '%Y-%m-%d',
                            date: '$_serverRecordedAt',
                            timezone: 'UTC',
                          },
                        },
                        user: '$user',
                      },
                      records: { $sum: 1 },
                    },
                  },
                  {
                    $group: {
                      _id: '$_id.date',
                      records: { $sum: '$records' },
                      users: { $sum: 1 },
                    },
                  },
                ],
                current: [
                  {
                    $match: {
                      _serverRecordedAt: { $gte: effectiveStart, $lt: end },
                    },
                  },
                  { $group: { _id: '$user', records: { $sum: 1 } } },
                  {
                    $group: {
                      _id: null,
                      users: { $sum: 1 },
                      records: { $sum: '$records' },
                    },
                  },
                ],
                previous: [
                  {
                    $match: {
                      _serverRecordedAt: {
                        $gte: effectivePreviousStart,
                        $lt: previousEnd,
                      },
                    },
                  },
                  { $group: { _id: '$user', records: { $sum: 1 } } },
                  {
                    $group: {
                      _id: null,
                      users: { $sum: 1 },
                      records: { $sum: '$records' },
                    },
                  },
                ],
              },
            },
          ])
        : [empty];
    const activity = activityResults[0] || empty;
    const byDate = new Map<string, { records: number; users: number }>(
      activity.daily.map((row: any) => [row._id, row])
    );
    const series = Array.from({ length: days }, (_, index) => {
      const date = new Date(start.getTime() + index * DAY);
      const previousDate = new Date(previousStart.getTime() + index * DAY);
      const values = (at: Date) =>
        covered(at) ? byDate.get(key(at)) || { records: 0, users: 0 } : null;
      return {
        date: key(date),
        previousDate: key(previousDate),
        current: values(date),
        previous: values(previousDate),
      };
    });
    const target = (offset: number) => ({
      $dateAdd: {
        startDate: '$cohortDay',
        unit: 'day',
        amount: offset,
        timezone: 'UTC',
      },
    });
    const firstDay = {
      $dateTrunc: { date: '$createdAt', unit: 'day', timezone: 'UTC' },
    };
    const cohortRows =
      completeFrom && effectiveStart < end
        ? await User.aggregate([
            {
              $match: {
                ...consumerScope(filters),
                createdAt: { $gte: effectiveStart, $lt: end },
              },
            },
            { $set: { cohortDay: firstDay } },
            {
              $lookup: {
                from: 'expenses',
                localField: '_id',
                foreignField: 'user',
                let: { cohortDay: '$cohortDay' },
                pipeline: [
                  {
                    $match: {
                      _isDeleted: { $ne: true },
                      _serverRecordedAt: { $type: 'date' },
                      $expr: {
                        $and: [
                          { $gte: ['$_serverRecordedAt', '$$cohortDay'] },
                          {
                            $lt: [
                              '$_serverRecordedAt',
                              {
                                $dateAdd: {
                                  startDate: '$$cohortDay',
                                  unit: 'day',
                                  amount: 31,
                                  timezone: 'UTC',
                                },
                              },
                            ],
                          },
                        ],
                      },
                    },
                  },
                  ...recordTypeScope(filters),
                  {
                    $group: {
                      _id: {
                        $dateToString: {
                          format: '%Y-%m-%d',
                          date: '$_serverRecordedAt',
                          timezone: 'UTC',
                        },
                      },
                    },
                  },
                ],
                as: 'recordingDays',
              },
            },
            {
              $project: {
                cohortDay: 1,
                ...Object.fromEntries(
                  [1, 7, 30].map((offset) => [
                    `d${offset}`,
                    {
                      eligible: { $lte: [target(offset + 1), end] },
                      returned: {
                        $in: [
                          {
                            $dateToString: {
                              format: '%Y-%m-%d',
                              date: target(offset),
                              timezone: 'UTC',
                            },
                          },
                          '$recordingDays._id',
                        ],
                      },
                    },
                  ])
                ),
              },
            },
            {
              $group: {
                _id: '$cohortDay',
                size: { $sum: 1 },
                ...Object.fromEntries(
                  [1, 7, 30].flatMap((offset) => [
                    [
                      `eligible${offset}`,
                      { $sum: { $cond: [`$d${offset}.eligible`, 1, 0] } },
                    ],
                    [
                      `returned${offset}`,
                      {
                        $sum: {
                          $cond: [
                            {
                              $and: [
                                `$d${offset}.eligible`,
                                `$d${offset}.returned`,
                              ],
                            },
                            1,
                            0,
                          ],
                        },
                      },
                    ],
                  ])
                ),
              },
            },
            { $sort: { _id: 1 } },
          ])
        : [];
    const retention = (row: any, offset: number) => ({
      eligible: row[`eligible${offset}`],
      returned: row[`returned${offset}`],
      rate: row[`eligible${offset}`]
        ? Math.round(
            (row[`returned${offset}`] / row[`eligible${offset}`]) * 1000
          ) / 10
        : null,
    });
    const cohorts = cohortRows.map((row) => ({
      date: key(row._id),
      size: row.size,
      d1: retention(row, 1),
      d7: retention(row, 7),
      d30: retention(row, 30),
    }));
    const metric = (field: 'users' | 'records') => ({
      current:
        effectiveStart < end && completeFrom
          ? activity.current[0]?.[field] || 0
          : null,
      previous:
        effectivePreviousStart < previousEnd && completeFrom
          ? activity.previous[0]?.[field] || 0
          : null,
    });
    return {
      period: {
        days,
        presetDays: period.presetDays,
        comparison: period.comparison,
        start: start.toISOString(),
        endExclusive: end.toISOString(),
        previousStart: previousStart.toISOString(),
        previousEndExclusive: previousEnd.toISOString(),
        timezone: 'UTC',
        generatedAt: now.toISOString(),
      },
      coverage: {
        firstObservedAt: firstObservedAt?.toISOString() || null,
        completeFrom: completeFrom?.toISOString() || null,
        observedRecords: coverageRows[0]?.observedRecords || 0,
        currentDays: series.filter((row) => row.current !== null).length,
        previousDays: series.filter((row) => row.previous !== null).length,
      },
      metrics: { recordingUsers: metric('users'), records: metric('records') },
      filters: { plan: filters.plan || null, type: filters.type || null },
      series,
      cohorts,
    };
  }
}
export const engagementAnalyticsService = new EngagementAnalyticsService();
