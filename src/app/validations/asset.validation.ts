import { z } from 'zod';

const money = z.number().finite().nonnegative().max(1_000_000_000);
const positive = z.number().finite().positive().max(1_000_000_000);
const code = z.string().regex(/^[A-Z]{3}$/);

const gold = z.object({
  grams: positive.max(100_000),
  karat: z.union([
    z.literal(24),
    z.literal(22),
    z.literal(21),
    z.literal(18),
    z.literal(14),
    z.literal(10),
    z.literal(9),
  ]),
  form: z.enum(['bar', 'coin', 'jewelry']),
  /** Paid per gram of this karat, in the cost currency. */
  pricePerGram: money.optional(),
  /** Total making charge, in the cost currency (never counted in resale value). */
  makingCharge: money.optional(),
});

const currency = z.object({
  code,
  amount: positive,
  /** Cost currency per 1 unit of `code` at purchase. */
  rate: positive,
});

const certificate = z.object({
  principal: positive,
  /** Yearly rate in percent. */
  annualRate: z.number().min(0).max(100),
  termMonths: z.number().int().min(1).max(600),
  bank: z.string().trim().max(60).optional(),
});

const investment = z.object({
  symbol: z.string().trim().min(1).max(20),
  quantity: positive,
  buyPrice: money,
  /** Entered by the person; there is no free live price for every market. */
  currentPrice: money.optional(),
});

const other = z.object({ currentValue: money });

const common = {
  name: z.string().trim().min(1).max(80),
  status: z.enum(['held', 'sold']).default('held'),
  purchasedAt: z.coerce.date(),
  cost: z.object({ amount: money, currency: code }),
  note: z.string().trim().max(200).optional(),
  soldAt: z.coerce.date().optional(),
  saleAmount: money.optional(),
  /** When the person last edited it on their phone: the newer copy wins. */
  updatedAt: z.coerce.date(),
};

export const assetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('gold'), details: gold, ...common }),
  z.object({ type: z.literal('currency'), details: currency, ...common }),
  z.object({ type: z.literal('certificate'), details: certificate, ...common }),
  z.object({ type: z.literal('investment'), details: investment, ...common }),
  z.object({ type: z.literal('other'), details: other, ...common }),
]);

export type AssetInput = z.infer<typeof assetSchema>;

export const clientIdParam = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid id');
