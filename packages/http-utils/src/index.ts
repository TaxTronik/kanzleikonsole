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

function parseIPv4(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

// Private und IANA-Special-Purpose-Netze. Die tabellarische CIDR-Darstellung
// hält die Policy überprüfbar und verhindert, dass jeder neue Bereich die
// Kontrollfluss-Komplexität des Guards erhöht.
const BLOCKED_IPV4_CIDRS: ReadonlyArray<readonly [network: number, prefix: number]> = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10 (CGNAT)
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16 (inkl. Cloud-Metadaten)
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc0000200, 24], // TEST-NET-1
  [0xc0586300, 24], // deprecated 6to4 relay
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // Benchmarking
  [0xc6336400, 24], // TEST-NET-2
  [0xcb007100, 24], // TEST-NET-3
  [0xe0000000, 3], // 224.0.0.0-255.255.255.255: Multicast und reserviert
];

function matchesIpv4Cidr(value: number, network: number, prefix: number): boolean {
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === network;
}

// IPv4 reserved/private ranges (CIDR)
function isPrivateIPv4(ip: string): boolean {
  const value = parseIPv4(ip);
  return (
    value === null ||
    BLOCKED_IPV4_CIDRS.some(([network, prefix]) => matchesIpv4Cidr(value, network, prefix))
  );
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
  if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb'))
    return true;
  // M-5: deprecated site-local fec0::/10, NAT64 64:ff9b::/96, 6to4 2002::/16.
  if (v.startsWith('fec') || v.startsWith('fed') || v.startsWith('fee') || v.startsWith('fef'))
    return true;
  // N-9: Multicast ff00::/8 (IANA Special-Purpose Registry). Deckt ff02::/link-
  // local, ff05:: etc. mit ab. Muss NACH fe8-fef stehen, kollidiert aber nicht,
  // da dort nur fe*/fec* geprüft wird — ff* fällt sonst durch als „öffentlich".
  if (v.startsWith('ff')) return true;
  if (v.startsWith('64:ff9b:')) return true;
  if (v.startsWith('2002:')) return true;
  // N-9: Dokumentation 2001:db8::/32 (RFC 3849) — eigener Prefix, liegt
  // AUSSERHALB des unten geprüften 2001::/23 (group2 = 0db8 > 0x01ff).
  if (v.startsWith('2001:db8:')) return true;
  // N-9: IETF-Protocol-Assignments 2001::/23 (IANA Special-Purpose Registry).
  // Der /23 umfasst group1 == 2001 UND group2 in [0x0000, 0x01ff] und deckt
  // damit Teredo (2001:0000::/32), Benchmarking (2001:0002::/48) und ORCHIDv2
  // (2001:0020::/28) gemeinsam ab. IPv6-Kurzschreibweise lässt führende Nullen
  // weg (2001:2:: statt 2001:0002::), darum group2 numerisch prüfen statt per
  // String-Prefix.
  if (v.startsWith('2001:')) {
    const group2 = v.split(':')[1] ?? '';
    // Leere group2 (z. B. "2001::") ⇒ 0x0000 ⇒ im /23, fail-closed.
    const n = group2 === '' ? 0 : parseInt(group2, 16);
    if (!Number.isNaN(n) && n <= 0x01ff) return true;
  }
  // N-9: Discard-Only 100::/64 (RFC 6666). group1 == 0100 und group2..4 == 0.
  // In Kurzform "100::". Enges Match, um öffentliche 1000::/… nicht zu treffen.
  if (v === '100::' || v.startsWith('100::') || v.startsWith('100:0:')) return true;
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
async function resolveHttpTarget(
  url: string,
  allowConfiguredInternalHosts: boolean,
): Promise<LookupAddress[]> {
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
  const allowlist = allowConfiguredInternalHosts ? readAllowlist() : new Set<string>();
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

/**
 * Ziel-Policy fuer HTTP-Aufrufe. `public` ist der sichere Default.
 * `trusted-internal` wertet die Infrastruktur-Allowlist aus und darf nur fuer
 * vom Betreiber fest verdrahtete Ziele verwendet werden. Die n8n-Policy ist
 * die eng begrenzte Compose-Ausnahme fuer die unten definierten Endpoints.
 */
export type N8nTargetKind = 'api' | 'webhook' | 'webhook-test' | 'health';
export type HttpTargetPolicy =
  | { mode: 'trusted-internal' }
  | { mode: 'public' }
  | { mode: 'n8n'; kind: N8nTargetKind };

/**
 * Einzige private Ausnahme fuer Tenant-konfigurierbare n8n-Ziele im
 * mitgelieferten Compose-Netz. Host, Schema, Port und Pfad sind Teil des
 * Vertrags; die globale Infrastruktur-Allowlist wird nicht ausgewertet.
 */
export function isManagedN8nTargetUrl(url: string, kind: N8nTargetKind): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== 'http:' ||
    stripBrackets(parsed.hostname.toLowerCase()) !== 'n8n' ||
    parsed.port !== '5678' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return false;
  }

  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }
  // Keine kodierten Separatoren oder Doppel-Decoding-Kandidaten: sonst kann
  // z. B. `/webhook%2f..%2fapi/v1` unsere Prefix-Prüfung bestehen, während
  // der Zielserver nach URL-Decoding einen anderen n8n-Endpoint adressiert.
  if (/%(?:2f|5c|25)/i.test(parsed.pathname) || path.includes('\\')) return false;
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return false;
  const prefix =
    kind === 'api'
      ? '/api/v1'
      : kind === 'webhook'
        ? '/webhook'
        : kind === 'webhook-test'
          ? '/webhook-test'
          : '/healthz';
  if (kind === 'health') return path === prefix && parsed.pathname === prefix;
  return (
    (path === prefix || path.startsWith(`${prefix}/`)) &&
    (parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`))
  );
}

function assertExternalN8nTransport(parsed: URL): void {
  if (parsed.protocol === 'https:') return;

  const host = stripBrackets(parsed.hostname.toLowerCase());
  if (isIP(host)) {
    throw new SsrfGuardError('literal-ip', 'Literal-IP-Adressen sind nicht erlaubt.');
  }
  if (readAllowlist().has(host)) {
    throw new SsrfGuardError(
      'private-address',
      'Die Infrastruktur-Allowlist gilt nicht für externe n8n-Ziele.',
    );
  }
  throw new SsrfGuardError('forbidden-scheme', 'Externe n8n-Ziele müssen HTTPS verwenden.');
}

async function assertN8nUrl(url: string, kind: N8nTargetKind): Promise<LookupAddress[]> {
  if (isManagedN8nTargetUrl(url, kind)) {
    const addresses = await lookup('n8n', { all: true });
    if (addresses.length === 0) {
      throw new SsrfGuardError('private-address', 'Verwaltetes n8n-Ziel ist nicht auflösbar.');
    }
    return addresses;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfGuardError('invalid-url', 'Ungültige URL.');
  }
  // Der einzige zulässige Klartextkanal ist der exakt verwaltete Docker-
  // Service oben. Externe n8n-API-Keys und Mandantendaten dürfen nie über
  // HTTP übertragen oder von einem MITM als erfolgreich quittiert werden.
  assertExternalN8nTransport(parsed);
  return await resolveHttpTarget(url, false);
}

/**
 * Loest ein Ziel gemaess Trust-Policy auf. Ohne explizite Policy sind nur
 * oeffentliche Ziele erlaubt; interne Ausnahmen muessen am Callsite sichtbar
 * als `trusted-internal` beziehungsweise als zweckgebundene n8n-Policy stehen.
 */
export async function assertPublicHost(
  url: string,
  policy: HttpTargetPolicy = { mode: 'public' },
): Promise<LookupAddress[]> {
  if (policy.mode === 'n8n') return await assertN8nUrl(url, policy.kind);
  return await resolveHttpTarget(url, policy.mode === 'trusted-internal');
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
 * N-10: Zusätzlich ist der Agent-Close an das effektive `signal` gekoppelt.
 * Ein Caller, der NUR `res.status` liest und den Body nie konsumiert/cancelt,
 * würde sonst die Verbindung (und den undici-Agent) offen halten. Spätestens
 * beim Timeout/Abort (Default 30s) wird der Agent garantiert geschlossen und
 * der Body verworfen. Wer den Body regulär liest, ist davon unberührt.
 *
 * Performance-Hinweis (Round 12): pro Aufruf wird ein neuer Agent erzeugt,
 * also pro Request ein eigener TCP+TLS-Handshake. Für Hochfrequenz-Pfade
 * wäre ein Per-(host, pinned-IP)-Agent-Cache mit TTL sinnvoll —
 * aktueller Use-Case sind aber Admin-Trigger und tägliche Schedules
 * (RSS, TSA, Update-Manifest), wo der Overhead nicht ins Gewicht fällt.
 */
async function safeFetchResolved(
  url: string,
  init: RequestInit | undefined,
  addresses: LookupAddress[],
): Promise<Response> {
  // IPv4 vor IPv6 bevorzugen: dual-stack-Lookups liefern auf Windows oft
  // erst ::1 zurück, aber Docker-Desktop-Port-Forwards und die meisten
  // Default-Bindings (n8n, SeaweedFS, SMTP) hören nur auf IPv4. Das ergäbe
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
          (cb as (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(null, [
            { address: pinned.address, family: pinned.family },
          ]);
        } else {
          cb(null, pinned.address, pinned.family);
        }
      },
    },
  });
  // Ein explizites Signal ersetzt den Default; signal:null darf den
  // Standardtimeout nicht aufheben. Dasselbe effektive Signal steuert
  // Netzwerkaufruf und Abbruch des Antwortstroms.
  const effectiveSignal = init?.signal ?? AbortSignal.timeout(SAFE_FETCH_DEFAULT_TIMEOUT_MS);
  const merged = {
    redirect: 'error' as const,
    ...init,
    signal: effectiveSignal,
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
  const reader = response.body.getReader();
  let closed = false;
  let onAbort: () => void;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    effectiveSignal.removeEventListener('abort', onAbort);
    agent.close().catch(() => void 0);
  };
  // Nur auf Nachfrage lesen: eine Schleife in start() würde die gesamte
  // Antwort unabhängig vom Consumer puffern und dessen Größenlimit umgehen.
  // Abbruch muss den sperrenden Reader erreichen; body.cancel() wäre nach
  // getReader() unwirksam (TypeError wegen des bereits gesperrten Streams).
  const wrapped = new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        if (closed) return;
        controller.error(effectiveSignal.reason);
        reader.cancel(effectiveSignal.reason).catch(() => void 0);
        closeOnce();
      };
      if (effectiveSignal.aborted) onAbort();
      else effectiveSignal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (closed) return;
        if (done) {
          controller.close();
          closeOnce();
        } else {
          controller.enqueue(value);
        }
      } catch (e) {
        if (!closed) controller.error(e);
        closeOnce();
      }
    },
    cancel(reason) {
      const cancellation = reader.cancel(reason);
      closeOnce();
      return cancellation;
    },
  });
  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * SSRF-geschuetzter Fetch mit strikt oeffentlichem Default. Interne Ziele
 * erfordern eine explizite `trusted-internal`- oder zweckgebundene n8n-Policy.
 */
export async function safeFetch(
  url: string,
  init?: RequestInit,
  policy: HttpTargetPolicy = { mode: 'public' },
): Promise<Response> {
  return await safeFetchResolved(url, init, await assertPublicHost(url, policy));
}
