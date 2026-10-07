// =============================================================================
// SSRF-geschützter Abruf von Sperrlisten (T-02)
//
// Fachkatalog: ACCESS-TENANT-RLS-001
//
// Die CRL-URL stammt aus dem Distribution Point eines Zertifikats, also aus
// fremden Daten. certificate-path.ts lädt sie erst, nachdem die Kette ohne
// Netzzugriff bis zu einer Trust Anchor aufgebaut ist; trotzdem darf der
// Abruf kein internes Ziel erreichen:
//
//   - nur http:/https: ohne Zugangsdaten auf den Standardports 80/443;
//   - der Host wird genau einmal aufgelöst (IP-Literale ohne DNS). Jede
//     Adresse muss öffentlich sein, sonst wird abgewiesen. Gesperrt sind
//     unspezifizierte, Loopback-, private (RFC 1918, RFC 4193), Link-local-,
//     CGNAT-, Multicast- sowie weitere nicht global erreichbare Adressen,
//     auch als IPv4-gemappte, IPv4-kompatible oder NAT64-Form;
//   - verbunden wird ausschließlich mit diesen geprüften Adressen: Der
//     Verbindungsaufbau erhält einen festen `lookup`, eine zweite
//     DNS-Auflösung (DNS-Rebinding) findet nicht statt. HTTPS prüft das
//     Serverzertifikat weiterhin gegen den Hostnamen;
//   - Redirects werden nie verfolgt (`redirect: 'error'`), auch nicht auf
//     geprüfte Hosts.
//
// Jede Abweisung wirft; certificate-path.ts behandelt sie wie eine nicht
// erreichbare CRL (fail-closed). Größengrenze und Abbruchsignal setzt
// weiterhin der Aufrufer; ohne Signal begrenzt ein Leerlauf-Timeout von
// 300 s den Abruf (wie die Header-/Body-Timeouts von fetch).
// =============================================================================

import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, isIPv4, isIPv6, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

const CRL_IDLE_TIMEOUT_MS = 300_000;

/** Nicht global erreichbare IPv4-Netze (IANA Special-Purpose Registry). */
const FORBIDDEN_IPV4_SUBNETS: ReadonlyArray<readonly [network: string, prefix: number]> = [
  ['0.0.0.0', 8], // unspezifiziert, „this network“
  ['10.0.0.0', 8], // privat (RFC 1918)
  ['100.64.0.0', 10], // CGNAT (RFC 6598)
  ['127.0.0.0', 8], // Loopback
  ['169.254.0.0', 16], // Link-local, Cloud-Metadaten
  ['172.16.0.0', 12], // privat (RFC 1918)
  ['192.0.0.0', 24], // IETF-Protokollzuweisungen
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4-Relay (veraltet)
  ['192.168.0.0', 16], // privat (RFC 1918)
  ['198.18.0.0', 15], // Benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // Multicast
  ['240.0.0.0', 4], // reserviert, Broadcast
];

const FORBIDDEN_IPV4 = new BlockList();
for (const [network, prefix] of FORBIDDEN_IPV4_SUBNETS) {
  FORBIDDEN_IPV4.addSubnet(network, prefix, 'ipv4');
}

export type CrlFetchInit = {
  /** Abbruchsignal des Gesamtzeitlimits. */
  signal?: AbortSignal;
  /** Redirects werden nie verfolgt; ein 3xx scheitert. */
  redirect: 'error';
};

/** Löst einen Hostnamen auf (Standard: Betriebssystem-Resolver wie bei fetch). */
export type CrlHostResolver = (hostname: string) => Promise<readonly LookupAddress[]>;

const systemResolver: CrlHostResolver = (hostname) => dnsLookup(hostname, { all: true });

/** Der Abruf wurde vor jedem Verbindungsaufbau abgewiesen. */
export class CrlTargetRefusedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CrlTargetRefusedError';
  }
}

function permittedIPv4(address: string): boolean {
  return isIPv4(address) && !FORBIDDEN_IPV4.check(address, 'ipv4');
}

/** Acht 16-Bit-Gruppen einer IPv6-Adresse; null bei Zonen-ID oder ungültiger Form. */
function ipv6Groups(address: string): number[] | null {
  if (address.includes('%') || !isIPv6(address)) return null;
  const expand = (part: string): number[] =>
    part === ''
      ? []
      : part.split(':').flatMap((group) => {
          if (!group.includes('.')) return [Number.parseInt(group, 16)];
          if (!isIPv4(group)) return [Number.NaN];
          const [a, b, c, d] = group.split('.').map(Number) as [number, number, number, number];
          return [(a << 8) | b, (c << 8) | d];
        });
  const [headPart, tailPart] = address.split('::') as [string, string | undefined];
  const head = expand(headPart);
  const tail = tailPart === undefined ? [] : expand(tailPart);
  const groups =
    tailPart === undefined
      ? head
      : [...head, ...Array<number>(Math.max(0, 8 - head.length - tail.length)).fill(0), ...tail];
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

/** Die letzten 32 Bit als IPv4-Adresse (gemappte und NAT64-Formen). */
function embeddedIPv4(groups: readonly number[]): string {
  const high = groups[6]!;
  const low = groups[7]!;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function permittedIPv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups) return false;
  const [first, second] = groups as [number, number, ...number[]];
  // IPv4-gemappt (::ffff:0:0/96): die eingebettete IPv4-Adresse entscheidet.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return permittedIPv4(embeddedIPv4(groups));
  }
  // NAT64 (64:ff9b::/96, RFC 6052): ebenso die eingebettete IPv4-Adresse.
  if (first === 0x64 && second === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return permittedIPv4(embeddedIPv4(groups));
  }
  // Sonst nur Global Unicast (2000::/3). Das schließt ::/128, ::1, die
  // IPv4-kompatible Form ::/96, 64:ff9b:1::/48, 100::/64, fc00::/7 (RFC 4193),
  // fe80::/10, fec0::/10 und ff00::/8 (Multicast) aus.
  if ((first & 0xe000) !== 0x2000) return false;
  // Nicht global erreichbare Blöcke innerhalb von 2000::/3.
  if (first === 0x2001 && second < 0x0200) return false; // 2001::/23 (u. a. Teredo)
  if (first === 0x2001 && second === 0x0db8) return false; // 2001:db8::/32 Dokumentation
  if (first === 0x2002) return false; // 2002::/16 6to4
  if (first === 0x3fff && second < 0x1000) return false; // 3fff::/20 Dokumentation
  return true;
}

/** Darf eine CRL von dieser Adresse geladen werden (nur öffentliche Adressen)? */
export function isPermittedCrlAddress(address: string): boolean {
  return isIPv4(address) ? permittedIPv4(address) : permittedIPv6(address);
}

function bareHostname(url: URL): string {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

/** http/https ohne Zugangsdaten auf Port 80/443, wie parseCRLURL in certificate-path.ts. */
function crlTargetURL(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new CrlTargetRefusedError('CRL URL is invalid', { cause: error });
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (parsed.port && !['80', '443'].includes(parsed.port))
  ) {
    throw new CrlTargetRefusedError('CRL URL is not permitted');
  }
  return parsed;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Löst den Host der CRL-URL genau einmal auf und gibt die Adressen nur zurück,
 * wenn alle öffentlich sind. IP-Literale werden ohne DNS geprüft.
 */
export async function resolveCrlAddresses(
  hostname: string,
  resolve: CrlHostResolver = systemResolver,
  signal?: AbortSignal,
): Promise<LookupAddress[]> {
  const literalFamily = isIP(hostname);
  let addresses: readonly LookupAddress[];
  if (literalFamily !== 0) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await abortable(resolve(hostname), signal);
    } catch (error) {
      throw new CrlTargetRefusedError('CRL host could not be resolved', { cause: error });
    }
  }
  if (addresses.length === 0) throw new CrlTargetRefusedError('CRL host could not be resolved');
  const forbidden = addresses.find(({ address }) => !isPermittedCrlAddress(address));
  if (forbidden) {
    throw new CrlTargetRefusedError(
      `CRL host resolves to a non-public address: ${forbidden.address}`,
    );
  }
  return addresses.map(({ address, family }) => ({ address, family }));
}

/** Verbindungs-Lookup, der ausschließlich die geprüften Adressen liefert. */
function pinnedLookup(hostname: string, addresses: readonly LookupAddress[]): LookupFunction {
  return (requested, options, callback) => {
    const candidates =
      options.family === 4 || options.family === 6
        ? addresses.filter((entry) => entry.family === options.family)
        : addresses;
    if (requested !== hostname || candidates.length === 0) {
      const error: NodeJS.ErrnoException = new Error(`CRL host ${requested} is not pinned`);
      error.code = 'ENOTFOUND';
      callback(error, '', 0);
      return;
    }
    if (options.all) {
      callback(
        null,
        candidates.map(({ address, family }) => ({ address, family })),
      );
    } else {
      callback(null, candidates[0]!.address, candidates[0]!.family);
    }
  };
}

function responseHeaders(incoming: http.IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(name, item);
    }
  }
  return headers;
}

/**
 * GET auf die URL über genau die übergebenen (geprüften) Adressen. Ein 3xx
 * wird nie verfolgt und scheitert; andere Status liefern eine Response, deren
 * Body nur bei 2xx gelesen werden kann.
 */
export function requestPinnedCrl(
  url: URL,
  addresses: readonly LookupAddress[],
  init: CrlFetchInit,
): Promise<Response> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise<Response>((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: 'GET',
        // Eigene Verbindung je Abruf: kein Socket aus einem gemeinsamen Pool.
        agent: false,
        lookup: pinnedLookup(bareHostname(url), addresses),
        signal: init.signal,
        timeout: CRL_IDLE_TIMEOUT_MS,
        headers: { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'node' },
      },
      (incoming) => {
        const status = incoming.statusCode ?? 0;
        try {
          if (status >= 300 && status < 400) {
            throw new Error(`CRL endpoint redirects are not permitted (HTTP ${status})`);
          }
          const ok = status >= 200 && status < 300;
          if (!ok) incoming.destroy();
          resolve(
            new Response(ok ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>) : null, {
              status,
              statusText: incoming.statusMessage,
              headers: responseHeaders(incoming),
            }),
          );
        } catch (error) {
          incoming.destroy();
          reject(error as Error);
        }
      },
    );
    request.on('timeout', () => request.destroy(new Error('CRL endpoint timed out')));
    request.on('error', reject);
    request.end();
  });
}

/**
 * Lädt eine CRL SSRF-geschützt (siehe Dateikopf). `resolve` ersetzt nur die
 * Namensauflösung; auch deren Ergebnis muss die Adressprüfung bestehen.
 */
export async function fetchCrl(
  url: string,
  init: CrlFetchInit,
  resolve: CrlHostResolver = systemResolver,
): Promise<Response> {
  const target = crlTargetURL(url);
  const addresses = await resolveCrlAddresses(bareHostname(target), resolve, init.signal);
  return requestPinnedCrl(target, addresses, init);
}
