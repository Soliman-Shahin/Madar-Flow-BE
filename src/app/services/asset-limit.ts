import { PlanLimits } from '../types/plan.types';

/** Allowance for a plan saved before the setting existed. */
const FALLBACK: Record<string, number | null> = {
  free: 10,
  basic: 25,
  pro: 100,
  premium: null,
  enterprise: null,
};

/**
 * How many vault items a plan allows (null = unlimited). The dashboard sets
 * `maxAssets` per plan; the table above only covers plans that have no value.
 */
export function assetLimitFor(
  limits: Partial<PlanLimits> | undefined,
  planSlug: string
): number | null {
  const v = limits?.maxAssets;
  if (v === undefined) return planSlug in FALLBACK ? FALLBACK[planSlug] : 10;
  return v;
}
