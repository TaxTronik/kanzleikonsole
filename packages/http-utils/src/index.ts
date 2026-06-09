// =============================================================================
// @taxtronik/http-utils — Shared SSRF-Guard + safeFetch.
//
// Single Source of Truth für SSRF-Schutz und DNS-Rebinding-sicheres fetch.
// Vorher gab es zwei parallele Kopien (apps/web/src/server/http/ssrf-guard.ts
// und apps/worker/src/http/ssrf-guard.ts), die bei jeder Sicherheits-Iteration
// (H1/H3/H4/N1/N2/N9) zweimal angepasst werden mussten — und genau das ist
// regelmäßig vergessen worden, sodass Worker-Pfade die Web-Patches nicht
// mitnahmen.
//
// IPv4/IPv6-Block-Listen siehe `assertPublicHost`. `safeFetch` macht Lookup
// + Pin + fetch + Body-Stream-Lifecycle in einem.
// =============================================================================

import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

// IPv4 reserved/private ranges (CIDR)
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;                                  // 10.0.0.0/8
  if (a === 127) return true;                                 // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true;                    // 169.254.0.0/16 (link-local incl. AWS-IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16.0.0/12
  if (a === 192 && b === 168) return true;                    // 192.168.0.0/16
  if (a === 0) return true;                                   // 0.0.0.0/8
  if (a >= 224) return true;                                  // 224.0.0.0/4 (multicast) + 240.0.0.0/4 (reserved)
  // M-5: CGNAT (RFC 6598) — wird von ISPs für Multi-Customer-NAT genutzt;
  // für interne Origins „nicht öffentlich".
  if (a === 100 && b >= 64 && b <= 127) return true;          // 100.64.0.0/10
  return false;
}

/**
 * F4: Hex-kodierten v4-mapped-Suffix (zwei 16-Bit-Gruppen nach "::ffff:") in
 * dotted IPv4 wandeln: Rest "7f00:1" → "127.0.0.1". null, wenn die Form nicht
 * passt (der Aufrufer behandelt das fail-closed).
 */
function v4MappedHexToDotted(rest: string): string | null {
  const parts = rest.split(':');
  if (parts.length !== 2) return null;
  if (!/^[0-9a-f]{1,4}$/.test(parts[0]!) || !/^[0-9a-f]{1,4}$/.test(parts[1]!)) return null;
  const hi = parseInt(parts[0]!, 16);
  const lo = parseInt(parts[1]!, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fc') || v.startsWith('fd')) return true;
  if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true;
  // M-5: deprecated site-local fec0::/10, NAT64 64:ff9b::/96, 6to4 2002::/16.
  if (v.startsWith('fec') || v.startsWith('fed') || v.startsWith('fee') || v.startsWith('fef')) return true;
  if (v.startsWith('64:ff9b:')) return true;
  if (v.startsWith('2002:')) return true;
  if (v.startsWith('::ffff:')) {
    const rest = v.slice('::ffff:'.length);
    // Dotted-Form: ::ffff:127.0.0.1
    if (isIP(rest) === 4) return isPrivateIPv4(rest);
    // F4: Hex-Form ::ffff:7f00:1 — die letzten 32 Bit als IPv4 interpretieren.
    const v4 = v4MappedHexToDotted(rest);
    if (v4) return isPrivateIPv4(v4);
    // Nicht parsebare v4-mapped-Form → FAIL-CLOSED (als privat behandeln), statt
    // sie als „öffentlich" durchzulassen (sonst Loopback-/Private-Bypass).
    return true;
  }
  return false;
}

/**
 * Nur für Unit-Tests exportiert (Tabellen-Tests der SSRF-Policy ohne DNS).
 * Produktiv-Caller nutzen ausschließlich `assertPublicHost`/`safeFetch`.
 */
export { isPrivateIPv4, isPrivateIPv6, v4MappedHexToDotted };

/**
 * N2: Eigene Fehler-Klasse statt String-Match. Caller können sicher per
 * `instanceof SsrfGuardError` zwischen SSRF-Verweigerung und sonstigen
 * fetch-Fehlern (Connect-Refused, Timeout, TLS-Cert) unterscheiden, ohne
 * sich auf Wortlaut zu verlassen.
 */
export class SsrfGuardError extends Error {
  readonly reason: 'invalid-url' | 'forbidden-scheme' | 'literal-ip' | 'private-address';
  constructor(reason: SsrfGuardError['reason'], message: string) {
    super(message);
    this.name = 'SsrfGuardError';
    this.reason = reason;
  }
}

/**
 * IPv6-Brackets entfernen: `[::1]` → `::1`. URL.hostname liefert IPv6-Literale
 * MIT Brackets — isIP()/Range-Checks erwarten die nackte Adresse.
 */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Allowlist für interne Hostnames, die bewusst auf private/Loopback-Adressen
 * zeigen dürfen (z. B. Docker-Compose-Service-DNS: `n8n`, `seaweedfs`).
 *
 * Konfiguration:
 *  - `INTERNAL_FETCH_HOSTS=n8n,seaweedfs,host.docker.internal` — Komma-Liste
 *    (IPv6 wahlweise mit oder ohne Brackets, wird normalisiert)
 *  - Im Dev-Mode (`NODE_ENV !== 'production'`) sind `localhost`, `127.0.0.1`,
 *    `[::1]` automatisch erlaubt — damit `pnpm dev` ohne Extra-Config läuft.
 *
 * Sicherheits-Trade-off: jeder Hostname auf der Liste ist ein expliziter
 * Trust-Boundary. Wer ihn dort einträgt, übernimmt die Verantwortung, dass
 * die DNS-Antwort nicht von einem Angreifer manipuliert werden kann.
 */
function readAllowlist(): Set<string> {
  const raw = process.env['INTERNAL_FETCH_HOSTS'] ?? '';
  const set = new Set(
    raw
      .split(',')
      .map((s) => stripBrackets(s.trim().toLowerCase()))
      .filter((s) => s.length > 0),
  );
  if (process.env['NODE_ENV'] !== 'production') {
    set.add('localhost');
    set.add('127.0.0.1');
    set.add('::1');
  }
  return set;
}

/**
 * Wirft `SsrfGuardError`, wenn die URL nicht öffentlich auflösbar ist
 * (private IP, link-local, loopback) oder einen verbotenen Schemata nutzt.
 *
 * H1: Liefert die geprüften Adressen zurück, damit `safeFetch` den Lookup
 * pinnen kann.
 *
 * Allowlist-Bypass: Hostname-Match in `INTERNAL_FETCH_HOSTS` (+ Dev-Default
 * `localhost`/`127.0.0.1`/`::1`) überspringt die Literal-IP- und Private-
 * Address-Checks. Scheme-Check und URL-Parsing bleiben aktiv.
 */
export async function assertPublicHost(url: string): Promise<LookupAddress[]> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfGuardError('invalid-url', 'Ungültige URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfGuardError('forbidden-scheme', `Nur http(s) erlaubt (war: ${parsed.protocol}).`);
  }
  // URL.hostname liefert IPv6-Literale MIT Brackets (`[::1]`). Für isIP(),
  // Allowlist-Match und Range-Checks auf die nackte Adresse normalisieren —
  // sonst erkennt isIP() IPv6-Literale nie (die Literal-IP-Sperre griffe für
  // v6 nicht) und der Dev-Allowlist-Eintrag `::1` wäre tot.
  const host = stripBrackets(parsed.hostname.toLowerCase());
  const allowlist = readAllowlist();
  if (allowlist.has(host)) {
    // Trusted internal target — DNS-Lookup trotzdem, damit safeFetch pinnen
    // kann. Aber kein Private-/Literal-IP-Reject.
    if (isIP(host)) {
      return [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
    }
    return await lookup(host, { all: true });
  }
  if (isIP(host)) {
    throw new SsrfGuardError('literal-ip', 'Direkte IP-Adressen in URL nicht erlaubt.');
  }
  const addresses = await lookup(host, { all: true });
  for (const addr of addresses) {
    const blocked = addr.family === 4 ? isPrivateIPv4(addr.address) : isPrivateIPv6(addr.address);
    if (blocked) {
      throw new SsrfGuardError(
        'private-address',
        `Hostname löst auf eine private/reservierte Adresse auf: ${addr.address}`,
      );
    }
  }
  return addresses;
}

// Default-Timeout für safeFetch ohne explizites `signal`. Großzügig (30s)
// damit langsame Backends nicht stillschweigend gekillt werden, aber kein
// indefinit-hängender Worker.
const SAFE_FETCH_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * H1: SSRF- + DNS-Rebinding-sicherer fetch-Wrapper.
 *
 * 1. `assertPublicHost` löst auf und prüft jede zurückkommende IP.
 * 2. undici-Agent mit gepinntem `lookup` baut die Verbindung garantiert
 *    zur geprüften IP, kein Re-Resolve aus dem Netz.
 * 3. fetch verbindet darüber. HTTPS-SNI bleibt der Original-Hostname.
 *
 * Sichere Defaults (Audit-Feedback Round 12):
 *  - `redirect: 'error'` — ein 3xx auf einen anderen Hostnamen wäre nicht
 *    nochmal SSRF-geprüft. Caller kann explizit `redirect: 'follow'` setzen
 *    wenn er weiß was er tut.
 *  - `signal: AbortSignal.timeout(30s)` — verhindert indefinit-hängende
 *    Worker bei langsamem Backend. Caller kann eigenen `signal` mitgeben.
 *
 * N6: Agent wird erst geschlossen, nachdem der Body komplett gestreamt
 * (oder gecancelt) wurde — sonst bricht der Stream bei größeren Bodies.
 *
 * Performance-Hinweis (Round 12): pro Aufruf wird ein neuer Agent erzeugt,
 * also pro Request ein eigener TCP+TLS-Handshake. Für Hochfrequenz-Pfade
 * wäre ein Per-(host, pinned-IP)-Agent-Cache mit TTL sinnvoll —
 * aktueller Use-Case sind aber Admin-Trigger und tägliche Schedules
 * (RSS, TSA, Update-Manifest), wo der Overhead nicht ins Gewicht fällt.
 */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  const addresses = await assertPublicHost(url);
  // IPv4 vor IPv6 bevorzugen: dual-stack-Lookups liefern auf Windows oft
  // erst ::1 zurück, aber Docker-Desktop-Port-Forwards und die meisten
  // Default-Bindings (n8n, MinIO, SMTP) hören nur auf IPv4. Das ergäbe
  // sonst ein irreführendes „fetch failed" trotz laufendem Service.
  // Wenn der Hostname nur IPv6-Adressen hat, bleibt v6 das Ziel.
  const pinned = addresses.find((a) => a.family === 4) ?? addresses[0]!;
  const agent = new Agent({
    connect: {
      // Node 22+ ruft den Lookup für Happy-Eyeballs-Connect mit `options.all=true`
      // auf und erwartet dann ein Array von `{address, family}`-Objekten in der
      // Callback-Position 2. Der einarmige `(err, address, family)`-Pfad bleibt
      // für ältere Callsites kompatibel. Ohne den `all`-Zweig wirft Node:
      //   TypeError [ERR_INVALID_IP_ADDRESS]: Invalid IP address: undefined
      lookup: (_hostname, opts, cb) => {
        if (opts && (opts as { all?: boolean }).all) {
          (cb as (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(
            null,
            [{ address: pinned.address, family: pinned.family }],
          );
        } else {
          cb(null, pinned.address, pinned.family);
        }
      },
    },
  });
  // Defaults VOR ...init, damit Caller sie explizit überschreiben können.
  const merged = {
    redirect: 'error' as const,
    signal: init?.signal ?? AbortSignal.timeout(SAFE_FETCH_DEFAULT_TIMEOUT_MS),
    ...init,
    dispatcher: agent,
  };
  let response: Response;
  try {
    // WICHTIG: undicis EIGENES fetch, NICHT Node's globales fetch. Ein Agent aus
    // dem undici-Paket ist nicht mit dem Node-internen undici-Dispatcher
    // kompatibel — auf Node 24 wirft das `UND_ERR_INVALID_ARG: invalid
    // onRequestStart method` (Handler-API-Versatz). Mit undicis fetch stammen
    // Agent UND fetch aus derselben undici-Version → versions-unabhängig stabil.
    response = (await undiciFetch(
      url,
      merged as unknown as Parameters<typeof undiciFetch>[1],
    )) as unknown as Response;
  } catch (err) {
    agent.close().catch(() => void 0);
    throw err;
  }
  if (!response.body) {
    agent.close().catch(() => void 0);
    return response;
  }
  let closed = false;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    agent.close().catch(() => void 0);
  };
  const wrapped = new ReadableStream({
    async start(controller) {
      const reader = response.body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      } finally {
        closeOnce();
      }
    },
    cancel(reason) {
      response.body?.cancel(reason).catch(() => void 0);
      closeOnce();
    },
  });
  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
