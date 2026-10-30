import { Types } from 'mongoose';
import { createHash } from 'crypto';
import { PlanSlug } from '../types/plan.types';
import {
  AnalyticsReportSchedule,
  IAnalyticsReportSchedule,
  ReportComparison,
  ReportFrequency,
  ReportLanguage,
} from '../models/analytics-report-schedule.model';
import { User, UserRole, ROLE_WEIGHTS } from '../models/user.model';
import { adminAnalyticsService } from './admin-analytics.service';
import { MailService } from './mail.service';
import logger from './logger.service';

const DAY = 86_400_000;
const MAX_ACTIVE_SCHEDULES = 5;
const MAX_DELIVERY_ATTEMPTS = 5;
const LEASE_MS = 10 * 60_000;
const RETRY_DELAY_MS = 15 * 60_000;

export interface AnalyticsReportScheduleInput {
  frequency: ReportFrequency;
  weekday?: number;
  monthDay?: number;
  hour: number;
  timezone: string;
  days: 7 | 30 | 90;
  comparison: ReportComparison;
  plan?: PlanSlug;
  type?: 'income' | 'outcome';
  language: ReportLanguage;
}

export class AnalyticsReportScheduleError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'REPORT_RECIPIENT_NOT_VERIFIED'
      | 'REPORT_SCHEDULE_LIMIT'
      | 'REPORT_SCHEDULE_NOT_FOUND'
      | 'INVALID_REPORT_TIMEZONE',
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'AnalyticsReportScheduleError';
  }
}

interface WallDate {
  year: number;
  month: number;
  day: number;
}

function localDateParts(value: Date, timezone: string): WallDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const valueOf = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: valueOf('year'), month: valueOf('month'), day: valueOf('day') };
}

function localDateTimeParts(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const valueOf = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: valueOf('year'),
    month: valueOf('month'),
    day: valueOf('day'),
    hour: valueOf('hour'),
    minute: valueOf('minute'),
  };
}

/** Resolve a local wall-clock time using the runtime's IANA timezone database. */
function wallTimeToUtc(date: WallDate, hour: number, timezone: string): Date {
  const target = Date.UTC(date.year, date.month - 1, date.day, hour);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = localDateTimeParts(new Date(candidate), timezone);
    const represented = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute
    );
    const adjustment = target - represented;
    if (!adjustment) break;
    candidate += adjustment;
  }
  return new Date(candidate);
}

export function isValidReportTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone.length <= 80;
  } catch {
    return false;
  }
}

export function nextAnalyticsReportRunAt(
  input: Pick<
    AnalyticsReportScheduleInput,
    'frequency' | 'weekday' | 'monthDay' | 'hour' | 'timezone'
  >,
  after: Date
): Date {
  if (!isValidReportTimezone(input.timezone))
    throw new AnalyticsReportScheduleError(
      'Choose a valid timezone.',
      'INVALID_REPORT_TIMEZONE',
      400
    );
  const localToday = localDateParts(after, input.timezone);
  const firstDay = Date.UTC(
    localToday.year,
    localToday.month - 1,
    localToday.day
  );
  const maxDays = input.frequency === 'weekly' ? 14 : 370;
  for (let offset = 0; offset <= maxDays; offset += 1) {
    const date = new Date(firstDay + offset * DAY);
    const candidateDate = {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
    const matches =
      input.frequency === 'weekly'
        ? ((date.getUTCDay() || 7) === input.weekday)
        : candidateDate.day === input.monthDay;
    if (!matches) continue;
    const candidate = wallTimeToUtc(candidateDate, input.hour, input.timezone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new RangeError('Could not resolve the next scheduled report time.');
}

function isEligibleAdmin(user: any): boolean {
  return !!(
    user &&
    user.emailVerified === true &&
    user.isActive !== false &&
    user._isDeleted !== true &&
    ROLE_WEIGHTS[user.role as UserRole] >= ROLE_WEIGHTS[UserRole.Admin]
  );
}

function validateFrequency(input: AnalyticsReportScheduleInput): void {
  if (
    (input.frequency === 'weekly' &&
      (!input.weekday || input.weekday < 1 || input.weekday > 7 || input.monthDay !== undefined)) ||
    (input.frequency === 'monthly' &&
      (!input.monthDay || input.monthDay < 1 || input.monthDay > 28 || input.weekday !== undefined))
  ) {
    throw new RangeError('Choose a valid weekly day or monthly date.');
  }
}

function publicSchedule(schedule: IAnalyticsReportSchedule) {
  return {
    id: schedule._id.toString(),
    frequency: schedule.frequency,
    weekday: schedule.weekday ?? null,
    monthDay: schedule.monthDay ?? null,
    hour: schedule.hour,
    timezone: schedule.timezone,
    days: schedule.days,
    comparison: schedule.comparison,
    filters: { plan: schedule.plan ?? null, type: schedule.type ?? null },
    language: schedule.language,
    active: schedule.active,
    nextRunAt: schedule.nextRunAt.toISOString(),
    lastAttemptAt: schedule.lastAttemptAt?.toISOString() ?? null,
    lastSentAt: schedule.lastSentAt?.toISOString() ?? null,
    lastDeliveryStatus: schedule.lastDeliveryStatus,
    lastErrorCode: schedule.lastErrorCode ?? null,
    consecutiveFailures: schedule.consecutiveFailures,
    createdAt: schedule.createdAt?.toISOString() ?? null,
  };
}

function reportPeriod(days: 7 | 30 | 90, comparison: ReportComparison, now: Date) {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const lastCompleteDay = new Date(end.getTime() - DAY);
  const start = new Date(end.getTime() - days * DAY);
  return {
    start: start.toISOString().slice(0, 10),
    end: lastCompleteDay.toISOString().slice(0, 10),
    comparison,
  };
}

const scheduleLabels = {
  en: {
    subject: 'Madar Flow analytics report',
    period: 'Reporting period',
    comparison: 'Comparison period',
    metric: 'Metric',
    current: 'Selected period',
    baseline: 'Comparison',
    change: 'Change (%)',
    category: 'Category',
    count: 'Records',
    share: 'Share (%)',
    plan: 'Assigned plan filter',
    type: 'Record type filter',
    allPlans: 'All plans',
    allTypes: 'All record types',
    metrics: {
      expenses: 'Financial records',
      recordingUsers: 'Recording users',
      newUsers: 'New accounts',
    },
    previous: 'Previous period',
    yearAgo: 'Same-length period one year earlier',
    note: 'Counts describe records and accounts, not money or revenue. Daily distinct recording-user counts should not be summed.',
  },
  ar: {
    subject: 'تقرير تحليلات مدار فلو',
    period: 'الفترة المشمولة',
    comparison: 'فترة المقارنة',
    metric: 'المؤشر',
    current: 'الفترة المختارة',
    baseline: 'المقارنة',
    change: 'التغير (٪)',
    category: 'التصنيف',
    count: 'سجل',
    share: 'النسبة (٪)',
    plan: 'فلتر الباقة المسندة',
    type: 'فلتر نوع السجل',
    allPlans: 'كل الباقات',
    allTypes: 'كل أنواع السجلات',
    metrics: {
      expenses: 'السجلات المالية',
      recordingUsers: 'المستخدمون المسجلون',
      newUsers: 'الحسابات الجديدة',
    },
    previous: 'الفترة السابقة',
    yearAgo: 'فترة مماثلة قبل عام',
    note: 'الأعداد تخص السجلات والحسابات وليست مبالغ أو إيرادات. لا تجمع أعداد المستخدمين المسجلين اليومية.',
  },
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character] as string
  );
}

function formatReportDate(value: string, language: ReportLanguage): string {
  return new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZoneName: 'short',
  }).format(new Date(value));
}

function buildEmail(report: any, schedule: IAnalyticsReportSchedule) {
  const labels = scheduleLabels[schedule.language];
  const periodStart = formatReportDate(report.period.start, schedule.language);
  const periodEnd = formatReportDate(
    new Date(new Date(report.period.endExclusive).getTime() - 1).toISOString(),
    schedule.language
  );
  const previousEnd = formatReportDate(
    new Date(new Date(report.period.previousEndExclusive).getTime() - 1).toISOString(),
    schedule.language
  );
  const comparison =
    schedule.comparison === 'yearAgo' ? labels.yearAgo : labels.previous;
  const plan = schedule.plan ?? labels.allPlans;
  const type = schedule.type ?? labels.allTypes;
  const rows = (['expenses', 'recordingUsers', 'newUsers'] as const)
    .map((kind) => {
      const metric = report.metrics[kind];
      return `<tr><th>${labels.metrics[kind]}</th><td><bdi>${metric.current}</bdi></td><td><bdi>${metric.previous}</bdi></td><td><bdi>${metric.changePercent === null ? '—' : metric.changePercent}</bdi></td></tr>`;
    })
    .join('');
  const categories = report.categories
    .map(
      (item: any) =>
        `<tr><th>${escapeHtml(item.title || (schedule.language === 'ar' ? 'التصنيف غير متاح' : 'Category unavailable'))}</th><td><bdi>${item.count}</bdi></td><td><bdi>${item.share}</bdi></td></tr>`
    )
    .join('');
  const table = (headings: string, body: string) =>
    `<table style="width:100%;border-collapse:collapse;margin:12px 0"><thead>${headings}</thead><tbody>${body}</tbody></table>`;
  const html = `<!doctype html><html lang="${schedule.language}" dir="${schedule.language === 'ar' ? 'rtl' : 'ltr'}"><body style="margin:0;background:#f5f7fb;color:#0b1526;font:15px Arial,sans-serif"><main style="max-width:760px;margin:24px auto;padding:24px;background:#fff;border-top:4px solid #0066cc"><p style="margin:0;color:#475569">Madar Flow · ${labels.subject}</p><h1 style="margin:8px 0 18px;font-size:22px">${periodStart} — ${periodEnd}</h1><p>${labels.comparison}: <strong>${comparison}</strong> · ${previousEnd}</p><p>${labels.plan}: <strong>${escapeHtml(plan)}</strong> · ${labels.type}: <strong>${escapeHtml(type)}</strong></p><h2>${schedule.language === 'ar' ? 'ملخص الفترة' : 'Period summary'}</h2>${table(`<tr><th>${labels.metric}</th><th>${labels.current}</th><th>${labels.baseline}</th><th>${labels.change}</th></tr>`, rows)}${report.categories.length ? `<h2>${schedule.language === 'ar' ? 'التصنيفات الأكثر نشاطًا' : 'Leading categories'}</h2>${table(`<tr><th>${labels.category}</th><th>${labels.count}</th><th>${labels.share}</th></tr>`, categories)}` : ''}<p style="padding-top:12px;border-top:1px solid #e2e8f0;color:#475569;font-size:13px">${labels.note}</p><p style="color:#64748b;font-size:12px">${schedule.language === 'ar' ? 'وقت إنشاء اللقطة' : 'Snapshot generated'}: <bdi>${report.period.generatedAt}</bdi> UTC</p></main></body></html>`;
  const text = [
    `${labels.subject}: ${periodStart} — ${periodEnd}`,
    `${labels.comparison}: ${comparison} · ${previousEnd}`,
    `${labels.plan}: ${plan}`,
    `${labels.type}: ${type}`,
    '',
    `${labels.metric}\t${labels.current}\t${labels.baseline}\t${labels.change}`,
    ...(['expenses', 'recordingUsers', 'newUsers'] as const).map((kind) => {
      const metric = report.metrics[kind];
      return `${labels.metrics[kind]}\t${metric.current}\t${metric.previous}\t${metric.changePercent === null ? '—' : metric.changePercent}`;
    }),
    '',
    labels.note,
  ].join('\n');
  return { subject: labels.subject, html, text };
}

export class AnalyticsReportScheduleService {
  private readonly ownerLocks = new Map<string, Promise<void>>();

  private async withOwnerLock<T>(ownerId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.ownerLocks.get(ownerId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    this.ownerLocks.set(ownerId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.ownerLocks.get(ownerId) === current) this.ownerLocks.delete(ownerId);
    }
  }

  async list(ownerId: string) {
    const [schedules, owner] = await Promise.all([
      AnalyticsReportSchedule.find({ owner: ownerId, cancelledAt: null })
        .sort({ active: -1, nextRunAt: 1 })
        .exec(),
      User.findById(ownerId).select('email emailVerified').lean(),
    ]);
    return {
      schedules: schedules.map(publicSchedule),
      recipientEmail: owner?.emailVerified ? owner.email : null,
      emailVerified: owner?.emailVerified === true,
      maxActiveSchedules: MAX_ACTIVE_SCHEDULES,
    };
  }

  private async requireEligibleOwner(ownerId: string) {
    const owner = await User.findById(ownerId)
      .select('email emailVerified isActive _isDeleted role')
      .lean();
    if (!isEligibleAdmin(owner))
      throw new AnalyticsReportScheduleError(
        'Verify an active Admin account email before scheduling reports.',
        'REPORT_RECIPIENT_NOT_VERIFIED',
        409
      );
    return owner;
  }

  private async requireCapacity(ownerId: string, excludingId?: string) {
    const filter: any = { owner: ownerId, active: true, cancelledAt: null };
    if (excludingId) filter._id = { $ne: excludingId };
    const count = await AnalyticsReportSchedule.countDocuments(filter);
    if (count >= MAX_ACTIVE_SCHEDULES)
      throw new AnalyticsReportScheduleError(
        `You can keep up to ${MAX_ACTIVE_SCHEDULES} active report schedules.`,
        'REPORT_SCHEDULE_LIMIT',
        409
      );
  }

  async create(ownerId: string, input: AnalyticsReportScheduleInput, now = new Date()) {
    validateFrequency(input);
    return this.withOwnerLock(ownerId, async () => {
      await this.requireEligibleOwner(ownerId);
      await this.requireCapacity(ownerId);
      const nextRunAt = nextAnalyticsReportRunAt(input, now);
      const schedule = await AnalyticsReportSchedule.create({
        ...input,
        owner: ownerId,
        active: true,
        nextRunAt,
        lastDeliveryStatus: 'scheduled',
      });
      return publicSchedule(schedule);
    });
  }

  async update(
    ownerId: string,
    id: string,
    input: AnalyticsReportScheduleInput,
    now = new Date()
  ) {
    validateFrequency(input);
    if (!Types.ObjectId.isValid(id))
      throw new AnalyticsReportScheduleError(
        'Report schedule not found.',
        'REPORT_SCHEDULE_NOT_FOUND',
        404
      );
    return this.withOwnerLock(ownerId, async () => {
      await this.requireEligibleOwner(ownerId);
      const existing = await AnalyticsReportSchedule.findOne({
        _id: id,
        owner: ownerId,
        cancelledAt: null,
      }).exec();
      if (!existing)
        throw new AnalyticsReportScheduleError(
          'Report schedule not found.',
          'REPORT_SCHEDULE_NOT_FOUND',
          404
        );
      if (existing.active) await this.requireCapacity(ownerId, id);
      const nextRunAt = nextAnalyticsReportRunAt(input, now);
      Object.assign(existing, input, {
        nextRunAt,
        retryAt: null,
        leaseUntil: null,
        lastDeliveryStatus: existing.active ? 'scheduled' : 'paused',
        lastErrorCode: null,
        consecutiveFailures: 0,
      });
      await existing.save();
      return publicSchedule(existing);
    });
  }

  async setActive(ownerId: string, id: string, active: boolean, now = new Date()) {
    if (!Types.ObjectId.isValid(id))
      throw new AnalyticsReportScheduleError(
        'Report schedule not found.',
        'REPORT_SCHEDULE_NOT_FOUND',
        404
      );
    return this.withOwnerLock(ownerId, async () => {
      const schedule = await AnalyticsReportSchedule.findOne({
        _id: id,
        owner: ownerId,
        cancelledAt: null,
      }).exec();
      if (!schedule)
        throw new AnalyticsReportScheduleError(
          'Report schedule not found.',
          'REPORT_SCHEDULE_NOT_FOUND',
          404
        );
      if (active && !schedule.active) {
        await this.requireEligibleOwner(ownerId);
        await this.requireCapacity(ownerId, id);
      }
      schedule.active = active;
      schedule.retryAt = null;
      schedule.leaseUntil = null;
      schedule.lastErrorCode = null;
      schedule.consecutiveFailures = 0;
      schedule.lastDeliveryStatus = active ? 'scheduled' : 'paused';
      if (active)
        schedule.nextRunAt = nextAnalyticsReportRunAt(schedule, now);
      await schedule.save();
      return publicSchedule(schedule);
    });
  }

  async cancel(ownerId: string, id: string, now = new Date()): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const result = await AnalyticsReportSchedule.updateOne(
      { _id: id, owner: ownerId, cancelledAt: null },
      {
        $set: {
          active: false,
          cancelledAt: now,
          leaseUntil: null,
          retryAt: null,
          lastDeliveryStatus: 'cancelled',
        },
      }
    );
    return result.modifiedCount > 0;
  }

  async runDue(now = new Date(), limit = 20): Promise<number> {
    const due = await AnalyticsReportSchedule.find({
      active: true,
      cancelledAt: null,
      nextRunAt: { $lte: now },
      $and: [
        { $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] },
        { $or: [{ retryAt: null }, { retryAt: { $lte: now } }] },
      ],
    })
      .sort({ nextRunAt: 1 })
      .limit(limit)
      .select('_id')
      .lean();
    let claimedCount = 0;
    for (const item of due) {
      const claimed = await this.claim(item._id.toString(), now);
      if (!claimed) continue;
      claimedCount += 1;
      await this.deliver(claimed, now);
    }
    return claimedCount;
  }

  private async claim(id: string, now: Date) {
    return AnalyticsReportSchedule.findOneAndUpdate(
      {
        _id: id,
        active: true,
        cancelledAt: null,
        nextRunAt: { $lte: now },
        $and: [
          { $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] },
          { $or: [{ retryAt: null }, { retryAt: { $lte: now } }] },
        ],
      },
      {
        $set: {
          leaseUntil: new Date(now.getTime() + LEASE_MS),
          lastAttemptAt: now,
          lastDeliveryStatus: 'sending',
        },
      },
      { new: true }
    ).exec();
  }

  private async deliver(schedule: IAnalyticsReportSchedule, now: Date) {
    try {
      const owner = await User.findById(schedule.owner)
        .select('email emailVerified isActive _isDeleted role')
        .lean();
      if (!owner || !isEligibleAdmin(owner)) {
        await AnalyticsReportSchedule.updateOne(
          { _id: schedule._id, leaseUntil: schedule.leaseUntil },
          {
            $set: {
              active: false,
              lastDeliveryStatus: 'paused',
              lastErrorCode: 'RECIPIENT_UNAVAILABLE',
              leaseUntil: null,
            },
          }
        );
        return;
      }

      const selection = reportPeriod(schedule.days, schedule.comparison, now);
      const report = await adminAnalyticsService.overview(selection, now, {
        plan: schedule.plan,
        type: schedule.type,
      });
      const mail = buildEmail(report, schedule);
      const occurrence = schedule.nextRunAt.toISOString();
      const occurrenceHash = createHash('sha256').update(occurrence).digest('hex');
      const idempotencyKey = `analytics-report/${schedule._id.toString()}/${occurrenceHash}`;

      // A user may pause or cancel after the worker claims the lease.
      const stillActive = await AnalyticsReportSchedule.exists({
        _id: schedule._id,
        active: true,
        cancelledAt: null,
        leaseUntil: schedule.leaseUntil,
      });
      if (!stillActive) return;

      await MailService.sendAnalyticsReport(owner.email, mail, idempotencyKey);
      await AnalyticsReportSchedule.updateOne(
        { _id: schedule._id, leaseUntil: schedule.leaseUntil },
        {
          $set: {
            nextRunAt: nextAnalyticsReportRunAt(schedule, now),
            lastSentAt: now,
            lastDeliveryStatus: 'sent',
            lastErrorCode: null,
            consecutiveFailures: 0,
            retryAt: null,
            leaseUntil: null,
          },
        }
      );
    } catch (error) {
      const failures = schedule.consecutiveFailures + 1;
      const paused = failures >= MAX_DELIVERY_ATTEMPTS;
      const errorCode = 'DELIVERY_FAILED' as const;
      logger.error(
        `[AnalyticsReportSchedule] Delivery failed for schedule ${schedule._id.toString()} (attempt ${failures})`
      );
      await AnalyticsReportSchedule.updateOne(
        { _id: schedule._id, leaseUntil: schedule.leaseUntil },
        {
          $set: {
            active: !paused,
            lastDeliveryStatus: paused ? 'paused' : 'failed',
            lastErrorCode: errorCode,
            consecutiveFailures: failures,
            retryAt: paused ? null : new Date(now.getTime() + RETRY_DELAY_MS),
            leaseUntil: null,
          },
        }
      );
      void error;
    }
  }
}

export const analyticsReportScheduleService =
  new AnalyticsReportScheduleService();
