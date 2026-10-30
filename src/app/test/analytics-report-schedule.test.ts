import { isValidReportTimezone, nextAnalyticsReportRunAt } from '../services/analytics-report-schedule.service';

jest.mock('../models/analytics-report-schedule.model', () => ({
  AnalyticsReportSchedule: {},
}));
jest.mock('../models/user.model', () => ({
  User: {},
  UserRole: { Admin: 'admin' },
  ROLE_WEIGHTS: { admin: 2, super_admin: 3 },
}));
jest.mock('../services/admin-analytics.service', () => ({
  adminAnalyticsService: {},
}));
jest.mock('../services/mail.service', () => ({ MailService: {} }));
jest.mock('../services/logger.service', () => ({ __esModule: true, default: { error: jest.fn() } }));

describe('analytics report schedule recurrence', () => {
  it('resolves a weekly occurrence in the requested local timezone', () => {
    const next = nextAnalyticsReportRunAt(
      {
        frequency: 'weekly',
        weekday: 1,
        hour: 9,
        timezone: 'Africa/Cairo',
      },
      new Date('2026-10-30T08:00:00.000Z')
    );

    expect(next.toISOString()).toBe('2026-11-02T07:00:00.000Z');
  });

  it('resolves monthly dates without allowing a run on the current instant', () => {
    const next = nextAnalyticsReportRunAt(
      {
        frequency: 'monthly',
        monthDay: 28,
        hour: 9,
        timezone: 'UTC',
      },
      new Date('2026-10-28T09:00:00.000Z')
    );

    expect(next.toISOString()).toBe('2026-11-28T09:00:00.000Z');
  });

  it('rejects invalid IANA timezones', () => {
    expect(isValidReportTimezone('Not/A_Real_Zone')).toBe(false);
    expect(() =>
      nextAnalyticsReportRunAt(
        {
          frequency: 'weekly',
          weekday: 1,
          hour: 9,
          timezone: 'Not/A_Real_Zone',
        },
        new Date('2026-10-30T08:00:00.000Z')
      )
    ).toThrow('valid timezone');
  });
});
