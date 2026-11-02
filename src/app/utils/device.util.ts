/** Anything with Express's req.get(header) — keeps the helpers easy to test. */
type HeaderReader = { get(name: string): string | string[] | undefined };

export type ClientPlatform = 'web' | 'android' | 'ios';

/** Platform the app says it runs on (native apps send x-client-platform). */
export function clientPlatform(req: HeaderReader): ClientPlatform {
  const value = String(req.get('x-client-platform') ?? '');
  return value === 'android' || value === 'ios' ? value : 'web';
}

/**
 * A short, human label for the device that signed in, so a user with two
 * browsers (or two phones) can tell the sessions apart. Built from the
 * User-Agent only; nothing precise (no IP, no full UA) is stored.
 */
export function describeDevice(req: HeaderReader): string | undefined {
  const ua = String(req.get('user-agent') || '');
  if (!ua) return undefined;

  const android = /Android[^;)]*;\s*([^;)]+?)(?:\sBuild|\)|;)/.exec(ua);
  const model = android?.[1]?.trim();
  const os = /Windows/i.test(ua)
    ? 'Windows'
    : /iPhone|iPad|iPod/i.test(ua)
    ? 'iOS'
    : /Android/i.test(ua)
    ? 'Android'
    : /Mac OS X|Macintosh/i.test(ua)
    ? 'macOS'
    : /CrOS/i.test(ua)
    ? 'ChromeOS'
    : /Linux/i.test(ua)
    ? 'Linux'
    : undefined;

  const browser = /Edg(?:e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
    ? 'Opera'
    : /Firefox\/|FxiOS\//.test(ua)
    ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua)
    ? 'Chrome'
    : /Safari\//.test(ua)
    ? 'Safari'
    : undefined;

  let label: string | undefined;
  if (model && os === 'Android' && model !== 'K') {
    label = `${model}${browser ? ` · ${browser}` : ''}`;
  } else if (browser && os) {
    label = `${browser} on ${os}`;
  } else {
    label = browser || os;
  }
  return label ? label.slice(0, 60) : undefined;
}
