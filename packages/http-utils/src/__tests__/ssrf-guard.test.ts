// =============================================================================
// Unit-Tests: SSRF-Policy (@taxtronik/http-utils).
//
// Tabellen-Tests für die reinen IP-Klassifikationsfunktionen (isPrivateIPv4,
// isPrivateIPv6, v4MappedHexToDotted) plus die DNS-freien Pfade von
// `assertPublicHost` (Scheme-Check, Literal-IP-Sperre, Allowlist).
//
// Regression für den Bracket-Bug: URL.hostname liefert IPv6-Literale MIT
// Brackets (`[::1]`) — vor dem Fix erkannte isIP() sie nie, sodass die
// Literal-IP-Sperre für IPv6 nicht griff und der Dev-Allowlist-Eintrag
// `::1` tot war.
//
// KEINE DNS-/Netzwerk-Zugriffe: Hostname-basierte Lookups (z. B. `localhost`
// über die Allowlist) werden bewusst NICHT getestet — alle assertPublicHost-
// Fälle hier enden vor dem `lookup()` (Literal-IP wirft bzw. Allowlist-IP
// liefert die gepinnte Adresse direkt zurück).
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import {
  assertPublicHost,
  isManagedN8nTargetUrl,
  SsrfGuardError,
  isPrivateIPv4,
  isPrivateIPv6,
  v4MappedHexToDotted,
} from '../index';

// -----------------------------------------------------------------------------
// isPrivateIPv4 — Tabellen-Test über alle geblockten Ranges
// -----------------------------------------------------------------------------

describe('isPrivateIPv4', () => {
  const privateIps: Array<[string, string]> = [
    ['10.0.0.1', '10.0.0.0/8'],
    ['10.255.255.255', '10.0.0.0/8 (oberes Ende)'],
    ['127.0.0.1', '127.0.0.0/8 (loopback)'],
    ['127.8.8.8', '127.0.0.0/8 (nicht nur 127.0.0.1)'],
    ['169.254.169.254', '169.254.0.0/16 (link-local, AWS-IMDS)'],
    ['172.16.0.1', '172.16.0.0/12 (unteres Ende)'],
    ['172.31.255.255', '172.16.0.0/12 (oberes Ende)'],
    ['192.168.0.1', '192.168.0.0/16'],
    ['192.0.0.1', '192.0.0.0/24 (IETF-Protokollzuweisungen)'],
    ['192.0.2.1', '192.0.2.0/24 (TEST-NET-1)'],
    ['192.88.99.1', '192.88.99.0/24 (deprecated 6to4 relay)'],
    ['198.18.0.1', '198.18.0.0/15 (Benchmarking)'],
    ['198.19.255.255', '198.18.0.0/15 (oberes Ende)'],
    ['198.51.100.1', '198.51.100.0/24 (TEST-NET-2)'],
    ['203.0.113.1', '203.0.113.0/24 (TEST-NET-3)'],
    ['100.64.0.1', '100.64.0.0/10 (CGNAT, unteres Ende)'],
    ['100.127.255.255', '100.64.0.0/10 (CGNAT, oberes Ende)'],
    ['0.0.0.0', '0.0.0.0/8'],
    ['0.1.2.3', '0.0.0.0/8'],
    ['224.0.0.1', '224.0.0.0/4 (multicast)'],
    ['239.255.255.255', '224.0.0.0/4 (multicast, oberes Ende)'],
    ['240.0.0.1', '240.0.0.0/4 (reserved)'],
    ['255.255.255.255', 'broadcast'],
  ];
  it.each(privateIps)('%s ist privat/reserviert (%s)', (ip) => {
    expect(isPrivateIPv4(ip)).toBe(true);
  });

  const publicIps: Array<[string, string]> = [
    ['8.8.8.8', 'Google DNS'],
    ['1.1.1.1', 'Cloudflare DNS'],
    ['9.255.255.255', 'direkt unter 10/8'],
    ['11.0.0.1', 'direkt über 10/8'],
    ['172.15.255.255', 'direkt unter 172.16/12'],
    ['172.32.0.1', 'direkt über 172.16/12'],
    ['100.63.255.255', 'direkt unter CGNAT'],
    ['100.128.0.1', 'direkt über CGNAT'],
    ['192.167.255.255', 'direkt unter 192.168/16'],
    ['223.255.255.255', 'direkt unter Multicast'],
  ];
  it.each(publicIps)('%s ist öffentlich (%s)', (ip) => {
    expect(isPrivateIPv4(ip)).toBe(false);
  });

  it.each([['999.0.0.1'], ['1.2.3'], ['1.2.3.4.5'], ['abc'], ['']])(
    'nicht parsebare Form %j → FAIL-CLOSED (true)',
    (ip) => {
      expect(isPrivateIPv4(ip)).toBe(true);
    },
  );
});

// -----------------------------------------------------------------------------
// isPrivateIPv6 — Tabellen-Test inkl. v4-mapped in beiden Formen
// -----------------------------------------------------------------------------

describe('isPrivateIPv6', () => {
  const privateIps: Array<[string, string]> = [
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'fc00::/7 (ULA)'],
    ['fd12:3456::1', 'fc00::/7 (ULA, fd)'],
    ['FD12:3456::1', 'fc00::/7 — Großschreibung wird normalisiert'],
    ['fe80::1', 'fe80::/10 (link-local)'],
    ['fe9f::1', 'fe80::/10 (fe9)'],
    ['fea0::1', 'fe80::/10 (fea)'],
    ['febf::ffff', 'fe80::/10 (oberes Ende)'],
    ['fec0::1', 'fec0::/10 (deprecated site-local)'],
    ['fee0::1', 'fec0::/10 (fee)'],
    ['64:ff9b::808:808', 'NAT64 64:ff9b::/96'],
    ['64:ff9b:1::808:808', 'lokales NAT64 64:ff9b:1::/48'],
    ['2002:808:808::', '6to4 2002::/16'],
    // N-9: neu ergänzte IANA-Special-Purpose-Bereiche
    ['ff02::1', 'Multicast ff00::/8 (link-local all-nodes)'],
    ['ff05::1:3', 'Multicast ff00::/8 (site-local)'],
    ['ff00::', 'Multicast ff00::/8 (unteres Ende)'],
    ['2001:0:1234::', 'Teredo 2001:0000::/32'],
    ['2001::abcd', 'Teredo 2001:0000::/32 (Kurzform group2=0)'],
    ['2001:db8::1', 'Dokumentation 2001:db8::/32'],
    ['2001:2::1', 'Benchmarking 2001:2::/48'],
    ['2001:2:0:1::', 'Benchmarking 2001:2::/48'],
    ['2001:20::1', 'ORCHIDv2 2001:20::/28'],
    ['2001:2f::1', 'ORCHIDv2 2001:20::/28 (oberes Ende der group2-Nibble)'],
    ['2001:1ff::1', 'IETF-Protocol 2001::/23 (oberes group2=01ff)'],
    ['100::1', 'Discard-Only 100::/64'],
    ['100:0:0:0::1', 'Discard-Only 100::/64 (ausgeschrieben)'],
    ['::ffff:10.0.0.1', 'v4-mapped dotted, 10/8'],
    ['::ffff:192.168.1.1', 'v4-mapped dotted, 192.168/16'],
    ['::ffff:127.0.0.1', 'v4-mapped dotted, loopback'],
    ['::ffff:7f00:1', 'v4-mapped HEX, loopback (F4)'],
    ['::ffff:a00:1', 'v4-mapped HEX, 10.0.0.1'],
    ['::ffff:c0a8:101', 'v4-mapped HEX, 192.168.1.1'],
    ['::ffff:a9fe:a9fe', 'v4-mapped HEX, 169.254.169.254 (IMDS)'],
  ];
  it.each(privateIps)('%s ist privat/reserviert (%s)', (ip) => {
    expect(isPrivateIPv6(ip)).toBe(true);
  });

  const publicIps: Array<[string, string]> = [
    ['2001:4860:4860::8888', 'Google DNS'],
    ['2606:4700:4700::1111', 'Cloudflare DNS'],
    ['fe00::1', 'unterhalb fe80::/10'],
    ['::ffff:8.8.8.8', 'v4-mapped dotted, öffentlich'],
    ['::ffff:808:808', 'v4-mapped HEX, 8.8.8.8 (öffentlich)'],
    // N-9: direkt oberhalb der neuen Sperr-Bereiche — dürfen NICHT geblockt werden
    ['2001:200::1', 'öffentlich, group2=0200 > 01ff (direkt über 2001::/23)'],
    ['2001:4860::1', 'öffentlich (Google), group2=4860'],
    ['2001:dc8::1', 'öffentlich, group2=0dc8 ≠ 0db8 (neben Doku-Bereich)'],
    ['1000::1', 'öffentlich, kein Discard-Only 100::/64'],
    ['1002:808:808::', 'öffentlich, group1=1002 ≠ 6to4'],
  ];
  it.each(publicIps)('%s ist öffentlich (%s)', (ip) => {
    expect(isPrivateIPv6(ip)).toBe(false);
  });

  it.each([['::ffff:garbage'], ['::ffff:1:2:3'], ['::ffff:zzzz:1']])(
    'nicht parsebare v4-mapped-Form %j → FAIL-CLOSED (true)',
    (ip) => {
      expect(isPrivateIPv6(ip)).toBe(true);
    },
  );
});

// -----------------------------------------------------------------------------
// v4MappedHexToDotted — F4-Konvertierung bleibt erreichbar und korrekt
// -----------------------------------------------------------------------------

describe('v4MappedHexToDotted', () => {
  it.each([
    ['7f00:1', '127.0.0.1'],
    ['a00:1', '10.0.0.1'],
    ['c0a8:101', '192.168.1.1'],
    ['808:808', '8.8.8.8'],
    ['ffff:ffff', '255.255.255.255'],
  ])('%s → %s', (rest, dotted) => {
    expect(v4MappedHexToDotted(rest)).toBe(dotted);
  });

  it.each([['garbage'], ['1:2:3'], ['zzzz:1'], ['12345:1'], ['']])(
    'unpassende Form %j → null',
    (rest) => {
      expect(v4MappedHexToDotted(rest)).toBeNull();
    },
  );
});

// -----------------------------------------------------------------------------
// assertPublicHost — DNS-freie Pfade (Scheme, Literal-IP, Allowlist)
// -----------------------------------------------------------------------------

describe('assertPublicHost', () => {
  const ORIG_NODE_ENV = process.env['NODE_ENV'];
  const ORIG_HOSTS = process.env['INTERNAL_FETCH_HOSTS'];

  afterEach(() => {
    if (ORIG_NODE_ENV === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = ORIG_NODE_ENV;
    if (ORIG_HOSTS === undefined) delete process.env['INTERNAL_FETCH_HOSTS'];
    else process.env['INTERNAL_FETCH_HOSTS'] = ORIG_HOSTS;
  });

  function setProd(internalHosts = '') {
    process.env['NODE_ENV'] = 'production';
    process.env['INTERNAL_FETCH_HOSTS'] = internalHosts;
  }

  it('ungültige URL → invalid-url', async () => {
    await expect(assertPublicHost('not a url')).rejects.toMatchObject({
      name: 'SsrfGuardError',
      reason: 'invalid-url',
    });
  });

  it.each([['ftp://example.com/x'], ['file:///etc/passwd'], ['gopher://example.com/']])(
    'verbotenes Schema %s → forbidden-scheme',
    async (url) => {
      await expect(assertPublicHost(url)).rejects.toMatchObject({
        name: 'SsrfGuardError',
        reason: 'forbidden-scheme',
      });
    },
  );

  it('IPv4-Literal (privat) → literal-ip in production', async () => {
    setProd();
    await expect(assertPublicHost('http://10.0.0.1/x')).rejects.toMatchObject({
      name: 'SsrfGuardError',
      reason: 'literal-ip',
    });
  });

  it('IPv4-Literal (öffentlich) → literal-ip (Policy blockt ALLE Literale)', async () => {
    setProd();
    await expect(assertPublicHost('https://8.8.8.8/x')).rejects.toMatchObject({
      reason: 'literal-ip',
    });
  });

  // Regression Bracket-Bug: vor dem Fix lieferte URL.hostname `[::1]` MIT
  // Brackets, isIP('[::1]') === 0 → die Literal-IP-Sperre griff für IPv6 nie.
  it('IPv6-Literal-URL [::1] → literal-ip in production (Regression Bracket-Bug)', async () => {
    setProd();
    await expect(assertPublicHost('http://[::1]:3000/x')).rejects.toMatchObject({
      name: 'SsrfGuardError',
      reason: 'literal-ip',
    });
  });

  it('öffentliches IPv6-Literal [2001:db8::1] → literal-ip (Regression Bracket-Bug)', async () => {
    setProd();
    await expect(assertPublicHost('http://[2001:db8::1]/x')).rejects.toMatchObject({
      reason: 'literal-ip',
    });
  });

  it('v4-mapped IPv6-Literal [::ffff:10.0.0.1] → literal-ip', async () => {
    setProd();
    await expect(assertPublicHost('http://[::ffff:10.0.0.1]/x')).rejects.toMatchObject({
      reason: 'literal-ip',
    });
  });

  it('Explizite trusted-internal-Policy erlaubt Dev-IPv6-Loopback', async () => {
    process.env['NODE_ENV'] = 'test'; // !== 'production' → Dev-Defaults aktiv
    process.env['INTERNAL_FETCH_HOSTS'] = '';
    const addrs = await assertPublicHost('http://[::1]:3000/api', {
      mode: 'trusted-internal',
    });
    expect(addrs).toEqual([{ address: '::1', family: 6 }]);
  });

  it('Explizite trusted-internal-Policy erlaubt Dev-IPv4-Loopback', async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['INTERNAL_FETCH_HOSTS'] = '';
    const addrs = await assertPublicHost('http://127.0.0.1:3000/', {
      mode: 'trusted-internal',
    });
    expect(addrs).toEqual([{ address: '127.0.0.1', family: 4 }]);
  });

  it('Dev-Allowlist gilt NICHT in production: 127.0.0.1 → literal-ip', async () => {
    setProd();
    await expect(assertPublicHost('http://127.0.0.1:3000/')).rejects.toMatchObject({
      reason: 'literal-ip',
    });
  });

  it('Explizite trusted-internal-Policy erlaubt einen INTERNAL_FETCH_HOSTS-Eintrag', async () => {
    setProd('10.1.2.3');
    const addrs = await assertPublicHost('http://10.1.2.3:8333/bucket', {
      mode: 'trusted-internal',
    });
    expect(addrs).toEqual([{ address: '10.1.2.3', family: 4 }]);
  });

  it.each([
    'http://10.1.2.3:8333/buckets/general',
    'http://10.1.2.3:5678/webhook/workflow',
    'https://10.1.2.3:9443/api/v1',
  ])('strikte Tenant-Policy ignoriert die Infrastruktur-Allowlist fuer %s', async (url) => {
    setProd('10.1.2.3');
    await expect(assertPublicHost(url, { mode: 'public' })).rejects.toMatchObject({
      reason: 'literal-ip',
    });
  });

  it('strikte Tenant-Policy ignoriert auch Dev-Loopback-Ausnahmen', async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['INTERNAL_FETCH_HOSTS'] = '127.0.0.1';
    await expect(
      assertPublicHost('http://127.0.0.1:5678/webhook', { mode: 'public' }),
    ).rejects.toMatchObject({ reason: 'literal-ip' });
  });

  it.each([
    ['http://n8n:5678/api/v1', 'api'],
    ['http://n8n:5678/api/v1/workflows?limit=250', 'api'],
    ['http://n8n:5678/webhook/workflow-id', 'webhook'],
    ['http://n8n:5678/webhook-test/workflow-id', 'webhook-test'],
    ['http://n8n:5678/healthz', 'health'],
  ] as const)('erlaubt den engen verwalteten n8n-Vertrag: %s (%s)', (url, kind) => {
    expect(isManagedN8nTargetUrl(url, kind)).toBe(true);
  });

  it.each([
    ['http://seaweedfs:5678/webhook/x', 'webhook'],
    ['http://n8n:8888/webhook/x', 'webhook'],
    ['https://n8n:5678/webhook/x', 'webhook'],
    ['http://n8n:5678/cluster/status', 'webhook'],
    ['http://n8n:5678/webhook-test/x', 'webhook'],
    ['http://n8n:5678/api/v10/workflows', 'api'],
    ['http://user:pass@n8n:5678/api/v1', 'api'],
    ['http://n8n:5678/healthz/ready', 'health'],
    ['http://seaweedfs:8333/healthz', 'health'],
    ['http://n8n:5678/webhook%2f..%2fapi/v1/workflows', 'webhook'],
    ['http://n8n:5678/webhook/%252e%252e/api/v1/workflows', 'webhook'],
    ['http://n8n:5678/webhook%5c..%5capi/v1/workflows', 'webhook'],
  ] as const)('blockiert Host-/Port-/Pfad-Ausweitung: %s (%s)', (url, kind) => {
    expect(isManagedN8nTargetUrl(url, kind)).toBe(false);
  });

  it('n8n-Policy uebernimmt keine andere private IP aus INTERNAL_FETCH_HOSTS', async () => {
    setProd('10.1.2.3,seaweedfs,clamav,postgres,redis');
    await expect(
      assertPublicHost('http://10.1.2.3:5678/webhook/workflow', {
        mode: 'n8n',
        kind: 'webhook',
      }),
    ).rejects.toMatchObject({ reason: 'literal-ip' });
  });

  it('n8n-Policy erlaubt Klartext-HTTP nur für den exakt verwalteten Compose-Service', async () => {
    await expect(
      assertPublicHost('http://n8n.example.test/webhook/workflow', {
        mode: 'n8n',
        kind: 'webhook',
      }),
    ).rejects.toMatchObject({ reason: 'forbidden-scheme' });
  });

  it('INTERNAL_FETCH_HOSTS akzeptiert IPv6 in Bracket-Form ([::1]) wie in URL-Schreibweise', async () => {
    setProd('[::1]');
    const addrs = await assertPublicHost('http://[::1]:5678/webhook', {
      mode: 'trusted-internal',
    });
    expect(addrs).toEqual([{ address: '::1', family: 6 }]);
  });

  it('INTERNAL_FETCH_HOSTS akzeptiert IPv6 in nackter Form (::1)', async () => {
    setProd('::1');
    const addrs = await assertPublicHost('http://[::1]:5678/webhook', {
      mode: 'trusted-internal',
    });
    expect(addrs).toEqual([{ address: '::1', family: 6 }]);
  });

  it('SsrfGuardError ist per instanceof unterscheidbar (N2)', async () => {
    setProd();
    try {
      await assertPublicHost('http://10.0.0.1/');
      expect.unreachable('assertPublicHost hätte werfen müssen');
    } catch (e) {
      expect(e).toBeInstanceOf(SsrfGuardError);
    }
  });
});
