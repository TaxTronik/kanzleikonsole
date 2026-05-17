// =============================================================================
// @taxtronik/rss — Geteilter RSS-Fetcher + Parser.
//
// Vorher Code-Duplikation Web (apps/web/src/server/tax-news/fetcher.ts) und
// Worker (apps/worker/src/jobs/tax-news-fetch.ts). Beide Pfade haben dieselbe
// Regex-XML-Extraktion, dieselbe MIME-/URL-Validierung und dieselbe
// Body-Cap-Logik — Drift-Klasse, wenn jemand den Parser bug-fixt oder den
// Cap auf 5 MB hochsetzt.
//
// Konsolidierung Round 12: dieses Package ist Single Source of Truth.
// =============================================================================

import { safeFetch } from '@taxtronik/http-utils';

export interface FetchedRssItem {
  source: string; // = feed URL
  guid: string;
  title: string;
  summary: string | null;
  link: string;
  publishedAt: Date | null;
}

export interface FetchRssOptions {
  /** Cap auf Body-Größe (Default: 2 MB). Größer ist OOM-Risiko. */
  maxBytes?: number;
  /** Timeout in ms (Default: 20s, an safeFetch durchgereicht). */
  timeoutMs?: number;
  /** User-Agent. Default: `taxtronik-news-bot/1.0`. */
  userAgent?: string;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_USER_AGENT = 'taxtronik-news-bot/1.0';

// ---------------------------------------------------------------------------
// Parser (regex-basiert; RSS 2.0 ist regulär genug)
// ---------------------------------------------------------------------------

function stripCData(s: string): string {
  return s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function pickTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return null;
  return decodeEntities(stripCData(m[1]!.trim()));
}

/**
 * S-1: javascript:/data:/file:-URIs aus RSS-Links filtern.
 */
function isSafeHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseRss(xml: string, sourceUrl: string): FetchedRssItem[] {
  const items: FetchedRssItem[] = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[0];
    const title = pickTag(block, 'title') ?? '';
    const link = pickTag(block, 'link') ?? '';
    const description = pickTag(block, 'description');
    const guid = pickTag(block, 'guid') ?? link;
    const pubDate = pickTag(block, 'pubDate');
    if (!title || !link) continue;
    if (!isSafeHttpUrl(link)) continue;
    items.push({
      source: sourceUrl,
      guid,
      title: title.replace(/<[^>]+>/g, '').slice(0, 500),
      summary: description ? description.replace(/<[^>]+>/g, '').slice(0, 2000) : null,
      link,
      publishedAt: pubDate ? new Date(pubDate) : null,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Fetcher (SSRF-Guard + DNS-Pinning + Body-Cap)
// ---------------------------------------------------------------------------

/**
 * Lädt einen RSS-Feed mit SSRF-Guard, DNS-Pinning, redirect:'error' und
 * Body-Streaming-Cap. Verwendet `safeFetch` aus @taxtronik/http-utils.
 */
export async function fetchRssFeed(
  url: string,
  opts: FetchRssOptions = {},
): Promise<FetchedRssItem[]> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

  const res = await safeFetch(url, {
    headers: {
      'user-agent': userAgent,
      accept: 'application/rss+xml, application/xml, text/xml',
    },
    signal: AbortSignal.timeout(timeoutMs),
    // redirect: 'error' ist Default in safeFetch (Round 12).
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const cl = res.headers.get('content-length');
  if (cl && Number(cl) > maxBytes) {
    throw new Error(`Feed-Größe ${cl} überschreitet Limit ${maxBytes}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Feed ohne Body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => void 0);
        throw new Error(`Feed-Body überschreitet Limit ${maxBytes} (gestreamt: ${total})`);
      }
      chunks.push(value);
    }
  }
  const xml = Buffer.concat(chunks).toString('utf8');
  return parseRss(xml, url);
}
