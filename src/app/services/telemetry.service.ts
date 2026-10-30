import { TelemetryEvent } from '../models/telemetry-event.model';
import { TelemetryBatchInput } from '../validations/telemetry.validation';

/** Client clocks are untrusted: timestamps outside this window use server time. */
const MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

export class TelemetryService {
  /** Store a validated batch. Returns how many events were saved. */
  async record(input: TelemetryBatchInput, now = new Date()): Promise<number> {
    const t = now.getTime();
    const docs = input.events.map((event) => {
      const ts = event.ts;
      const usable =
        typeof ts === 'number' && ts >= t - MAX_PAST_MS && ts <= t + MAX_FUTURE_MS;
      return {
        installId: input.installId.toLowerCase(),
        name: event.name,
        at: new Date(usable ? ts : t),
        appVersion: input.appVersion,
        platform: input.platform,
        lang: input.lang,
      };
    });
    await TelemetryEvent.insertMany(docs, { ordered: false });
    return docs.length;
  }

  /** Right to erase: remove everything stored for one install. */
  async deleteInstall(installId: string): Promise<number> {
    const res = await TelemetryEvent.deleteMany({
      installId: installId.toLowerCase(),
    });
    return res.deletedCount ?? 0;
  }

  /**
   * Aggregate usage for the dashboard: event counts per day, distinct installs,
   * and a simple activation view. Counts are over opted-in installs only, so
   * they understate total usage; they are for trends, not billing.
   */
  async summary(days: number, now = new Date()) {
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const [perDay, totals, installs, activated] = await Promise.all([
      TelemetryEvent.aggregate([
        { $match: { at: { $gte: since } } },
        {
          $group: {
            _id: {
              day: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: 'UTC' } },
              name: '$name',
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.day': 1, '_id.name': 1 } },
      ]),
      TelemetryEvent.aggregate([
        { $match: { at: { $gte: since } } },
        { $group: { _id: '$name', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      TelemetryEvent.distinct('installId', { at: { $gte: since } }),
      TelemetryEvent.distinct('installId', {
        at: { $gte: since },
        name: 'transaction_added',
      }),
    ]);

    return {
      days,
      since: since.toISOString(),
      optedInInstalls: installs.length,
      installsWithTransaction: activated.length,
      totals: Object.fromEntries(
        totals.map((row: { _id: string; count: number }) => [row._id, row.count])
      ),
      perDay: perDay.map(
        (row: { _id: { day: string; name: string }; count: number }) => ({
          day: row._id.day,
          name: row._id.name,
          count: row.count,
        })
      ),
    };
  }
}

export const telemetryService = new TelemetryService();
