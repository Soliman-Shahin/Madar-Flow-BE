/**
 * Indicative market prices for the vault: gold and exchange rates, from free
 * sources that need no key. Each kind has a primary source and fallbacks, and
 * the last good answer is kept, so one source being down never leaves the
 * phone without prices.
 *
 *   gold:  gold-api.com (live, USD per troy ounce)  ->  currency-api (XAU)
 *   fx:    currency-api via jsDelivr  ->  its pages.dev mirror  ->  open.er-api.com
 *
 * These are international spot and official rates. Local shop prices (gold
 * with its local premium, a parallel-market dollar) differ, which is why the
 * app lets the person enter their own price. Swap a source by editing the
 * lists below; nothing else changes.
 */

const TROY_OUNCE_GRAMS = 31.1034768;
const FRESH_MS = 15 * 60 * 1000;
const STALE_OK_MS = 48 * 60 * 60 * 1000;
const TIMEOUT_MS = 8_000;

/** Fiat codes served to the app (the app's currency list plus common ones). */
export const MARKET_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CNY', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'DKK',
  'EGP', 'SAR', 'AED', 'KWD', 'QAR', 'BHD', 'OMR', 'JOD', 'LBP', 'IQD', 'LYD', 'TND',
  'MAD', 'DZD', 'SDG', 'YER', 'SYP', 'TRY', 'INR', 'PKR', 'IDR', 'MYR', 'SGD', 'THB',
  'KRW', 'RUB', 'ZAR', 'NGN', 'KES', 'BRL', 'MXN', 'ILS',
] as const;

export interface MarketSnapshot {
  /** When the prices were fetched (ISO). */
  updatedAt: string;
  /** 24-karat gold, USD per gram. */
  goldUsdPerGram24: number;
  /** Units of each currency that one US dollar buys. */
  usdPer: Record<string, number>;
  sources: { gold: string; fx: string };
  /** True when the sources failed and an older snapshot is served. */
  stale: boolean;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

async function getJson(fetchFn: FetchLike, url: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const FAWAZ = [
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
  'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
];

const finitePositive = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

export class MarketPriceService {
  private snapshot?: MarketSnapshot;
  private fetchedAt = 0;
  private inflight?: Promise<MarketSnapshot>;

  constructor(
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init as any) as any,
    private readonly now: () => number = Date.now
  ) {}

  /** Fresh prices, or the last good ones (marked stale) when sources fail. */
  async get(): Promise<MarketSnapshot> {
    const age = this.now() - this.fetchedAt;
    if (this.snapshot && age < FRESH_MS) return this.snapshot;
    // concurrent requests share one fetch
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined;
    });
    try {
      return await this.inflight;
    } catch (err) {
      if (this.snapshot && age < STALE_OK_MS) {
        return { ...this.snapshot, stale: true };
      }
      throw err;
    }
  }

  private async refresh(): Promise<MarketSnapshot> {
    const fx = await this.fetchFx();
    const gold = await this.fetchGold(fx.fawazXau);
    const snap: MarketSnapshot = {
      updatedAt: new Date(this.now()).toISOString(),
      goldUsdPerGram24: gold.usdPerGram,
      usdPer: fx.usdPer,
      sources: { gold: gold.source, fx: fx.source },
      stale: false,
    };
    this.snapshot = snap;
    this.fetchedAt = this.now();
    return snap;
  }

  private async fetchFx(): Promise<{
    usdPer: Record<string, number>;
    source: string;
    fawazXau?: number;
  }> {
    let lastError: unknown;
    for (const url of FAWAZ) {
      try {
        const data = await getJson(this.fetchFn, url);
        const table = data?.usd as Record<string, unknown> | undefined;
        if (!table) throw new Error('no table');
        const usdPer: Record<string, number> = { USD: 1 };
        for (const code of MARKET_CURRENCIES) {
          const v = table[code.toLowerCase()];
          if (finitePositive(v)) usdPer[code] = v;
        }
        if (!usdPer.EGP && !usdPer.EUR) throw new Error('table looks empty');
        return {
          usdPer,
          source: 'currency-api',
          fawazXau: finitePositive(table.xau) ? (table.xau as number) : undefined,
        };
      } catch (e) {
        lastError = e;
      }
    }
    try {
      const data = await getJson(this.fetchFn, 'https://open.er-api.com/v6/latest/USD');
      const rates = data?.rates as Record<string, unknown> | undefined;
      if (!rates) throw new Error('no rates');
      const usdPer: Record<string, number> = { USD: 1 };
      for (const code of MARKET_CURRENCIES) {
        if (finitePositive(rates[code])) usdPer[code] = rates[code] as number;
      }
      return { usdPer, source: 'open.er-api' };
    } catch (e) {
      throw lastError ?? e;
    }
  }

  private async fetchGold(
    fawazXau?: number
  ): Promise<{ usdPerGram: number; source: string }> {
    try {
      const data = await getJson(this.fetchFn, 'https://api.gold-api.com/price/XAU');
      if (finitePositive(data?.price)) {
        return { usdPerGram: data.price / TROY_OUNCE_GRAMS, source: 'gold-api' };
      }
      throw new Error('no price');
    } catch {
      // XAU in the currency table is troy ounces per dollar
      if (fawazXau) {
        return { usdPerGram: 1 / fawazXau / TROY_OUNCE_GRAMS, source: 'currency-api' };
      }
      throw new Error('gold price unavailable');
    }
  }
}

export const marketPriceService = new MarketPriceService();
