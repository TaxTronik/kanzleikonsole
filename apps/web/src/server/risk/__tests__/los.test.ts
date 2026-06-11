import { describe, it, expect, vi, beforeEach } from 'vitest';

// @taxtronik/db (Barrel) verlangt DATABASE_URL beim Import + macht echte Tx →
// mocken. withTenantContext ruft die Callback mit einer Fake-Tx; evidenceService
// ist ein Spy. vi.hoisted, damit die Mock-Factory den State referenzieren darf.
const h = vi.hoisted(() => {
  const state = {
    rahmenRows: [{ id: 'a1' }, { id: 'b2' }, { id: 'c3' }] as { id: string }[],
    analysen: [
      { id: 'a1', clientId: 'cl-1', title: 'GmbH-Umwandlung' },
      { id: 'c3', clientId: null, title: null },
    ] as { id: string; clientId: string | null; title: string | null }[],
    pendingRow: null as { value: unknown } | null,
    auditRows: [] as { id: bigint; after: unknown }[],
    record: vi.fn(async (_tx: unknown, _event: unknown) =>
      ({ id: 77n, occurredAt: new Date(), prevHash: Buffer.alloc(0), thisHash: Buffer.alloc(0) })),
    reminderCreate: vi.fn(async (_args: unknown) => ({ id: 'rem-1' })),
    settingUpsert: vi.fn(async (_args: unknown) => ({})),
    settingDeleteMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
  };
  const tx = {
    riskAnalysis: {
      findMany: async (args: { where: { createdAt?: unknown; id?: { in: string[] } } }) =>
        args.where.id ? state.analysen.filter((a) => args.where.id!.in.includes(a.id)) : state.rahmenRows,
    },
    clientReminder: { create: state.reminderCreate },
    tenantSetting: {
      findUnique: async () => state.pendingRow,
      upsert: state.settingUpsert,
      deleteMany: state.settingDeleteMany,
    },
    auditLog: {
      findMany: async () => state.auditRows,
      findFirst: async (args: { where: { id: bigint } }) =>
        state.auditRows.find((r) => r.id === args.where.id) ?? null,
    },
  };
  return { state, tx };
});

vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(h.tx),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.state.record } }));
// Verhindert, dass der Paket-Import @taxtronik/config (ENV-Validierung) zieht —
// der echte Client wird hier injiziert; die Zod-Schemas sind Re-Implemente light.
vi.mock('@taxtronik/risk-layer', async () => {
  const { z } = await import('zod');
  const LosNachweisSchema = z
    .object({
      protokoll_version: z.number().int(),
      gezogen_am: z.string(),
      rahmen: z.object({ commitment: z.string(), n: z.number().int() }).catchall(z.unknown()),
      k: z.number().int(),
      stichprobe: z.array(z.string()),
      entropie: z.object({ quelle_klasse: z.string(), backend: z.string(), job_id: z.string().nullish(), roh_counts_sha256: z.string().nullish() }).catchall(z.unknown()),
      ableitung: z.object({ extraktor: z.string(), drbg: z.string() }).catchall(z.unknown()),
    })
    .catchall(z.unknown());
  return { RiskLayerClient: class {}, LosNachweisSchema };
});

import {
  zieheLosStichprobe,
  holeLosAb,
  pruefeLosNachweis,
  listLosZiehungen,
  LosRahmenLeerError,
  LosNachweisInkonsistentError,
} from '../los';
import type { TenantContext } from '@taxtronik/db';

const ctx = { tenantId: 't1', actorId: 's1', actorType: 'STAFF' } as TenantContext;
const zeitraum = { von: '2026-05-01', bis: '2026-05-31' };

const nachweis = {
  protokoll_version: 1,
  gezogen_am: '2026-06-10T08:00:00Z',
  rahmen: { commitment: 'c0ffee', n: 3 },
  k: 2,
  stichprobe: ['a1', 'c3'],
  entropie: { quelle_klasse: 'csprng', backend: 'csprng', roh_counts_sha256: 'ab'.repeat(32) },
  ableitung: { extraktor: 'sha256-vn', drbg: 'hmac-drbg-sha256' },
};

beforeEach(() => {
  h.state.rahmenRows = [{ id: 'a1' }, { id: 'b2' }, { id: 'c3' }];
  h.state.analysen = [
    { id: 'a1', clientId: 'cl-1', title: 'GmbH-Umwandlung' },
    { id: 'c3', clientId: null, title: null },
  ];
  h.state.pendingRow = null;
  h.state.auditRows = [];
  h.state.record.mockClear();
  h.state.reminderCreate.mockClear();
  h.state.settingUpsert.mockClear();
  h.state.settingDeleteMany.mockClear();
});

describe('zieheLosStichprobe', () => {
  it('fertig-Fall: Engine bekommt NUR IDs, Nachweis+Rahmen landen in der Chain, Review-Aufgabe je Mandanten-Treffer', async () => {
    const losZiehen = vi.fn(async () => ({ ok: true as const, status: 'fertig' as const, nachweis }));
    const r = await zieheLosStichprobe(ctx, { zeitraum, k: 2, backend: 'csprng' }, { losZiehen });

    // Engine-Call: deterministischer Rahmen (nur UUIDs), k, backend.
    expect(losZiehen).toHaveBeenCalledWith({ rahmen: ['a1', 'b2', 'c3'], k: 2, backend: 'csprng' });

    expect(r.status).toBe('fertig');
    if (r.status !== 'fertig') return;
    expect(r.ziehung.commitment).toBe('c0ffee');
    expect(r.ziehung.stichprobe).toEqual([
      { analysisId: 'a1', titel: 'GmbH-Umwandlung', clientId: 'cl-1', geloescht: false },
      { analysisId: 'c3', titel: null, clientId: null, geloescht: false },
    ]);
    // c3 ohne Mandantenbezug → Hinweis statt Aufgabe.
    expect(r.ziehung.hinweise).toHaveLength(1);

    // Genau EINE Review-Wiedervorlage (nur a1 hat clientId), dem Ziehenden zugewiesen.
    expect(h.state.reminderCreate).toHaveBeenCalledTimes(1);
    const remArgs = h.state.reminderCreate.mock.calls[0]![0] as unknown as { data: Record<string, unknown> };
    expect(remArgs.data).toMatchObject({
      clientId: 'cl-1',
      createdByStaff: 's1',
      assigneeStaffId: 's1',
      subject: 'Quantenlos-Review: GmbH-Umwandlung',
    });

    // Chain-Event trägt Nachweis UND Rahmen (Re-Verifikation braucht beide).
    expect(h.state.record).toHaveBeenCalledTimes(1);
    const ev = h.state.record.mock.calls[0]![1] as unknown as {
      action: string; resourceType: string; resourceId: string; after: Record<string, unknown>;
    };
    expect(ev.action).toBe('risk.los.gezogen');
    expect(ev.resourceType).toBe('quantenlos');
    expect(ev.resourceId).toBe('c0ffee');
    expect(ev.after).toMatchObject({ nachweis, rahmen: ['a1', 'b2', 'c3'], zeitraum, reviewAufgaben: ['rem-1'] });
  });

  it('wartet-Fall (QPU-Queue): persistiert den Pending-Job + auditiert die Beantragung, KEINE Aufgaben', async () => {
    const losZiehen = vi.fn(async () => ({
      ok: true as const, status: 'wartet' as const,
      job_id: 'ibm-job-42', backend: 'qpu', commitment: 'c0ffee', k: 2,
    }));
    const r = await zieheLosStichprobe(ctx, { zeitraum, k: 2, backend: 'qpu' }, { losZiehen });

    expect(r.status).toBe('wartet');
    if (r.status !== 'wartet') return;
    expect(r.pending).toMatchObject({ jobId: 'ibm-job-42', backend: 'qpu', commitment: 'c0ffee', k: 2, rahmen: ['a1', 'b2', 'c3'], zeitraum });

    expect(h.state.settingUpsert).toHaveBeenCalledTimes(1);
    const up = h.state.settingUpsert.mock.calls[0]![0] as unknown as {
      where: { tenantId_key: { key: string } }; create: { value: Record<string, unknown> };
    };
    expect(up.where.tenantId_key.key).toBe('quantenlos.pending');
    expect(up.create.value).toMatchObject({ jobId: 'ibm-job-42', rahmen: ['a1', 'b2', 'c3'] });

    expect(h.state.record).toHaveBeenCalledTimes(1);
    expect((h.state.record.mock.calls[0]![1] as unknown as { action: string }).action).toBe('risk.los.beantragt');
    expect(h.state.reminderCreate).not.toHaveBeenCalled();
  });

  it('leerer Rahmen → LosRahmenLeerError, kein Engine-Call', async () => {
    h.state.rahmenRows = [];
    const losZiehen = vi.fn();
    await expect(
      zieheLosStichprobe(ctx, { zeitraum, k: 1, backend: 'csprng' }, { losZiehen }),
    ).rejects.toBeInstanceOf(LosRahmenLeerError);
    expect(losZiehen).not.toHaveBeenCalled();
  });

  it('k > Rahmengröße → Fehler vor dem Engine-Call', async () => {
    const losZiehen = vi.fn();
    await expect(
      zieheLosStichprobe(ctx, { zeitraum, k: 99, backend: 'csprng' }, { losZiehen }),
    ).rejects.toThrow('zwischen 1 und 3');
    expect(losZiehen).not.toHaveBeenCalled();
  });

  it('Stichprobe außerhalb des Rahmens → LosNachweisInkonsistentError, NICHTS wird geschrieben', async () => {
    const kaputt = { ...nachweis, stichprobe: ['a1', 'FREMD'] };
    const losZiehen = vi.fn(async () => ({ ok: true as const, status: 'fertig' as const, nachweis: kaputt }));
    await expect(
      zieheLosStichprobe(ctx, { zeitraum, k: 2, backend: 'csprng' }, { losZiehen }),
    ).rejects.toBeInstanceOf(LosNachweisInkonsistentError);
    expect(h.state.record).not.toHaveBeenCalled();
    expect(h.state.reminderCreate).not.toHaveBeenCalled();
  });
});

describe('holeLosAb', () => {
  const pending = {
    jobId: 'ibm-job-42', backend: 'qpu', commitment: 'c0ffee', k: 2,
    rahmen: ['a1', 'b2', 'c3'], zeitraum, beantragtAm: '2026-06-10T07:00:00Z', beantragtVon: 's1',
  };

  it('ohne Pending-Job → Fehler', async () => {
    await expect(holeLosAb(ctx, { losAbholen: vi.fn() })).rejects.toThrow('Kein wartender Quantenlos-Job');
  });

  it('wartet weiter → Pending bleibt unverändert liegen', async () => {
    h.state.pendingRow = { value: pending };
    const losAbholen = vi.fn(async () => ({
      ok: true as const, status: 'wartet' as const,
      job_id: 'ibm-job-42', backend: 'qpu', commitment: 'c0ffee', k: 2,
    }));
    const r = await holeLosAb(ctx, { losAbholen });
    expect(losAbholen).toHaveBeenCalledWith({ jobId: 'ibm-job-42', rahmen: ['a1', 'b2', 'c3'], k: 2 });
    expect(r.status).toBe('wartet');
    expect(h.state.settingDeleteMany).not.toHaveBeenCalled();
    expect(h.state.record).not.toHaveBeenCalled();
  });

  it('fertig → finalisiert (Chain + Aufgaben) und räumt den Pending-Job weg', async () => {
    h.state.pendingRow = { value: pending };
    const qpuNachweis = {
      ...nachweis,
      entropie: { quelle_klasse: 'qpu', backend: 'ibm_torino', job_id: 'ibm-job-42', roh_counts_sha256: 'cd'.repeat(32) },
    };
    const losAbholen = vi.fn(async () => ({ ok: true as const, status: 'fertig' as const, nachweis: qpuNachweis }));
    const r = await holeLosAb(ctx, { losAbholen });

    expect(r.status).toBe('fertig');
    if (r.status !== 'fertig') return;
    expect(r.ziehung.jobId).toBe('ibm-job-42');
    expect(r.ziehung.quelleKlasse).toBe('qpu');
    expect(h.state.record).toHaveBeenCalledTimes(1);
    expect(h.state.settingDeleteMany).toHaveBeenCalledTimes(1);
    expect(h.state.reminderCreate).toHaveBeenCalledTimes(1);
  });
});

describe('pruefeLosNachweis / listLosZiehungen', () => {
  it('prüft Nachweis+Rahmen aus dem Audit-Event gegen die Engine', async () => {
    h.state.auditRows = [{ id: 77n, after: { nachweis, rahmen: ['a1', 'b2', 'c3'], zeitraum } }];
    const losPruefen = vi.fn(async () => ({
      ok: true as const, gueltig: true, geprueft: ['commitment'], hinweise: [],
    }));
    const r = await pruefeLosNachweis(ctx, '77', { online: true }, { losPruefen });
    expect(losPruefen).toHaveBeenCalledWith({ nachweis, rahmen: ['a1', 'b2', 'c3'], online: true });
    expect(r).toEqual({ gueltig: true, geprueft: ['commitment'], hinweise: [] });
  });

  it('unbekannte auditId → Fehler ohne Engine-Call', async () => {
    const losPruefen = vi.fn();
    await expect(pruefeLosNachweis(ctx, '99', {}, { losPruefen })).rejects.toThrow('Ziehung nicht gefunden');
    expect(losPruefen).not.toHaveBeenCalled();
  });

  it('listLosZiehungen mappt Audit-Events auf Anzeige-DTOs (inkl. gelöschter Analysen)', async () => {
    h.state.auditRows = [{ id: 77n, after: { nachweis, rahmen: ['a1', 'b2', 'c3'], zeitraum } }];
    h.state.analysen = [{ id: 'a1', clientId: 'cl-1', title: 'GmbH-Umwandlung' }]; // c3 gelöscht
    const list = await listLosZiehungen(ctx);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      auditId: '77',
      commitment: 'c0ffee',
      n: 3,
      k: 2,
      quelleKlasse: 'csprng',
      stichprobe: [
        { analysisId: 'a1', clientId: 'cl-1', geloescht: false },
        { analysisId: 'c3', clientId: null, geloescht: true },
      ],
    });
  });
});
