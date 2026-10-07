// =============================================================================
// Unit-Tests: gwg-expiry-check-Worker (dreistufige Eskalation + ID-Dokumente).
//
// bullmq via mocks/bullmq.ts, Prisma/Notify/Tenant-Context/Evidence per
// vi.mock. Abgedeckt:
//   - Stufenlogik an den Tagesgrenzen (90/30/0, gemessen an validUntil)
//   - Empfänger pro Stufe inkl. ADMIN/PARTNER-Fallback
//   - RF-8: STAGE3-Statuswechsel (Check EXPIRED + Mandant deaktiviert) und
//     die zugehörigen Audit-Records laufen in EINER Tenant-Context-Tx
//   - GwG-Schranke: bei STAGE3-Deaktivierung werden Portal-Sessions aller
//     aktiven Kontakte revoziert (revoke:portal:<contactId> via Redis) — R-02:
//     derselbe monotone, fail-closed Kern wie die Web-App (@taxtronik/crypto)
//   - Idempotenz: bereits umgestellte Checks erzeugen keinen Audit-Eintrag
//     und keine erneute Session-Revocation
//   - B7: Die Deaktivierung setzt in ihrer Transaktion einen Widerrufsmarker;
//     erst ein bestätigter Widerruf löscht ihn. Nach einem Fehlschlag holt die
//     Wiederholung den Widerruf vor allen anderen Schritten nach (SQL der
//     Marker: packages/db/src/__tests__/portal-session-revocation-pending.test.ts)
//   - U-5: Auto-Anforderung für ablaufende Ausweise idempotent per FK
//     (linkedGwgIdDocumentId), HIGH/7-Tage-Frist wenn bereits abgelaufen
//   - GwG-Lösch-Queue (§ 8 Abs. 4 S. 4): GWG_DELETION_DUE an ADMIN/PARTNER,
//     sobald löschreife Belege/Aufzeichnungen existieren (resource_id = Tenant);
//     R-02/K-01: Filter aus @taxtronik/gwg, identisch zur Web-Review-Queue
//   - F-10: Zuständige nur, solange aktiv und zugriffsberechtigt; sonst
//     aktive ADMIN/PARTNER (gemeinsamer Empfängerfilter)
// Fachkatalog: GWG-REVERIFICATION-VALIDITY-001, ACCESS-NOTIFICATION-RECIPIENT-001,
// GWG-RETENTION-DESTRUCTION-001, ACCESS-TENANT-RLS-001
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  // S-01: Beim Owner-Client bleiben nur die Tenant-Liste und die Belegzählung der
  // Lösch-Queue; alles andere läuft über die App-Rolle (withSystemContext).
  const prismaOwner = {
    tenant: { findMany: vi.fn() },
    document: { count: vi.fn() },
  };
  // Admin/Partner-Liste des Jobs und Fallback-Empfänger (notification-recipients.ts,
  // nach id sortiert) laufen beide als staffUser.findMany in Tenant-Transaktionen.
  const adminPartners = vi.fn();
  const recipientStaff = vi.fn();
  const tx = {
    gwgCheck: { findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
    gwgIdDocument: { findMany: vi.fn() },
    request: { findMany: vi.fn(), createMany: vi.fn() },
    clientContact: { findMany: vi.fn() },
    client: { findUnique: vi.fn(), updateMany: vi.fn() },
    staffUser: {
      findMany: (args: { orderBy?: unknown }) =>
        args.orderBy ? recipientStaff(args) : adminPartners(args),
    },
  };
  // F-10: Mitarbeiter, die deaktiviert sind oder den Mandanten nicht sehen dürfen.
  const withoutAccess = new Set<string>();
  const filterStaffAccessClientTx = vi.fn(
    async (_tx: unknown, _tenantId: string, ids: readonly string[], _clientId: string) =>
      new Set(ids.filter((id) => !withoutAccess.has(id))),
  );
  const withSystemContext = vi.fn(async (_tenantId: string, fn: (t: unknown) => Promise<unknown>) =>
    fn(tx),
  );
  const record = vi.fn();
  const notify = vi.fn();
  const resolveNotificationsTx = vi.fn();
  // Portal-Session-Revocation: der Worker schreibt `revoke:portal:<contactId>`
  // über die BullMQ-Redis-Verbindung mit dem gemeinsamen Lua-Skript
  // (advanceSessionRevocation aus @taxtronik/crypto, R-02).
  const redisEval = vi.fn();
  // B7: Widerrufsmarker am Mandanten (@taxtronik/db/portal-session-revocation).
  const markPending = vi.fn();
  const listPending = vi.fn();
  const clearPending = vi.fn();
  return {
    prismaOwner,
    tx,
    withoutAccess,
    filterStaffAccessClientTx,
    withSystemContext,
    adminPartners,
    recipientStaff,
    record,
    notify,
    resolveNotificationsTx,
    redisEval,
    markPending,
    listPending,
    clearPending,
  };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: { eval: h.redisEval, get: vi.fn() } }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/db', () => ({ withSystemContext: h.withSystemContext }));
vi.mock('../../notify', () => ({ notify: h.notify }));
vi.mock('@taxtronik/db/notification', () => ({
  resolveNotificationsTx: h.resolveNotificationsTx,
}));
vi.mock('@taxtronik/db/portal-session-revocation', () => ({
  markPortalSessionRevocationPendingTx: h.markPending,
  listPendingPortalSessionRevocations: h.listPending,
  clearPortalSessionRevocationPendingTx: h.clearPending,
}));
vi.mock('@taxtronik/db/staff-client-access', () => ({
  filterStaffAccessClientTx: h.filterStaffAccessClientTx,
}));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {
    record = h.record;
  },
  LocalTimestampAdapter: class {},
}));

import { dueGwgCheckDeletionsWhere, dueGwgDeletionDocsWhere } from '@taxtronik/gwg/retention';
import { processors } from './mocks/bullmq';
import '../gwg-expiry-check';

const FIXED_NOW = new Date('2026-06-09T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const TENANT = 'tenant-1';

interface GwgResult {
  stage1: number;
  stage2: number;
  stage3: number;
  idDocReminders: number;
  idDocRequests: number;
  deletionDueNotices: number;
}

function run(data: { tenantId?: string } = { tenantId: TENANT }): Promise<GwgResult> {
  return processors.get('gwg-expiry-check')!({ data }) as Promise<GwgResult>;
}

interface PendingRevocation {
  tenantId: string;
  clientId: string;
  pendingAt: Date;
}

/**
 * B7: Marker wie in PostgreSQL — Setzen überschreibt, Löschen nur bei
 * unverändertem Wert (Compare-and-Set). Das SQL selbst prüft
 * portal-session-revocation-pending.test.ts gegen die Datenbank.
 */
function useMarkerStore(): Map<string, PendingRevocation> {
  const markers = new Map<string, PendingRevocation>();
  h.markPending.mockImplementation(
    async (_tx: unknown, input: { tenantId: string; clientId: string }) => {
      const pending = { ...input, pendingAt: new Date() };
      markers.set(input.clientId, pending);
      return pending;
    },
  );
  h.listPending.mockImplementation(async (_db: unknown, tenantId?: string) =>
    [...markers.values()].filter((pending) => !tenantId || pending.tenantId === tenantId),
  );
  h.clearPending.mockImplementation(async (_tx: unknown, pending: PendingRevocation) => {
    const current = markers.get(pending.clientId);
    if (current?.pendingAt.getTime() !== pending.pendingAt.getTime()) return false;
    markers.delete(pending.clientId);
    return true;
  });
  return markers;
}

/**
 * R-11: Der Job schreibt über notify(tx, input[]). Für die Assertions je
 * Empfänger ein Eintrag im früheren Format (tenantId, staffId, Daten).
 */
function upsertCalls(): Array<readonly [string, string, Record<string, unknown>]> {
  return h.notify.mock.calls.flatMap(([tx, input]) => {
    expect(tx).toBe(h.tx);
    return [input as Record<string, unknown>].flat().flatMap((entry) => {
      const { tenantId, staffId, ...data } = entry as Record<string, unknown>;
      return [[tenantId as string, staffId as string, data] as const];
    });
  });
}

function gwgCheck(validUntil: Date, overrides: Record<string, unknown> = {}) {
  return {
    id: 'gwg-1',
    clientId: 'client-1',
    status: 'VERIFIED',
    riskLevel: 'NIEDRIG',
    validUntil,
    client: {
      id: 'client-1',
      name: 'Muster GmbH',
      responsibilities: [
        { staffId: 'hb-1', role: 'HAUPTBEARBEITER' },
        { staffId: 'bt-1', role: 'BERUFSTRAEGER' },
      ],
    },
    ...overrides,
  };
}

function idDoc(expiryDate: Date, overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    type: 'PERSONALAUSWEIS',
    ownerName: 'Max Muster',
    expiryDate,
    check: {
      clientId: 'client-1',
      client: {
        name: 'Muster GmbH',
        allowActive: true,
        responsibilities: [{ staffId: 'hb-1' }],
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  vi.resetAllMocks();
  h.withSystemContext.mockImplementation(
    async (_tenantId: string, fn: (t: unknown) => Promise<unknown>) => fn(h.tx),
  );
  h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: TENANT }]);
  h.adminPartners.mockResolvedValue([{ id: 'admin-1' }]);
  h.recipientStaff.mockResolvedValue([{ id: 'admin-1' }]);
  h.withoutAccess.clear();
  h.filterStaffAccessClientTx.mockImplementation(
    async (_tx: unknown, _tenantId: string, ids: readonly string[]) =>
      new Set(ids.filter((id) => !h.withoutAccess.has(id))),
  );
  h.tx.gwgCheck.findMany.mockResolvedValue([]);
  h.tx.gwgCheck.count.mockResolvedValue(0);
  h.tx.gwgIdDocument.findMany.mockResolvedValue([]);
  h.prismaOwner.document.count.mockResolvedValue(0);
  h.tx.request.findMany.mockResolvedValue([]);
  h.tx.request.createMany.mockResolvedValue({ count: 1 });
  h.tx.clientContact.findMany.mockResolvedValue([{ id: 'contact-1' }]);
  h.tx.gwgCheck.updateMany.mockResolvedValue({ count: 1 });
  // Default: kein neuerer gültiger Check → Alt-Verhalten (Mandant wird deaktiviert).
  h.tx.gwgCheck.findFirst.mockResolvedValue(null);
  h.tx.client.findUnique
    .mockResolvedValueOnce({ allowActive: true })
    .mockResolvedValue({ allowActive: false });
  // Realer Pfad mit Migration 034: Das Check-UPDATE deaktiviert bereits über
  // den AFTER-Trigger; das explizite updateMany trifft deshalb keine Zeile.
  h.tx.client.updateMany.mockResolvedValue({ count: 0 });
  h.record.mockResolvedValue({});
  h.notify.mockImplementation(async (_tx: unknown, input: unknown) => ({
    created: [input].flat().length,
    updated: 0,
  }));
  h.redisEval.mockResolvedValue('OK');
  h.listPending.mockResolvedValue([]);
  h.markPending.mockImplementation(
    async (_tx: unknown, input: { tenantId: string; clientId: string }) => ({
      ...input,
      pendingAt: FIXED_NOW,
    }),
  );
  h.clearPending.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Stufenlogik an den Tagesgrenzen', () => {
  it('RF-14: lädt nur VERIFIED-Checks im 90-Tage-Relevanz-Fenster', async () => {
    await run();

    expect(h.tx.gwgCheck.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: TENANT,
          status: 'VERIFIED',
          validUntil: { not: null, lte: new Date(FIXED_NOW.getTime() + 90 * DAY) },
        },
      }),
    );
  });

  it('91 Tage Rest → keine Eskalation', async () => {
    h.tx.gwgCheck.findMany.mockResolvedValue([gwgCheck(new Date(FIXED_NOW.getTime() + 91 * DAY))]);

    const result = await run();

    expect(upsertCalls()).toEqual([]);
    // S-01: Lesen (Admin/Partner und Kandidaten), Lesen der Ausweise, Lösch-Queue.
    expect(h.withSystemContext).toHaveBeenCalledTimes(3);
    expect(h.resolveNotificationsTx).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        tenantId: TENANT,
        kinds: ['GWG_DELETION_DUE'],
      }),
    );
    expect(result).toMatchObject({ stage1: 0, stage2: 0, stage3: 0 });
  });

  it('STAGE1 (90 Tage): nur der Hauptbearbeiter wird informiert', async () => {
    h.tx.gwgCheck.findMany.mockResolvedValue([gwgCheck(new Date(FIXED_NOW.getTime() + 90 * DAY))]);

    const result = await run();

    expect(upsertCalls()).toHaveLength(1);
    expect(upsertCalls()).toContainEqual([
      TENANT,
      'hb-1',
      expect.objectContaining({ kind: 'GWG_EXPIRY_90D', resourceId: 'gwg-1' }),
    ]);
    expect(result.stage1).toBe(1);
  });

  it('STAGE2 (30 Tage): Hauptbearbeiter + Berufsträger', async () => {
    h.tx.gwgCheck.findMany.mockResolvedValue([gwgCheck(new Date(FIXED_NOW.getTime() + 30 * DAY))]);

    const result = await run();

    const recipients = upsertCalls().map((c) => c[1]);
    expect(recipients.sort()).toEqual(['bt-1', 'hb-1']);
    for (const call of upsertCalls()) {
      expect((call[2] as { kind: string }).kind).toBe('GWG_EXPIRY_30D');
    }
    expect(result.stage2).toBe(2);
  });

  it('STAGE1 ohne Verantwortliche → ADMIN/PARTNER-Fallback', async () => {
    const check = gwgCheck(new Date(FIXED_NOW.getTime() + 90 * DAY));
    check.client.responsibilities = [];
    h.tx.gwgCheck.findMany.mockResolvedValue([check]);

    await run();

    expect(upsertCalls()).toContainEqual([TENANT, 'admin-1', expect.anything()]);
  });

  it('ohne ADMIN/PARTNER wird der Tenant komplett übersprungen', async () => {
    h.adminPartners.mockResolvedValue([]);

    await run();

    expect(h.tx.gwgCheck.findMany).not.toHaveBeenCalled();
    expect(upsertCalls()).toEqual([]);
  });
});

describe('F-10: Empfänger nur aktiv und zugriffsberechtigt, sonst ADMIN/PARTNER', () => {
  it('STAGE1: deaktivierter Hauptbearbeiter → aktive ADMIN/PARTNER statt niemand', async () => {
    h.withoutAccess.add('hb-1');
    h.tx.gwgCheck.findMany.mockResolvedValue([gwgCheck(new Date(FIXED_NOW.getTime() + 90 * DAY))]);

    const result = await run();

    expect(upsertCalls().map((c) => c[1])).toEqual(['admin-1']);
    expect(h.filterStaffAccessClientTx).toHaveBeenCalledWith(h.tx, TENANT, ['hb-1'], 'client-1');
    expect(result.stage1).toBe(1);
  });

  it('STAGE2: nur der noch aktive Berufsträger, kein Fallback nötig', async () => {
    h.withoutAccess.add('hb-1');
    h.tx.gwgCheck.findMany.mockResolvedValue([gwgCheck(new Date(FIXED_NOW.getTime() + 30 * DAY))]);

    const result = await run();

    expect(upsertCalls().map((c) => c[1])).toEqual(['bt-1']);
    expect(h.recipientStaff).not.toHaveBeenCalled();
    expect(result.stage2).toBe(1);
  });

  it('STAGE2: beide Zuständigen ausgeschieden → ADMIN/PARTNER mit Zugriff', async () => {
    h.withoutAccess.add('hb-1').add('bt-1').add('admin-inactive');
    h.recipientStaff.mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-inactive' }]);
    h.tx.gwgCheck.findMany.mockResolvedValue([gwgCheck(new Date(FIXED_NOW.getTime() + 30 * DAY))]);

    await run();

    expect(h.recipientStaff).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: TENANT,
          active: true,
          roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
        },
      }),
    );
    expect(upsertCalls().map((c) => c[1])).toEqual(['admin-1']);
  });

  it('STAGE3: ausgeschiedene Zuständige fallen heraus, ADMIN/PARTNER bleiben', async () => {
    h.withoutAccess.add('hb-1');
    h.tx.gwgCheck.findMany.mockResolvedValue([gwgCheck(FIXED_NOW)]);

    const result = await run();

    expect(upsertCalls().map((c) => c[1])).toEqual(['bt-1', 'admin-1']);
    expect(result.stage3).toBe(2);
  });

  it('Ausweis-Ablauf: deaktivierter Bearbeiter → ADMIN/PARTNER-Fallback', async () => {
    h.withoutAccess.add('hb-1');
    h.tx.gwgIdDocument.findMany.mockResolvedValue([
      idDoc(new Date(FIXED_NOW.getTime() + 30 * DAY)),
    ]);

    const result = await run();

    expect(upsertCalls()).toContainEqual([
      TENANT,
      'admin-1',
      expect.objectContaining({ kind: 'GWG_ID_EXPIRY_SOON', resourceId: 'doc-1' }),
    ]);
    expect(upsertCalls().map((c) => c[1])).toEqual(['admin-1']);
    expect(result.idDocReminders).toBe(1);
  });

  it('ohne jeden berechtigten Empfänger entsteht kein Hinweis, die Eskalation läuft trotzdem', async () => {
    h.withoutAccess.add('hb-1').add('bt-1').add('admin-1');
    h.tx.gwgCheck.findMany.mockResolvedValue([gwgCheck(FIXED_NOW)]);

    const result = await run();

    expect(h.tx.gwgCheck.updateMany).toHaveBeenCalled();
    expect(upsertCalls()).toEqual([]);
    expect(result.stage3).toBe(0);
  });
});

describe('STAGE3 — Ablauf (RF-8: Statuswechsel + Audit in EINER Tx)', () => {
  it('setzt Check auf EXPIRED, deaktiviert Mandanten und auditiert beides in derselben Tx', async () => {
    h.tx.gwgCheck.findMany.mockResolvedValue([gwgCheck(FIXED_NOW)]); // daysLeft = 0

    const result = await run();

    // S-01: Die erste Tenant-Transaktion liest Admin/Partner und Kandidaten.
    // Ablauf, Widerrufsmarker (B7) und Notification-Auflösung laufen gemeinsam
    // in der zweiten; die dritte liest die Kontakte, die vierte löscht den Marker
    // nach dem bestätigten Widerruf, die fünfte ermittelt die aktuellen Empfänger
    // (F-10), die sechste liest die Ausweise, die siebte räumt einen eventuell
    // alten Löschhinweis auf.
    expect(h.withSystemContext).toHaveBeenCalledTimes(7);
    expect(h.withSystemContext.mock.calls[0]![0]).toBe(TENANT);
    expect(h.markPending).toHaveBeenCalledTimes(1);
    expect(h.markPending).toHaveBeenCalledWith(h.tx, { tenantId: TENANT, clientId: 'client-1' });

    // Statuswechsel guarded (nur aus VERIFIED) — Race-sicher
    expect(h.tx.gwgCheck.updateMany).toHaveBeenCalledWith({
      where: { id: 'gwg-1', status: 'VERIFIED' },
      data: { status: 'EXPIRED' },
    });
    expect(h.tx.client.updateMany).toHaveBeenCalledWith({
      where: { id: 'client-1', allowActive: true },
      data: { allowActive: false },
    });

    expect(h.record).toHaveBeenCalledTimes(2);
    // beide Audit-Records laufen auf DEMSELBEN Tx wie die Updates
    expect(h.record.mock.calls[0]![0]).toBe(h.tx);
    expect(h.record.mock.calls[1]![0]).toBe(h.tx);
    expect(h.record.mock.calls[0]![1]).toMatchObject({
      tenantId: TENANT,
      actorType: 'SYSTEM',
      action: 'gwg.check.expire',
      resourceId: 'gwg-1',
      before: { status: 'VERIFIED' },
      after: expect.objectContaining({ status: 'EXPIRED' }),
    });
    expect(h.record.mock.calls[1]![1]).toMatchObject({
      action: 'client.deactivate.gwg_expired',
      resourceId: 'client-1',
      before: { allowActive: true },
      after: expect.objectContaining({ allowActive: false, deactivatedByDbTrigger: true }),
    });

    // alle relevanten Adressaten, dedupliziert
    const recipients = upsertCalls().map((c) => c[1]);
    expect(recipients.sort()).toEqual(['admin-1', 'bt-1', 'hb-1']);
    for (const call of upsertCalls()) {
      expect((call[2] as { kind: string }).kind).toBe('GWG_EXPIRED');
    }
    expect(result.stage3).toBe(3);

    // GwG-Schranke (§ 11 GwG): Portal-Sessions ALLER aktiven Kontakte des
    // deaktivierten Mandanten werden sofort revoziert — Key-Schema und
    // monotones Lua-Skript wie in der Web-App (revoke:portal:<contactId>).
    expect(h.tx.clientContact.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, clientId: 'client-1', active: true },
      select: { id: true },
    });
    expect(h.redisEval).toHaveBeenCalledWith(
      expect.stringContaining('if current > incoming then'),
      1,
      'revoke:portal:contact-1',
      String(FIXED_NOW.getTime()),
      30 * 24 * 60 * 60,
    );
    // B7: erst nach dem bestätigten Widerruf wird der Marker gelöscht, und
    // zwar genau der in der Deaktivierungs-Transaktion gesetzte Wert.
    expect(h.clearPending).toHaveBeenCalledWith(h.tx, {
      tenantId: TENANT,
      clientId: 'client-1',
      pendingAt: FIXED_NOW,
    });
    expect(h.withSystemContext.mock.calls[1]![0]).toBe(TENANT);
    expect(h.redisEval.mock.invocationCallOrder[0]).toBeLessThan(
      h.clearPending.mock.invocationCallOrder[0]!,
    );
  });

  it('fail-closed: ein nicht bestätigter Widerruf lässt den Lauf nach allen Tenants scheitern', async () => {
    h.tx.gwgCheck.findMany.mockResolvedValue([gwgCheck(new Date(FIXED_NOW.getTime() - 5 * DAY))]);
    h.redisEval.mockRejectedValue(
      new Error("READONLY You can't write against a read only replica."),
    );

    await expect(run()).rejects.toThrow('1 Portal-Session-Widerruf(e) nicht bestätigt');

    // Die Deaktivierung bleibt committed und die Eskalation geht trotzdem raus;
    // der Fehler wird erst nach der vollständigen Bearbeitung gemeldet.
    expect(h.tx.client.updateMany).toHaveBeenCalled();
    // B7: Der Marker aus der Deaktivierungs-Transaktion bleibt stehen.
    expect(h.markPending).toHaveBeenCalledWith(h.tx, { tenantId: TENANT, clientId: 'client-1' });
    expect(h.clearPending).not.toHaveBeenCalled();
    expect(
      upsertCalls()
        .map((c) => c[1])
        .sort(),
    ).toEqual(['admin-1', 'bt-1', 'hb-1']);
  });

  it('idempotent: Check/Mandant bereits umgestellt (count=0) → KEIN Audit-Eintrag', async () => {
    h.tx.gwgCheck.findMany.mockResolvedValue([gwgCheck(new Date(FIXED_NOW.getTime() - 5 * DAY))]);
    h.tx.gwgCheck.updateMany.mockResolvedValue({ count: 0 });
    h.tx.client.updateMany.mockResolvedValue({ count: 0 });

    await run();

    expect(h.record).not.toHaveBeenCalled();
    // keine erneute Session-Revocation — der Mandant war schon deaktiviert
    // (Revocation lief beim tatsächlichen Übergang bzw. in rejectCheckAction)
    expect(h.redisEval).not.toHaveBeenCalled();
    expect(h.markPending).not.toHaveBeenCalled();
    // die (idempotente) Notification geht trotzdem raus
    expect(upsertCalls().length).toBeGreaterThan(0);
  });

  it('neuerer gültiger VERIFIED-Check → Alt-Check EXPIRED, aber KEINE Deaktivierung/Eskalation', async () => {
    // Wiederholungsprüfung: der alte Check ist abgelaufen, ein zweiter,
    // noch gültiger VERIFIED-Check existiert für denselben Mandanten.
    h.tx.gwgCheck.findMany.mockResolvedValue([gwgCheck(new Date(FIXED_NOW.getTime() - 5 * DAY))]);
    h.tx.gwgCheck.findFirst.mockResolvedValue({ id: 'gwg-2' });

    const result = await run();

    // Alt-Check wird als Housekeeping auf EXPIRED gesetzt + auditiert …
    expect(h.tx.gwgCheck.updateMany).toHaveBeenCalledWith({
      where: { id: 'gwg-1', status: 'VERIFIED' },
      data: { status: 'EXPIRED' },
    });
    // … aber der Mandant wird NICHT deaktiviert.
    expect(h.tx.client.updateMany).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0]![1]).toMatchObject({ action: 'gwg.check.expire' });
    // Keine STAGE3-Eskalations-Notification, keine Session-Revocation.
    expect(upsertCalls()).toEqual([]);
    expect(h.redisEval).not.toHaveBeenCalled();
    expect(h.markPending).not.toHaveBeenCalled();
    expect(result.stage3).toBe(0);
  });
});

describe('B7: ausstehender Portal-Session-Widerruf (Marker, Nachholen zuerst)', () => {
  const redisDown = () =>
    h.redisEval.mockRejectedValue(
      new Error("READONLY You can't write against a read only replica."),
    );

  it('Fehlschlag, dann BullMQ-Wiederholung: der Widerruf wird vor allem anderen nachgeholt', async () => {
    const markers = useMarkerStore();
    h.tx.gwgCheck.findMany.mockResolvedValue([gwgCheck(new Date(FIXED_NOW.getTime() - 5 * DAY))]);
    redisDown();

    await expect(run()).rejects.toThrow('1 Portal-Session-Widerruf(e) nicht bestätigt');
    // Die Deaktivierung ist committed, ihr Marker steht noch.
    expect([...markers.values()]).toEqual([
      { tenantId: TENANT, clientId: 'client-1', pendingAt: FIXED_NOW },
    ]);
    expect(h.clearPending).not.toHaveBeenCalled();

    // Wiederholung: Der Check ist jetzt EXPIRED und kein Kandidat mehr; ohne
    // Marker würde kein Lauf mehr widerrufen.
    h.tx.gwgCheck.findMany.mockResolvedValue([]);
    h.redisEval.mockReset().mockResolvedValue('OK');
    const tenantQueries = h.adminPartners.mock.calls.length;

    await expect(run()).resolves.toMatchObject({ stage3: 0 });

    expect(h.listPending).toHaveBeenLastCalledWith(h.prismaOwner, TENANT);
    expect(h.redisEval).toHaveBeenCalledTimes(1);
    expect(h.redisEval).toHaveBeenCalledWith(
      expect.stringContaining('if current > incoming then'),
      1,
      'revoke:portal:contact-1',
      String(FIXED_NOW.getTime()),
      30 * 24 * 60 * 60,
    );
    // Zuerst: vor der ersten Tenant-Abfrage des Wiederholungslaufs.
    expect(h.redisEval.mock.invocationCallOrder[0]).toBeLessThan(
      h.adminPartners.mock.invocationCallOrder[tenantQueries]!,
    );
    expect(markers.size).toBe(0);

    // Danach ist nichts mehr offen.
    h.redisEval.mockClear();
    await run();
    expect(h.redisEval).not.toHaveBeenCalled();
  });

  it('scheitert auch das Nachholen, bleibt der Marker und die Tenants werden trotzdem bearbeitet', async () => {
    const markers = useMarkerStore();
    markers.set('client-9', {
      tenantId: TENANT,
      clientId: 'client-9',
      pendingAt: new Date(FIXED_NOW.getTime() - DAY),
    });
    h.tx.gwgCheck.findMany.mockResolvedValue([gwgCheck(new Date(FIXED_NOW.getTime() + 30 * DAY))]);
    redisDown();

    await expect(run()).rejects.toThrow('1 Portal-Session-Widerruf(e) nicht bestätigt');

    expect(h.tx.clientContact.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, clientId: 'client-9', active: true },
      select: { id: true },
    });
    expect(markers.has('client-9')).toBe(true);
    expect(h.clearPending).not.toHaveBeenCalled();
    // Die Eskalation des Tenants läuft unabhängig davon.
    expect(
      upsertCalls()
        .map((c) => c[1])
        .sort(),
    ).toEqual(['bt-1', 'hb-1']);
  });

  it('holt Marker auch für Tenants ohne ADMIN/PARTNER und tenantübergreifend nach', async () => {
    const markers = useMarkerStore();
    markers.set('client-9', {
      tenantId: 'tenant-2',
      clientId: 'client-9',
      pendingAt: new Date(FIXED_NOW.getTime() - DAY),
    });
    h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: TENANT }, { id: 'tenant-2' }]);
    h.adminPartners.mockResolvedValue([]);

    await run({});

    expect(h.listPending).toHaveBeenCalledWith(h.prismaOwner, undefined);
    expect(h.redisEval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'revoke:portal:contact-1',
      expect.any(String),
      expect.any(Number),
    );
    expect(h.withSystemContext).toHaveBeenCalledWith('tenant-2', expect.any(Function));
    expect(markers.size).toBe(0);
    // Beide Tenants wurden mangels ADMIN/PARTNER übersprungen.
    expect(h.tx.gwgCheck.findMany).not.toHaveBeenCalled();
  });

  it('ein Fehler beim Löschen des Markers zählt als offen und hält die übrigen Marker nicht auf', async () => {
    const markers = useMarkerStore();
    for (const clientId of ['client-8', 'client-9']) {
      markers.set(clientId, {
        tenantId: TENANT,
        clientId,
        pendingAt: new Date(FIXED_NOW.getTime() - DAY),
      });
    }
    const clear = h.clearPending.getMockImplementation()!;
    h.clearPending.mockImplementation(async (tx: unknown, pending: PendingRevocation) => {
      if (pending.clientId === 'client-8') throw new Error('connection terminated');
      return clear(tx, pending);
    });

    await expect(run()).rejects.toThrow('1 Portal-Session-Widerruf(e) nicht bestätigt');

    expect([...markers.keys()]).toEqual(['client-8']);
  });
});

describe('Personalausweis-Ablauf (U-5: Idempotenz per FK)', () => {
  it('läuft in 30 Tagen ab → Reminder + Auto-Anforderung mit linkedGwgIdDocumentId', async () => {
    const expiry = new Date(FIXED_NOW.getTime() + 30 * DAY);
    h.tx.gwgIdDocument.findMany.mockResolvedValue([idDoc(expiry)]);

    const result = await run();

    expect(upsertCalls()).toContainEqual([
      TENANT,
      'hb-1',
      expect.objectContaining({ kind: 'GWG_ID_EXPIRY_SOON', resourceId: 'doc-1' }),
    ]);
    // Idempotenz-Match exakt per FK, nicht per Titel-Substring
    expect(h.tx.request.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        status: { in: ['OPEN', 'IN_PROGRESS', 'RESPONDED'] },
        linkedGwgIdDocumentId: { in: ['doc-1'] },
      },
      select: { linkedGwgIdDocumentId: true },
    });
    expect(h.tx.request.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          tenantId: TENANT,
          clientId: 'client-1',
          priority: 'NORMAL',
          createdByStaff: 'admin-1',
          dueAt: expiry,
          linkedGwgIdDocumentId: 'doc-1',
        }),
      ],
      skipDuplicates: true,
    });
    expect(result.idDocRequests).toBe(1);
    expect(result.idDocReminders).toBe(1);
  });

  it('bereits abgelaufen → GWG_ID_EXPIRED, Priorität HIGH, 7-Tage-Frist', async () => {
    h.tx.gwgIdDocument.findMany.mockResolvedValue([
      idDoc(new Date(FIXED_NOW.getTime() - 10 * DAY)),
    ]);

    await run();

    expect(upsertCalls()).toContainEqual([
      TENANT,
      'hb-1',
      expect.objectContaining({ kind: 'GWG_ID_EXPIRED' }),
    ]);
    expect(h.tx.request.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          priority: 'HIGH',
          dueAt: new Date(FIXED_NOW.getTime() + 7 * DAY),
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('Ablaufdatum heute gilt einschließlich und wird als „läuft heute ab" gemeldet', async () => {
    h.tx.gwgIdDocument.findMany.mockResolvedValue([idDoc(new Date('2026-06-09T00:00:00.000Z'))]);

    const result = await run();

    expect(upsertCalls()).toContainEqual([
      TENANT,
      'hb-1',
      expect.objectContaining({
        kind: 'GWG_ID_EXPIRY_SOON',
        title: expect.stringContaining('läuft heute ab'),
      }),
    ]);
    expect(h.tx.request.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ priority: 'NORMAL' })],
      skipDuplicates: true,
    });
    expect(result.idDocRequests).toBe(1);
  });

  it('offene Anforderung existiert bereits → keine zweite (idempotent)', async () => {
    h.tx.gwgIdDocument.findMany.mockResolvedValue([
      idDoc(new Date(FIXED_NOW.getTime() + 30 * DAY)),
    ]);
    h.tx.request.findMany.mockResolvedValue([{ linkedGwgIdDocumentId: 'doc-1' }]);

    const result = await run();

    expect(h.tx.request.createMany).not.toHaveBeenCalled();
    expect(result.idDocRequests).toBe(0);
  });

  it('prüft vorhandene Anforderungen für alle Ausweise in einer Query', async () => {
    const expiry = new Date(FIXED_NOW.getTime() + 30 * DAY);
    h.tx.gwgIdDocument.findMany.mockResolvedValue([
      idDoc(expiry),
      idDoc(expiry, { id: 'doc-2', ownerName: 'Erika Muster' }),
    ]);
    h.tx.request.findMany.mockResolvedValue([{ linkedGwgIdDocumentId: 'doc-1' }]);

    const result = await run();

    expect(h.tx.request.findMany).toHaveBeenCalledTimes(1);
    expect(h.tx.request.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        status: { in: ['OPEN', 'IN_PROGRESS', 'RESPONDED'] },
        linkedGwgIdDocumentId: { in: ['doc-1', 'doc-2'] },
      },
      select: { linkedGwgIdDocumentId: true },
    });
    expect(h.tx.request.createMany).toHaveBeenCalledTimes(1);
    expect(h.tx.request.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ linkedGwgIdDocumentId: 'doc-2' })],
      skipDuplicates: true,
    });
    expect(result.idDocRequests).toBe(1);
  });

  it('deaktivierter Mandant → Reminder ja, Auto-Anforderung nein', async () => {
    const doc = idDoc(new Date(FIXED_NOW.getTime() + 30 * DAY));
    doc.check.client.allowActive = false;
    h.tx.gwgIdDocument.findMany.mockResolvedValue([doc]);

    const result = await run();

    expect(upsertCalls().length).toBeGreaterThan(0);
    expect(h.tx.request.createMany).not.toHaveBeenCalled();
    expect(result.idDocRequests).toBe(0);
  });

  it('zählt einen parallel bereits gewonnenen Unique-Insert nicht als neue Anforderung', async () => {
    h.tx.gwgIdDocument.findMany.mockResolvedValue([
      idDoc(new Date(FIXED_NOW.getTime() + 30 * DAY)),
    ]);
    h.tx.request.createMany.mockResolvedValue({ count: 0 });

    const result = await run();

    expect(h.tx.request.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(result.idDocRequests).toBe(0);
  });
});

describe('GwG-Lösch-Queue (§ 8 Abs. 1 und 4): GWG_DELETION_DUE', () => {
  it('löschreife Belege + Aufzeichnungen → tägliche Notification an alle ADMIN/PARTNER', async () => {
    h.adminPartners.mockResolvedValue([{ id: 'admin-1' }, { id: 'partner-1' }]);
    h.prismaOwner.document.count.mockResolvedValue(2);
    h.tx.gwgCheck.count.mockResolvedValue(1);

    const result = await run();

    // R-02: exakt die Filter der Web-Review-Queue (@taxtronik/tax), je Tenant.
    expect(h.prismaOwner.document.count).toHaveBeenCalledWith({
      where: { tenantId: TENANT, ...dueGwgDeletionDocsWhere(FIXED_NOW) },
    });
    expect(h.tx.gwgCheck.count).toHaveBeenCalledWith({
      where: { tenantId: TENANT, ...dueGwgCheckDeletionsWhere(FIXED_NOW) },
    });
    // Frist-Cutoff: Fristbeginn vor dem 1.1.(Jahr(now) − 5) — exakt, kein Grobfilter
    const cutoff = new Date(Date.UTC(2021, 0, 1));
    const documentQuery = h.prismaOwner.document.count.mock.calls[0]?.[0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    const checkQuery = h.tx.gwgCheck.count.mock.calls[0]?.[0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    expect(documentQuery.where.OR).toContainEqual({
      client: { is: { mandateEndedAt: { lt: cutoff } } },
    });
    expect(checkQuery.where.OR).toContainEqual({ client: { mandateEndedAt: { lt: cutoff } } });
    // Das reine Alter darf bei einer laufenden Geschäftsbeziehung weder Beleg
    // noch Check in die Lösch-Notification aufnehmen.
    expect(
      documentQuery.where.OR.every((branch) => !('createdAt' in branch) || 'client' in branch),
    ).toBe(true);
    expect(checkQuery.where.OR.every((branch) => !('createdAt' in branch))).toBe(true);
    const neverEstablishedDocumentBranch = documentQuery.where.OR.find(
      (branch) => 'createdAt' in branch,
    );
    expect(neverEstablishedDocumentBranch).toMatchObject({
      createdAt: { lt: cutoff },
      client: { is: { mandateEndedAt: null, allowActive: false, onboardingCompletedAt: null } },
      gwgIdDocuments: {
        none: { check: { is: { OR: [{ status: 'VERIFIED' }, { verifiedAt: { not: null } }] } } },
      },
      NOT: {
        gwgOnboardingInvite: {
          is: {
            gwgCheck: { is: { OR: [{ status: 'VERIFIED' }, { verifiedAt: { not: null } }] } },
          },
        },
      },
    });
    const neverEstablishedCheckBranch = checkQuery.where.OR.find(
      (branch) => 'verifiedAt' in branch,
    );
    expect(neverEstablishedCheckBranch).toMatchObject({
      updatedAt: { lt: cutoff },
      idDocuments: { none: { createdAt: { gte: cutoff } } },
      beneficialOwners: { none: { createdAt: { gte: cutoff } } },
      onboardingInvites: { none: { updatedAt: { gte: cutoff } } },
    });

    const calls = upsertCalls().filter(
      (c) => (c[2] as { kind: string }).kind === 'GWG_DELETION_DUE',
    );
    expect(calls.map((c) => c[1]).sort()).toEqual(['admin-1', 'partner-1']);
    for (const c of calls) {
      expect(c[2]).toMatchObject({
        kind: 'GWG_DELETION_DUE',
        title: 'GwG-Löschprüfung: 3 Einträge löschreif',
        href: '/staff/admin/gwg-retention',
        // resource_id = Tenant-ID: stabiler Schlüssel für den Tages-Dedupe (iter81)
        resourceType: 'tenant',
        resourceId: TENANT,
      });
      expect((c[2] as { body: string }).body).toContain('nie zustande gekommener Beziehungen');
    }
    expect(result.deletionDueNotices).toBe(2);
  });

  it('nichts löschreif → keine GWG_DELETION_DUE-Notification', async () => {
    const result = await run();

    const calls = upsertCalls().filter(
      (c) => (c[2] as { kind: string }).kind === 'GWG_DELETION_DUE',
    );
    expect(calls).toEqual([]);
    expect(result.deletionDueNotices).toBe(0);
  });
});
