/** A parsed target plus the port the scan will actually contact. */
export interface UrlTarget {
  url: URL;
  /** URL のポート。省略時は HTTP 80、HTTPS 443。 */
  port: string;
}

export function parseCyberUrl(input: string): UrlTarget | null {
  if (input.length > 4096 || !/^https?:\/\/[^/?#]/i.test(input) || /[\s\\\p{Cc}]/u.test(input)) return null;
  const url = URL.parse(input);
  if (!url || url.username || url.password) return null;
  url.hash = '';
  return { url, port: url.port || (url.protocol === 'https:' ? '443' : '80') };
}

/** The URL as shown in prompts and reports: the query and fragment never appear. */
export function displayUrl(target: UrlTarget): string {
  return target.url.origin + target.url.pathname + (target.url.search ? '（クエリ非表示）' : '');
}
