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
//     aktiven Kontakte revoziert (revoke:portal:<contactId> via Redis)
//   - Idempotenz: bereits umgestellte Checks erzeugen keinen Audit-Eintrag
//     und keine erneute Session-Revocation
//   - U-5: Auto-Anforderung für ablaufende Ausweise idempotent per FK
//     (linkedGwgIdDocumentId), HIGH/7-Tage-Frist wenn bereits abgelaufen
//   - GwG-Lösch-Queue (§ 8 Abs. 4 S. 4): GWG_DELETION_DUE an ADMIN/PARTNER,
//     sobald löschreife Belege/Aufzeichnungen existieren (resource_id = Tenant)
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const prismaOwner = {
    tenant: { findMany: vi.fn() },
    staffUser: { findMany: vi.fn() },
    gwgCheck: { findMany: vi.fn(), count: vi.fn() },
    gwgIdDocument: { findMany: vi.fn() },
    document: { count: vi.fn() },
    request: { findFirst: vi.fn(), create: vi.fn() },
    clientContact: { findMany: vi.fn() },
  };
  const tx = {
    gwgCheck: { updateMany: vi.fn(), findFirst: vi.fn() },
    client: { findUnique: vi.fn(), updateMany: vi.fn() },
  };
  const withWorkerTenantContext = vi.fn(
    async (_tenantId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  );
  const record = vi.fn();
  const upsertNotification = vi.fn();
  // Portal-Session-Revocation: der Worker schreibt `revoke:portal:<contactId>`
  // direkt über die BullMQ-Redis-Verbindung (Key-Schema aus
  // apps/web/src/server/auth/revocation.ts).
  const redisSet = vi.fn();
  return { prismaOwner, tx, withWorkerTenantContext, record, upsertNotification, redisSet };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: { set: h.redisSet } }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../tenant-context', () => ({ withWorkerTenantContext: h.withWorkerTenantContext }));
vi.mock('../../notify', () => ({ upsertNotification: h.upsertNotification }));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {
    record = h.record;
  },
  LocalTimestampAdapter: class {},
}));

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

function run(): Promise<GwgResult> {
  return processors.get('gwg-expiry-check')!({ data: { tenantId: TENANT } }) as Promise<GwgResult>;
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
  h.withWorkerTenantContext.mockImplementation(
    async (_tenantId: string, fn: (t: unknown) => Promise<unknown>) => fn(h.tx),
  );
  h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: TENANT }]);
  h.prismaOwner.staffUser.findMany.mockResolvedValue([{ id: 'admin-1' }]);
  h.prismaOwner.gwgCheck.findMany.mockResolvedValue([]);
  h.prismaOwner.gwgCheck.count.mockResolvedValue(0);
  h.prismaOwner.gwgIdDocument.findMany.mockResolvedValue([]);
  h.prismaOwner.document.count.mockResolvedValue(0);
  h.prismaOwner.request.findFirst.mockResolvedValue(null);
  h.prismaOwner.request.create.mockResolvedValue({ id: 'req-1' });
  h.prismaOwner.clientContact.findMany.mockResolvedValue([{ id: 'contact-1' }]);
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
  h.upsertNotification.mockResolvedValue(undefined);
  h.redisSet.mockResolvedValue('OK');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Stufenlogik an den Tagesgrenzen', () => {
  it('RF-14: lädt nur VERIFIED-Checks im 90-Tage-Relevanz-Fenster', async () => {
    await run();

    expect(h.prismaOwner.gwgCheck.findMany).toHaveBeenCalledWith(
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
    h.prismaOwner.gwgCheck.findMany.mockResolvedValue([
      gwgCheck(new Date(FIXED_NOW.getTime() + 91 * DAY)),
    ]);

    const result = await run();

    expect(h.upsertNotification).not.toHaveBeenCalled();
    expect(h.withWorkerTenantContext).not.toHaveBeenCalled();
    expect(result).toMatchObject({ stage1: 0, stage2: 0, stage3: 0 });
  });

  it('STAGE1 (90 Tage): nur der Hauptbearbeiter wird informiert', async () => {
    h.prismaOwner.gwgCheck.findMany.mockResolvedValue([
      gwgCheck(new Date(FIXED_NOW.getTime() + 90 * DAY)),
    ]);

    const result = await run();

    expect(h.upsertNotification).toHaveBeenCalledTimes(1);
    expect(h.upsertNotification).toHaveBeenCalledWith(
      TENANT,
      'hb-1',
      expect.objectContaining({ kind: 'GWG_EXPIRY_90D', resourceId: 'gwg-1' }),
    );
    expect(result.stage1).toBe(1);
  });

  it('STAGE2 (30 Tage): Hauptbearbeiter + Berufsträger', async () => {
    h.prismaOwner.gwgCheck.findMany.mockResolvedValue([
      gwgCheck(new Date(FIXED_NOW.getTime() + 30 * DAY)),
    ]);

    const result = await run();

    const recipients = h.upsertNotification.mock.calls.map((c) => c[1]);
    expect(recipients.sort()).toEqual(['bt-1', 'hb-1']);
    for (const call of h.upsertNotification.mock.calls) {
      expect((call[2] as { kind: string }).kind).toBe('GWG_EXPIRY_30D');
    }
    expect(result.stage2).toBe(2);
  });

  it('STAGE1 ohne Verantwortliche → ADMIN/PARTNER-Fallback', async () => {
    const check = gwgCheck(new Date(FIXED_NOW.getTime() + 90 * DAY));
    check.client.responsibilities = [];
    h.prismaOwner.gwgCheck.findMany.mockResolvedValue([check]);

    await run();

    expect(h.upsertNotification).toHaveBeenCalledWith(TENANT, 'admin-1', expect.anything());
  });

  it('ohne ADMIN/PARTNER wird der Tenant komplett übersprungen', async () => {
    h.prismaOwner.staffUser.findMany.mockResolvedValue([]);

    await run();

    expect(h.prismaOwner.gwgCheck.findMany).not.toHaveBeenCalled();
    expect(h.upsertNotification).not.toHaveBeenCalled();
  });
});

describe('STAGE3 — Ablauf (RF-8: Statuswechsel + Audit in EINER Tx)', () => {
  it('setzt Check auf EXPIRED, deaktiviert Mandanten und auditiert beides in derselben Tx', async () => {
    h.prismaOwner.gwgCheck.findMany.mockResolvedValue([gwgCheck(FIXED_NOW)]); // daysLeft = 0

    const result = await run();

    expect(h.withWorkerTenantContext).toHaveBeenCalledTimes(1);
    expect(h.withWorkerTenantContext.mock.calls[0]![0]).toBe(TENANT);

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
    const recipients = h.upsertNotification.mock.calls.map((c) => c[1]);
    expect(recipients.sort()).toEqual(['admin-1', 'bt-1', 'hb-1']);
    for (const call of h.upsertNotification.mock.calls) {
      expect((call[2] as { kind: string }).kind).toBe('GWG_EXPIRED');
    }
    expect(result.stage3).toBe(3);

    // GwG-Schranke (§ 11 GwG): Portal-Sessions ALLER aktiven Kontakte des
    // deaktivierten Mandanten werden sofort revoziert — Key-Schema wie in
    // apps/web/src/server/auth/revocation.ts (revoke:portal:<contactId>).
    expect(h.prismaOwner.clientContact.findMany).toHaveBeenCalledWith({
      where: { clientId: 'client-1', active: true },
      select: { id: true },
    });
    expect(h.redisSet).toHaveBeenCalledWith(
      'revoke:portal:contact-1',
      String(FIXED_NOW.getTime()),
      'EX',
      30 * 24 * 60 * 60,
    );
  });

  it('idempotent: Check/Mandant bereits umgestellt (count=0) → KEIN Audit-Eintrag', async () => {
    h.prismaOwner.gwgCheck.findMany.mockResolvedValue([
      gwgCheck(new Date(FIXED_NOW.getTime() - 5 * DAY)),
    ]);
    h.tx.gwgCheck.updateMany.mockResolvedValue({ count: 0 });
    h.tx.client.updateMany.mockResolvedValue({ count: 0 });

    await run();

    expect(h.record).not.toHaveBeenCalled();
    // keine erneute Session-Revocation — der Mandant war schon deaktiviert
    // (Revocation lief beim tatsächlichen Übergang bzw. in rejectCheckAction)
    expect(h.redisSet).not.toHaveBeenCalled();
    // die (idempotente) Notification geht trotzdem raus
    expect(h.upsertNotification).toHaveBeenCalled();
  });

  it('neuerer gültiger VERIFIED-Check → Alt-Check EXPIRED, aber KEINE Deaktivierung/Eskalation', async () => {
    // Wiederholungsprüfung: der alte Check ist abgelaufen, ein zweiter,
    // noch gültiger VERIFIED-Check existiert für denselben Mandanten.
    h.prismaOwner.gwgCheck.findMany.mockResolvedValue([
      gwgCheck(new Date(FIXED_NOW.getTime() - 5 * DAY)),
    ]);
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
    expect(h.upsertNotification).not.toHaveBeenCalled();
    expect(h.redisSet).not.toHaveBeenCalled();
    expect(result.stage3).toBe(0);
  });
});

describe('Personalausweis-Ablauf (U-5: Idempotenz per FK)', () => {
  it('läuft in 30 Tagen ab → Reminder + Auto-Anforderung mit linkedGwgIdDocumentId', async () => {
    const expiry = new Date(FIXED_NOW.getTime() + 30 * DAY);
    h.prismaOwner.gwgIdDocument.findMany.mockResolvedValue([idDoc(expiry)]);

    const result = await run();

    expect(h.upsertNotification).toHaveBeenCalledWith(
      TENANT,
      'hb-1',
      expect.objectContaining({ kind: 'GWG_ID_EXPIRY_SOON', resourceId: 'doc-1' }),
    );
    // Idempotenz-Match exakt per FK, nicht per Titel-Substring
    expect(h.prismaOwner.request.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        clientId: 'client-1',
        status: { in: ['OPEN', 'IN_PROGRESS', 'RESPONDED'] },
        linkedGwgIdDocumentId: 'doc-1',
      },
    });
    expect(h.prismaOwner.request.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT,
        clientId: 'client-1',
        priority: 'NORMAL',
        createdByStaff: 'admin-1',
        dueAt: expiry,
        linkedGwgIdDocumentId: 'doc-1',
      }),
    });
    expect(result.idDocRequests).toBe(1);
    expect(result.idDocReminders).toBe(1);
  });

  it('bereits abgelaufen → GWG_ID_EXPIRED, Priorität HIGH, 7-Tage-Frist', async () => {
    h.prismaOwner.gwgIdDocument.findMany.mockResolvedValue([
      idDoc(new Date(FIXED_NOW.getTime() - 10 * DAY)),
    ]);

    await run();

    expect(h.upsertNotification).toHaveBeenCalledWith(
      TENANT,
      'hb-1',
      expect.objectContaining({ kind: 'GWG_ID_EXPIRED' }),
    );
    expect(h.prismaOwner.request.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        priority: 'HIGH',
        dueAt: new Date(FIXED_NOW.getTime() + 7 * DAY),
      }),
    });
  });

  it('offene Anforderung existiert bereits → keine zweite (idempotent)', async () => {
    h.prismaOwner.gwgIdDocument.findMany.mockResolvedValue([
      idDoc(new Date(FIXED_NOW.getTime() + 30 * DAY)),
    ]);
    h.prismaOwner.request.findFirst.mockResolvedValue({ id: 'req-existing' });

    const result = await run();

    expect(h.prismaOwner.request.create).not.toHaveBeenCalled();
    expect(result.idDocRequests).toBe(0);
  });

  it('deaktivierter Mandant → Reminder ja, Auto-Anforderung nein', async () => {
    const doc = idDoc(new Date(FIXED_NOW.getTime() + 30 * DAY));
    doc.check.client.allowActive = false;
    h.prismaOwner.gwgIdDocument.findMany.mockResolvedValue([doc]);

    const result = await run();

    expect(h.upsertNotification).toHaveBeenCalled();
    expect(h.prismaOwner.request.create).not.toHaveBeenCalled();
    expect(result.idDocRequests).toBe(0);
  });
});

describe('GwG-Lösch-Queue (§ 8 Abs. 1 und 4): GWG_DELETION_DUE', () => {
  it('löschreife Belege + Aufzeichnungen → tägliche Notification an alle ADMIN/PARTNER', async () => {
    h.prismaOwner.staffUser.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'partner-1' }]);
    h.prismaOwner.document.count.mockResolvedValue(2);
    h.prismaOwner.gwgCheck.count.mockResolvedValue(1);

    const result = await run();

    // Frist-Cutoff: Mandatsende vor dem 1.1.(Jahr(now) − 5) — exakt, kein Grobfilter
    const cutoff = new Date(Date.UTC(2021, 0, 1));
    expect(h.prismaOwner.document.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId: TENANT,
        classification: 'GWG_EVIDENCE',
        deletedAt: null,
        OR: expect.arrayContaining([{ client: { mandateEndedAt: { lt: cutoff } } }]),
      }),
    });
    expect(h.prismaOwner.gwgCheck.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId: TENANT,
        destroyedAt: null,
        OR: expect.arrayContaining([{ client: { mandateEndedAt: { lt: cutoff } } }]),
      }),
    });

    const calls = h.upsertNotification.mock.calls.filter(
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
    }
    expect(result.deletionDueNotices).toBe(2);
  });

  it('nichts löschreif → keine GWG_DELETION_DUE-Notification', async () => {
    const result = await run();

    const calls = h.upsertNotification.mock.calls.filter(
      (c) => (c[2] as { kind: string }).kind === 'GWG_DELETION_DUE',
    );
    expect(calls).toEqual([]);
    expect(result.deletionDueNotices).toBe(0);
  });
});
