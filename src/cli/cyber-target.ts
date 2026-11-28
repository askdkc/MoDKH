import { isIP } from 'node:net';

/** True when the host is an IPv6 literal, which Nmap needs -6 for. */
export function isIpv6(host: string): boolean {
  return isIP(host) === 6;
}

/** A parsed target plus the port the scan will actually contact. */
export interface ScanTarget {
  url: URL;
  /** The port the URL implies: the explicit one, else 443 for HTTPS and 80 for HTTP. */
  port: string;
  /** Host without IPv6 brackets, as a scanner wants it. */
  host: string;
  /** True when the URL carries a query, which is what sqlmap needs to have a target. */
  hasQuery: boolean;
}

/**
 * Accept one HTTP(S) address without credentials. The query is kept for sqlmap
 * but never printed or written to the audit record.
 */
export function parseTarget(input: string): ScanTarget | null {
  const text = input.trim();
  if (text.length > 4096 || /[\s\\\p{Cc}]/u.test(text)) return null;
  if (!/^https?:\/\/[^/?#]/i.test(text)) return null;
  const url = URL.parse(text);
  if (!url || url.username || url.password) return null;
  url.hash = '';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return null;
  return {
    url,
    port: url.port || (url.protocol === 'https:' ? '443' : '80'),
    host,
    hasQuery: url.search.length > 1,
  };
}

/** The URL as shown in prompts, reports and records: the query never appears. */
export function displayTarget(target: ScanTarget): string {
  return target.url.origin + target.url.pathname + (target.hasQuery ? '（クエリ非表示）' : '');
}

/** A URL derived from the target for a tool, with the query intact. */
export function toolUrl(target: ScanTarget): string {
  return target.url.origin + target.url.pathname + target.url.search;
}
