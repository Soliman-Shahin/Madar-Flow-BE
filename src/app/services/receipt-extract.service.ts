import { Types } from 'mongoose';
import { ReceiptScanUsage } from '../models/receipt-scan-usage.model';
import { PlanLimits } from '../types/plan.types';

/**
 * Reads a receipt photo with a model, behind a small provider interface so the
 * service can be swapped without touching the app: Gemini's free tier, any
 * OpenAI-compatible endpoint (OpenRouter's free models, Groq, a local Ollama),
 * or nothing at all. With no provider set the endpoint answers 501 and the app
 * quietly reads the receipt on the device instead.
 *
 *   RECEIPT_AI_PROVIDER = gemini | openai | none      (default none)
 *   gemini:  GEMINI_API_KEY, GEMINI_MODEL (default gemini-3.5-flash-lite; a comma list is tried in order)
 *   openai:  RECEIPT_AI_BASE_URL, RECEIPT_AI_API_KEY, RECEIPT_AI_MODEL
 */

export interface ExtractedReceipt {
  merchant: string | null;
  date: string | null;
  total: number | null;
  currency: string | null;
  items: Array<{ name: string; amount: number }>;
}

export interface ReceiptProvider {
  readonly name: string;
  extract(
    image: { mime: string; base64: string },
    locale: string
  ): Promise<unknown>;
}

const PROMPT = `You read photographed shop receipts (Arabic, English or both) and return JSON only.
Fields: merchant (shop name), date (YYYY-MM-DD; dates are day-first), total (the final amount paid, tax included, as a number), currency (ISO 4217 code if shown), items (array of {name, amount}, at most 30).
Convert Arabic-Indic digits to Western digits. Use null for anything you cannot read; never guess a total.
Return exactly: {"merchant":string|null,"date":string|null,"total":number|null,"currency":string|null,"items":[{"name":string,"amount":number}]}`;

const TIMEOUT_MS = 30_000;

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = TIMEOUT_MS
): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`provider status ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLoose(text: string): unknown {
  const t = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  return JSON.parse(t);
}

/**
 * Models tried in order when the configured one fails in a way another model
 * may not: unknown (404), overloaded (503), rate limited (429) or too slow.
 * The lite model is lighter and answers when the full one is busy.
 */
const GEMINI_FALLBACK_MODELS = [
  // Google retires models for new keys without notice (2.0 and 2.5 already
  // answer 404 "no longer available to new users"), so the list is the 3.x
  // lite models first: they answer in about a second.
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
];

/** One answer must come back within this, so the app is not left waiting. */
const GEMINI_TOTAL_BUDGET_MS = 36_000;
const GEMINI_ATTEMPT_MS = 18_000;
const RETRYABLE =
  /status (404|429|500|502|503|504)|aborted|fetch failed|network|empty provider answer/i;

export class GeminiProvider implements ReceiptProvider {
  readonly name = 'gemini';
  private readonly models: string[];
  /** The model that last answered, tried first next time. */
  private working?: string;

  constructor(
    private readonly apiKey: string,
    model: string
  ) {
    this.models = [
      ...new Set(
        [...model.split(','), ...GEMINI_FALLBACK_MODELS]
          .map((m) => m.trim())
          .filter(Boolean)
      ),
    ];
  }

  async extract(image: { mime: string; base64: string }): Promise<unknown> {
    const order = this.working
      ? [this.working, ...this.models.filter((m) => m !== this.working)]
      : this.models;
    const deadline = Date.now() + GEMINI_TOTAL_BUDGET_MS;
    let lastError: unknown = new Error('no model available');
    for (const model of order) {
      const left = deadline - Date.now();
      if (left < 6_000) break;
      try {
        const result = await this.call(model, image, Math.min(GEMINI_ATTEMPT_MS, left));
        this.working = model;
        return result;
      } catch (e) {
        lastError = e;
        // A bad key or a bad request (400/401/403) will not get better on
        // another model; everything else may.
        if (!RETRYABLE.test((e as Error)?.message ?? '')) throw e;
      }
    }
    throw lastError;
  }

  private async call(
    model: string,
    image: { mime: string; base64: string },
    timeoutMs: number
  ): Promise<unknown> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent`;
    const data = await postJson(
      url,
      {
        contents: [
          {
            parts: [
              { text: PROMPT },
              { inline_data: { mime_type: image.mime, data: image.base64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          // 2.5 Flash "thinks" before answering, which only adds seconds to a
          // task that is reading text off a photo.
          ...(model.startsWith('gemini-2.5-flash')
            ? { thinkingConfig: { thinkingBudget: 0 } }
            : {}),
        },
      },
      { 'x-goog-api-key': this.apiKey },
      timeoutMs
    );
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') throw new Error('empty provider answer');
    return parseJsonLoose(text);
  }
}

export class OpenAiCompatibleProvider implements ReceiptProvider {
  readonly name = 'openai';
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string
  ) {}

  async extract(image: { mime: string; base64: string }): Promise<unknown> {
    const data = await postJson(
      `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              {
                type: 'image_url',
                image_url: { url: `data:${image.mime};base64,${image.base64}` },
              },
            ],
          },
        ],
      },
      this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}
    );
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('empty provider answer');
    return parseJsonLoose(text);
  }
}

/** Picks the provider from the environment, or null when none is set up. */
export function providerFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ReceiptProvider | null {
  const kind = (env.RECEIPT_AI_PROVIDER || 'none').toLowerCase();
  if (kind === 'gemini' && env.GEMINI_API_KEY) {
    return new GeminiProvider(
      env.GEMINI_API_KEY,
      env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
    );
  }
  if (kind === 'openai' && env.RECEIPT_AI_BASE_URL && env.RECEIPT_AI_MODEL) {
    return new OpenAiCompatibleProvider(
      env.RECEIPT_AI_BASE_URL,
      env.RECEIPT_AI_API_KEY || '',
      env.RECEIPT_AI_MODEL
    );
  }
  return null;
}

/** Never trusts the model: every field is checked and clamped. */
export function sanitizeExtraction(raw: unknown): ExtractedReceipt {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const total = Number(r.total);
  const date =
    typeof r.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
    !Number.isNaN(Date.parse(r.date))
      ? r.date
      : null;
  const items = Array.isArray(r.items) ? r.items : [];
  return {
    merchant:
      typeof r.merchant === 'string' && r.merchant.trim()
        ? r.merchant.trim().slice(0, 60)
        : null,
    date,
    total:
      Number.isFinite(total) && total > 0 && total < 10_000_000 ? total : null,
    currency:
      typeof r.currency === 'string' && /^[A-Za-z]{3}$/.test(r.currency)
        ? r.currency.toUpperCase()
        : null,
    items: items
      .map((i) => {
        const o = (i && typeof i === 'object' ? i : {}) as Record<
          string,
          unknown
        >;
        return {
          name: String(o.name ?? '')
            .trim()
            .slice(0, 60),
          amount: Number(o.amount),
        };
      })
      .filter(
        (i) =>
          i.name &&
          Number.isFinite(i.amount) &&
          i.amount > 0 &&
          i.amount < 10_000_000
      )
      .slice(0, 30),
  };
}

/** Monthly allowance when a plan document predates the setting. */
const FALLBACK_LIMIT: Record<string, number | null> = {
  free: 10,
  basic: 50,
  pro: 100,
  premium: null,
  enterprise: null,
};

export function scanLimitFor(
  limits: Partial<PlanLimits> | undefined,
  planSlug: string
): number | null {
  const v = limits?.maxReceiptScansPerMonth;
  if (v === undefined) return planSlug in FALLBACK_LIMIT ? FALLBACK_LIMIT[planSlug] : 10;
  return v; // null = unlimited, set from the dashboard
}

export const monthKey = (d = new Date()) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export class ReceiptScanService {
  constructor(
    private readonly provider: ReceiptProvider | null = providerFromEnv()
  ) {}

  get available(): boolean {
    return this.provider !== null;
  }

  /** Reserves one scan; false when the monthly allowance is used up. */
  async reserve(userId: string, limit: number | null): Promise<boolean> {
    const filter: Record<string, unknown> = {
      user: new Types.ObjectId(userId),
      month: monthKey(),
    };
    if (limit !== null) filter.count = { $lt: limit };
    try {
      await ReceiptScanUsage.findOneAndUpdate(
        filter,
        { $inc: { count: 1 } },
        { upsert: true }
      );
      return true;
    } catch (e: any) {
      // upsert on a full counter collides with the unique (user, month) index
      if (e?.code === 11000) return false;
      throw e;
    }
  }

  async release(userId: string): Promise<void> {
    await ReceiptScanUsage.updateOne(
      {
        user: new Types.ObjectId(userId),
        month: monthKey(),
        count: { $gt: 0 },
      },
      { $inc: { count: -1 } }
    );
  }

  async used(userId: string): Promise<number> {
    const doc = await ReceiptScanUsage.findOne({
      user: new Types.ObjectId(userId),
      month: monthKey(),
    }).lean();
    return doc?.count ?? 0;
  }

  async extract(
    image: { mime: string; base64: string },
    locale: string
  ): Promise<ExtractedReceipt> {
    if (!this.provider) throw new Error('no provider');
    return sanitizeExtraction(await this.provider.extract(image, locale));
  }
}

export const receiptScanService = new ReceiptScanService();
