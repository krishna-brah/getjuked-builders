/** The Builder API's address: juke itself unless JUKE_BASE_URL names another. */
export const DEFAULT_BASE = 'https://www.getjuked.io/api/v3-beta';

/**
 * Where the key may go: juke itself (https on getjuked.io) or the builder's own machine (a local juke on localhost or
 * 127.0.0.1, for testing). Anything else (another host, plain http, credentials in the address) is refused: null.
 */
export function baseUrl(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return DEFAULT_BASE;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  const juke = url.protocol === 'https:' && (url.hostname === 'getjuked.io' || url.hostname.endsWith('.getjuked.io'));
  const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  return (juke || local) && !url.username && !url.password ? value.trim().replace(/\/$/u, '') : null;
}
