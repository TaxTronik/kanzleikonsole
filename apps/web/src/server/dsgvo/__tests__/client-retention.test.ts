import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@taxtronik/db/prisma-client';
import type { TxClient } from '@taxtronik/db';
import {
  clientAnonymizationDeadline,
  isClientAnonymizationDue,
  findDueClientAnonymizations,
  CLIENT_ANONYMIZATION_YEARS,
  GOBD_RETENTION_YEARS,
} from '../client-retention';
import { anonymizeClientSideTablesInTx } from '../anonymize-client-data';

describe('clientAnonymizationDeadline — Art. 17 (Jahresende + längste Frist)', () => {
  it('Mandatsende 2026-03-15 → fällig ab 2037-01-01', () => {
    expect(clientAnonymizationDeadline(new Date('2026-03-15T10:00:00Z')).toISOString()).toBe(
      '2037-01-01T00:00:00.000Z',
    );
  });

  it('Jahresanfang zählt zum Vorjahres-Schluss: 2026-01-01 → 2037-01-01', () => {
    // Frist beginnt mit Schluss des Kalenderjahres 2026, nicht ab dem Tag.
    expect(clientAnonymizationDeadline(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe(
      '2037-01-01T00:00:00.000Z',
    );
  });

  it('Silvester 2026-12-31 → noch Kalenderjahr 2026 → 2037-01-01', () => {
    expect(clientAnonymizationDeadline(new Date('2026-12-31T23:59:00Z')).toISOString()).toBe(
      '2037-01-01T00:00:00.000Z',
    );
  });

  it('die längste Aufbewahrungsfrist gewinnt (GoBD 10 J. > GwG 5 J.)', () => {
    expect(GOBD_RETENTION_YEARS).toBe(10);
    expect(CLIENT_ANONYMIZATION_YEARS).toBe(10);
  });
});

describe('isClientAnonymizationDue', () => {
  const mandateEnd = new Date('2026-06-01T00:00:00Z'); // fällig ab 2037-01-01

  it('false ohne Mandatsende', () => {
    expect(isClientAnonymizationDue(null)).toBe(false);
    expect(isClientAnonymizationDue(undefined)).toBe(false);
  });

  it('false vor dem Stichtag (ein Tag davor)', () => {
    expect(isClientAnonymizationDue(mandateEnd, new Date('2036-12-31T23:59:59Z'))).toBe(false);
  });

  it('true am Stichtag', () => {
    expect(isClientAnonymizationDue(mandateEnd, new Date('2037-01-01T00:00:00Z'))).toBe(true);
  });

  it('true lange nach dem Stichtag', () => {
    expect(isClientAnonymizationDue(mandateEnd, new Date('2045-01-01T00:00:00Z'))).toBe(true);
  });
});

describe('findDueClientAnonymizations — Review-Queue (NATPERS, Fristablauf)', () => {
  const NOW = new Date('2037-06-01T00:00:00Z');

  function fakeTx(clients: unknown[]) {
    const findMany = vi.fn().mockResolvedValue(clients);
    return { tx: { client: { findMany } } as unknown as TxClient, findMany };
  }

  it('filtert auf NATPERS + nicht anonymisiert + Grobfilter, mappt Zähler', async () => {
    const mandateEnd = new Date('2026-06-01T00:00:00Z'); // fällig ab 2037-01-01
    const { tx, findMany } = fakeTx([
      {
        id: 'client-1',
        name: 'Max Mustermann',
        mandateEndedAt: mandateEnd,
        _count: { contacts: 2, documents: 1, gwgChecks: 1 },
      },
    ]);

    const out = await findDueClientAnonymizations(tx, NOW);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          kind: 'NATPERS',
          anonymizedAt: null,
          mandateEndedAt: { lt: new Date(Date.UTC(2027, 0, 1)) },
        },
      }),
    );
    expect(out).toEqual([
      {
        clientId: 'client-1',
        clientName: 'Max Mustermann',
        mandateEndedAt: mandateEnd,
        anonymizationDeadline: new Date('2037-01-01T00:00:00.000Z'),
        contacts: 2,
        openGwgItems: 2,
      },
    ]);
  });

  it('Mandat noch nicht fällig (exakte Jahresende-Rundung) → kein Item', async () => {
    // Grobfilter könnte den Client liefern; die exakte Prüfung verwirft ihn.
    const { tx } = fakeTx([
      {
        id: 'client-2',
        name: 'Erika Musterfrau',
        mandateEndedAt: new Date('2027-02-01T00:00:00Z'), // fällig erst ab 2038-01-01
        _count: { contacts: 0, documents: 0, gwgChecks: 0 },
      },
    ]);

    expect(await findDueClientAnonymizations(tx, NOW)).toEqual([]);
  });
});

describe('anonymizeClientSideTablesInTx — personentragende Nebentabellen (eine Tx)', () => {
  const CLIENT_ID = 'client-1';
  const CONTACT_IDS = ['contact-1', 'contact-2'];

  function fakeTx() {
    const tx = {
      powerOfAttorney: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      gwgOnboardingInvite: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      formSubmission: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
      appointment: { updateMany: vi.fn().mockResolvedValue({ count: 4 }) },
      appointmentRequest: { deleteMany: vi.fn().mockResolvedValue({ count: 5 }) },
      clientReminder: { updateMany: vi.fn().mockResolvedValue({ count: 6 }) },
      pendingBinder: { updateMany: vi.fn().mockResolvedValue({ count: 7 }) },
      clientHandover: { updateMany: vi.fn().mockResolvedValue({ count: 8 }) },
      riskAnalysis: { updateMany: vi.fn().mockResolvedValue({ count: 9 }) },
      riskMarking: { updateMany: vi.fn().mockResolvedValue({ count: 10 }) },
    };
    return { tx: tx as unknown as TxClient, mocks: tx };
  }

  it('nullt/ersetzt alle Klassen und liefert die Zähler fürs Audit-Event', async () => {
    const { tx, mocks } = fakeTx();

    const out = await anonymizeClientSideTablesInTx(tx, {
      clientId: CLIENT_ID,
      contactIds: CONTACT_IDS,
    });

    // Vollmachten: NOT-NULL-Felder → Platzhalter, IP/UA → null; nur DB-Felder
    // (die Dokumente unterliegen der Dokument-Retention).
    expect(mocks.powerOfAttorney.updateMany).toHaveBeenCalledWith({
      where: { clientId: CLIENT_ID },
      data: {
        signerName: 'Anonymisiert',
        signerEmail: 'anonymisiert@taxtronik.local',
        signedByIp: null,
        signedByUserAgent: null,
      },
    });
    // GwG-Invites zwecklos nach Fristablauf → löschen.
    expect(mocks.gwgOnboardingInvite.deleteMany).toHaveBeenCalledWith({
      where: { clientId: CLIENT_ID },
    });
    // Formular-Antworten: clientId ODER über Kontakte des Mandanten.
    expect(mocks.formSubmission.updateMany).toHaveBeenCalledWith({
      where: {
        OR: [{ clientId: CLIENT_ID }, { submittedByContact: { in: CONTACT_IDS } }],
      },
      data: { answers: { anonymized: true } },
    });
    expect(mocks.appointment.updateMany).toHaveBeenCalledWith({
      where: { clientId: CLIENT_ID },
      data: { title: 'Anonymisiert', notes: null, location: null },
    });
    // Terminanfragen (Portal-Kontakt) → löschen; appointment.from_request_id
    // ist ON DELETE SET NULL, abgeleitete Termine bleiben.
    expect(mocks.appointmentRequest.deleteMany).toHaveBeenCalledWith({
      where: { clientId: CLIENT_ID },
    });
    expect(mocks.clientReminder.updateMany).toHaveBeenCalledWith({
      where: { clientId: CLIENT_ID },
      data: { subject: 'Anonymisiert', notes: null },
    });
    expect(mocks.pendingBinder.updateMany).toHaveBeenCalledWith({
      where: { clientId: CLIENT_ID },
      data: { label: 'Anonymisiert', contents: null },
    });
    expect(mocks.clientHandover.updateMany).toHaveBeenCalledWith({
      where: { clientId: CLIENT_ID },
      data: { label: 'Anonymisiert', contents: null, notifiedContactEmail: null },
    });
    // Sachverhalt: sourceText NOT NULL → '', Rich-Doc-Kopie → DbNull;
    // Markierungen zitieren den Text wörtlich → mit-leeren.
    expect(mocks.riskAnalysis.updateMany).toHaveBeenCalledWith({
      where: { clientId: CLIENT_ID },
      data: { sourceText: '', sourceDoc: Prisma.DbNull },
    });
    expect(mocks.riskMarking.updateMany).toHaveBeenCalledWith({
      where: { analysis: { clientId: CLIENT_ID } },
      data: { matchedText: '', notiz: null },
    });

    expect(out).toEqual({
      poaSignersAnonymized: 2,
      gwgInvitesDeleted: 1,
      formSubmissionAnswersAnonymized: 3,
      appointmentsAnonymized: 4,
      appointmentRequestsDeleted: 5,
      remindersAnonymized: 6,
      pendingBindersAnonymized: 7,
      handoversAnonymized: 8,
      riskAnalysesCleared: 9,
      riskMarkingsCleared: 10,
    });
  });

  it('ohne Kontakte: Formular-Filter bleibt korrekt (leeres in-Array trifft nichts)', async () => {
    const { tx, mocks } = fakeTx();

    await anonymizeClientSideTablesInTx(tx, { clientId: CLIENT_ID, contactIds: [] });

    expect(mocks.formSubmission.updateMany).toHaveBeenCalledWith({
      where: { OR: [{ clientId: CLIENT_ID }, { submittedByContact: { in: [] } }] },
      data: { answers: { anonymized: true } },
    });
  });
});
