// Fachkatalog: GWG-SELF-ONBOARDING-001
// Zwischenstand je Einladung: nur Verweise auf eigene Uploads, kaputte Inhalte
// zählen nicht, und zwei Geräte überschreiben sich nie still (Revision).
import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import {
  OnboardingDraftPayloadSchema,
  draftDocumentIds,
  loadOnboardingDraftTx,
  sanitizeDraftDocuments,
  saveOnboardingDraftTx,
  type OnboardingDraftPayload,
} from '../draft';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function payload(): OnboardingDraftPayload {
  return {
    version: 1,
    step: 1,
    reached: 1,
    master: {
      companyName: 'Muster GmbH',
      street: 'Hauptstr. 1',
      postalCode: '36304',
      city: 'Alsfeld',
      countryIso: 'DE',
    },
    owners: [
      {
        id: 'owner-1',
        fullName: 'Erika Beispiel',
        birthDate: '',
        birthPlace: '',
        nationality: 'DE',
        street: '',
        postalCode: '',
        city: '',
        countryIso: 'DE',
        sharePercent: '',
        isPep: null,
        idType: 'PERSONALAUSWEIS',
        idNumber: '',
        idIssuedBy: '',
        idIssueDate: '',
        idExpiryDate: '',
        idFront: { documentId: uuid(1), fileName: 'vorne.jpg' },
        idBack: { documentId: uuid(9), fileName: 'fremd.jpg' },
      },
    ],
    representatives: [
      {
        id: 'representative-1',
        fullName: '',
        linkedOwnerId: 'owner-1',
        idType: 'PERSONALAUSWEIS',
        idNumber: '',
        idIssuedBy: '',
        idIssueDate: '',
        idExpiryDate: '',
        idFront: null,
        idBack: null,
      },
    ],
    extraDocuments: [
      { documentId: uuid(2), fileName: 'hr.pdf', type: 'HANDELSREGISTERAUSZUG' },
      { documentId: uuid(8), fileName: 'fremd.pdf', type: 'SONSTIGES' },
    ],
    noRegisterEntry: false,
  };
}

function fakeTx(row: { revision: number; payload: unknown } | null = null) {
  const draft = {
    findUnique: vi.fn(async () =>
      row ? { ...row, updatedAt: new Date('2026-10-22T08:00:00Z') } : null,
    ),
    createMany: vi.fn(async () => ({ count: 1 })),
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  return { tx: { gwgOnboardingDraft: draft } as unknown as TxClient, draft };
}

describe('Zwischenstand – Inhalt', () => {
  it('behält nur Dateiverweise dieser Einladung', () => {
    const cleaned = sanitizeDraftDocuments(payload(), new Set([uuid(1), uuid(2)]));
    expect(cleaned.owners[0]!.idFront).toEqual({ documentId: uuid(1), fileName: 'vorne.jpg' });
    expect(cleaned.owners[0]!.idBack).toBeNull();
    expect(cleaned.extraDocuments.map((document) => document.documentId)).toEqual([uuid(2)]);
  });

  it('nimmt die Belege des gebundenen Prüfentwurfs als erlaubte Verweise', () => {
    expect(
      draftDocumentIds({
        owners: [{ idFront: { documentId: uuid(1) }, idBack: null }],
        representatives: [{ idFront: null, idBack: { documentId: uuid(3) } }],
        extraDocuments: [{ documentId: uuid(2) }],
      }),
    ).toEqual([uuid(1), uuid(3), uuid(2)]);
    expect(draftDocumentIds(null)).toEqual([]);
  });

  it('lehnt fremde Formate, zu lange Werte und unbekannte Schritte ab', () => {
    expect(OnboardingDraftPayloadSchema.safeParse(payload()).success).toBe(true);
    expect(OnboardingDraftPayloadSchema.safeParse({ ...payload(), version: 2 }).success).toBe(
      false,
    );
    expect(OnboardingDraftPayloadSchema.safeParse({ ...payload(), step: 5 }).success).toBe(false);
    const tooLong = payload();
    tooLong.owners[0]!.fullName = 'x'.repeat(201);
    expect(OnboardingDraftPayloadSchema.safeParse(tooLong).success).toBe(false);
  });
});

describe('Zwischenstand – Laden', () => {
  it('liefert Revision, Zeitpunkt und bereinigten Inhalt', async () => {
    const { tx } = fakeTx({ revision: 4, payload: payload() });
    const loaded = await loadOnboardingDraftTx(tx, {
      inviteId: uuid(50),
      allowedDocumentIds: new Set([uuid(1)]),
    });
    expect(loaded).toMatchObject({ revision: 4, updatedAt: '2026-10-22T08:00:00.000Z' });
    expect(loaded!.payload.owners[0]!.idBack).toBeNull();
    expect(loaded!.payload.extraDocuments).toEqual([]);
  });

  it('ignoriert einen ungültigen gespeicherten Stand', async () => {
    const { tx } = fakeTx({ revision: 1, payload: { version: 99 } });
    expect(
      await loadOnboardingDraftTx(tx, { inviteId: uuid(50), allowedDocumentIds: new Set() }),
    ).toBeNull();
  });
});

describe('Zwischenstand – Speichern mit Revision', () => {
  const base = { inviteId: uuid(50), tenantId: uuid(60), payload: payload() };

  it('legt den ersten Stand mit Revision 1 an', async () => {
    const { tx, draft } = fakeTx();
    const result = await saveOnboardingDraftTx(tx, { ...base, expectedRevision: 0 });
    expect(result).toMatchObject({ ok: true, revision: 1 });
    expect(draft.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ inviteId: uuid(50), tenantId: uuid(60), revision: 1 })],
      skipDuplicates: true,
    });
  });

  it('meldet einen Konflikt, wenn ein anderes Gerät den ersten Stand schon angelegt hat', async () => {
    const { tx, draft } = fakeTx({ revision: 1, payload: payload() });
    draft.createMany.mockResolvedValue({ count: 0 });
    expect(await saveOnboardingDraftTx(tx, { ...base, expectedRevision: 0 })).toEqual({
      ok: false,
      conflict: true,
      revision: 1,
    });
  });

  it('schreibt nur auf die zuletzt gelesene Revision', async () => {
    const { tx, draft } = fakeTx({ revision: 3, payload: payload() });
    expect(await saveOnboardingDraftTx(tx, { ...base, expectedRevision: 3 })).toMatchObject({
      ok: true,
      revision: 4,
    });
    expect(draft.updateMany).toHaveBeenCalledWith({
      where: { inviteId: uuid(50), revision: 3 },
      data: expect.objectContaining({ revision: { increment: 1 } }),
    });

    draft.updateMany.mockResolvedValue({ count: 0 });
    draft.findUnique.mockResolvedValue({
      revision: 5,
      payload: payload(),
      updatedAt: new Date(),
    });
    expect(await saveOnboardingDraftTx(tx, { ...base, expectedRevision: 3 })).toEqual({
      ok: false,
      conflict: true,
      revision: 5,
    });
  });
});
