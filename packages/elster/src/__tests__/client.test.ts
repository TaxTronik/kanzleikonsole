import { describe, expect, it, vi } from 'vitest';
import { ElsterBridgeClient, ElsterBridgeHttpError, ElsterKontoabfrageInputError } from '../client';
import { ElsterNotConfiguredError, isElsterConfigured } from '../config';
import type { KontoabfrageTeil } from '../schema';

const CONFIG = { url: 'http://eric-bridge:8085', token: 'test-token-1234567890' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('config gating', () => {
  it('ist ohne ELSTER_BRIDGE_* nicht konfiguriert (Modul unsichtbar)', () => {
    expect(isElsterConfigured()).toBe(false);
  });

  it('wirft ElsterNotConfiguredError ohne injizierte Config', () => {
    expect(() => new ElsterBridgeClient()).toThrow(ElsterNotConfiguredError);
  });
});

describe('health', () => {
  it('parst den Bridge-Zustand und ruft /healthz ohne Bearer auf', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        eric: 'geladen',
        cert: 'konfiguriert',
        herstellerId: 'konfiguriert',
      }),
    );
    const client = new ElsterBridgeClient({ config: CONFIG, fetchImpl });

    const health = await client.health();

    expect(health.ok).toBe(true);
    expect(health.herstellerId).toBe('konfiguriert');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://eric-bridge:8085/healthz');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });
});

describe('validate', () => {
  it('sendet xml + datenartVersion mit Bearer-Token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ ok: true, returnCode: 0, result: '<ok/>', errorText: null }),
      );
    const client = new ElsterBridgeClient({ config: CONFIG, fetchImpl });

    const r = await client.validate({ xml: '<x/>', datenartVersion: 'UStVA_2026' });

    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://eric-bridge:8085/v1/validate');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${CONFIG.token}`);
    expect(JSON.parse(init.body as string)).toEqual({ xml: '<x/>', datenartVersion: 'UStVA_2026' });
  });

  it('übersetzt non-2xx in ElsterBridgeHttpError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));
    const client = new ElsterBridgeClient({ config: CONFIG, fetchImpl });

    await expect(client.validate({ xml: '<x/>', datenartVersion: 'UStVA_2026' })).rejects.toThrow(
      ElsterBridgeHttpError,
    );
  });
});

describe('kontoabfrage', () => {
  const abfragen: KontoabfrageTeil[] = [
    { art: 'ZS', steuernummer: '2657086132381', steuerart: 'USt', zeitraum: '2026' },
  ];

  it('flacht die Übertragungsentscheidung in den Body (testmerker)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        returnCode: 0,
        result: '<antwort/>',
        serverantwort: '<srv/>',
        errorText: null,
        nutzdatenTicket: 'abc123',
      }),
    );
    const client = new ElsterBridgeClient({ config: CONFIG, fetchImpl });

    const r = await client.kontoabfrage({
      abfragen,
      datenLieferant: 'Kanzlei Test',
      pin: '123456',
      uebertragung: { testmerker: '230000001' },
    });

    expect(r.nutzdatenTicket).toBe('abc123');
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.testmerker).toBe('230000001');
    expect(body.echtfall).toBeUndefined();
    expect(body.pin).toBe('123456');
  });

  it('flacht die Übertragungsentscheidung in den Body (echtfall)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        returnCode: 0,
        result: null,
        serverantwort: null,
        errorText: null,
        nutzdatenTicket: 't',
      }),
    );
    const client = new ElsterBridgeClient({ config: CONFIG, fetchImpl });

    await client.kontoabfrage({
      abfragen,
      datenLieferant: 'Kanzlei Test',
      pin: '123456',
      uebertragung: { echtfall: true },
    });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.echtfall).toBe(true);
    expect(body.testmerker).toBeUndefined();
  });

  it('wirft lokal (ohne Bridge-Call) bei 0 Teil-Abfragen', async () => {
    const fetchImpl = vi.fn();
    const client = new ElsterBridgeClient({ config: CONFIG, fetchImpl });

    await expect(
      client.kontoabfrage({
        abfragen: [],
        datenLieferant: 'Kanzlei Test',
        pin: '123456',
        uebertragung: { testmerker: '230000001' },
      }),
    ).rejects.toThrow(ElsterKontoabfrageInputError);
    // Kein kostenpflichtiger Vorgang: die Bridge wurde nie kontaktiert.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('wirft lokal (ohne Bridge-Call) bei 76 Teil-Abfragen', async () => {
    const fetchImpl = vi.fn();
    const client = new ElsterBridgeClient({ config: CONFIG, fetchImpl });
    const many: KontoabfrageTeil[] = Array.from({ length: 76 }, () => ({
      art: 'O',
      steuernummer: '2657086132381',
    }));

    await expect(
      client.kontoabfrage({
        abfragen: many,
        datenLieferant: 'Kanzlei Test',
        pin: '123456',
        uebertragung: { testmerker: '230000001' },
      }),
    ).rejects.toThrow(ElsterKontoabfrageInputError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reicht TH-Phasen-Fehler typisiert durch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: false,
        phase: 'transferheader',
        returnCode: 610001002,
        result: null,
        serverantwort: null,
        errorText: 'Prüfung fehlgeschlagen',
        nutzdatenTicket: 't',
      }),
    );
    const client = new ElsterBridgeClient({ config: CONFIG, fetchImpl });

    const r = await client.kontoabfrage({
      abfragen,
      datenLieferant: 'Kanzlei Test',
      pin: '123456',
      uebertragung: { testmerker: '230000001' },
    });

    expect(r.ok).toBe(false);
    expect(r.phase).toBe('transferheader');
  });
});

describe('ElsterBridgeHttpError (kein Body-Leak in der Message)', () => {
  it('übernimmt KEINEN rohen Body-Ausschnitt in die Fehler-Message', async () => {
    const secret = 'Steuernummer 2657086132381 Betrag 12345,67 EUR';
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(secret, { status: 500, headers: { 'content-type': 'text/plain' } }),
      );
    const client = new ElsterBridgeClient({ config: CONFIG, fetchImpl });

    const err = (await client
      .validate({ xml: '<x/>', datenartVersion: 'UStVA_2026' })
      .then(() => null)
      .catch((e) => e)) as ElsterBridgeHttpError;

    expect(err).toBeInstanceOf(ElsterBridgeHttpError);
    expect(err.message).not.toContain(secret);
    expect(err.message).not.toContain('2657086132381');
    expect(err.message).toContain('500');
    // Der vollständige Body bleibt separat (für gezieltes, nicht-standardmäßiges Logging).
    expect(err.body).toBe(secret);
  });

  it('übernimmt nur ein strukturiertes Fehlerfeld, nicht die Nutzdaten', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: 'unauthorized', returnCode: 610001002, steuernummer: '2657086132381' },
          401,
        ),
      );
    const client = new ElsterBridgeClient({ config: CONFIG, fetchImpl });

    const err = (await client
      .validate({ xml: '<x/>', datenartVersion: 'UStVA_2026' })
      .then(() => null)
      .catch((e) => e)) as ElsterBridgeHttpError;

    expect(err.message).toContain('unauthorized');
    expect(err.message).toContain('610001002');
    expect(err.message).not.toContain('2657086132381');
  });
});
