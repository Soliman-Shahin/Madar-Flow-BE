import logger from './logger';

/** Placeholder written by older code when a Google account had no photo. */
const PLACEHOLDER = 'profile.png';
const MAX_BYTES = 250 * 1024;
const FETCH_TIMEOUT_MS = 4000;

/** True when the user already has a picture of their own (uploaded or stored). */
export function hasStoredAvatar(image?: string | null): boolean {
  return !!image && image !== PLACEHOLDER;
}

/**
 * Google profile picture URLs are hot-link protected and can expire, so the
 * picture is fetched once and stored with the account (as a data URL, the same
 * shape as an uploaded photo). If anything goes wrong the plain URL is kept.
 * Only used to FILL a missing picture, never to replace one the user chose.
 */
export async function resolveGoogleAvatar(
  url: string | undefined
): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !/\.googleusercontent\.com$/.test(parsed.hostname)) {
      return url;
    }
    // Ask Google for a small square crop instead of the full-size original.
    const sized = url.replace(/=s\d+(-c)?$/, '') + '=s256-c';
    const res = await fetch(sized, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return url;
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return url;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return url;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch (error) {
    logger.warn('Could not cache Google avatar; keeping its URL');
    return url;
  }
}
