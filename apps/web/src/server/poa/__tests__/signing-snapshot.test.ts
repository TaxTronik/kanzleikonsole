// Fachkatalog: POA-SIGNING-SNAPSHOT-001
import { describe, expect, it } from 'vitest';
import {
  buildPoaSigningSnapshot,
  isPoaExpired,
  readPoaSigningSnapshot,
  snapshotDocumentMatches,
} from '../signing-snapshot';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';

describe('PoA-Versand-Snapshot', () => {
  it('bindet eine exakte Dokumentversion und deren SHA-256', () => {
    const documentSha256 = Buffer.alloc(32, 0xab);
    const built = buildPoaSigningSnapshot({
      subject: 'Vollmacht Finanzamt',
      signerName: 'Sina Signer',
      signerEmail: 'signer@example.de',
      validFrom: new Date('2026-08-01T00:00:00.000Z'),
      validUntil: new Date('2027-08-01T00:00:00.000Z'),
      scope: 'wird bei PDF nicht verwendet',
      document: {
        documentId: DOCUMENT_ID,
        versionId: VERSION_ID,
        sha256: documentSha256,
      },
    });

    const parsed = readPoaSigningSnapshot(built.serialized, built.sha256);
    expect(parsed?.document).toEqual({
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      sha256: documentSha256.toString('hex'),
    });
    expect(
      snapshotDocumentMatches(parsed!, {
        id: VERSION_ID,
        documentId: DOCUMENT_ID,
        sha256: documentSha256,
      }),
    ).toBe(true);
    expect(
      snapshotDocumentMatches(parsed!, {
        id: VERSION_ID,
        documentId: DOCUMENT_ID,
        sha256: Buffer.alloc(32, 0xcd),
      }),
    ).toBe(false);
  });

  it('verwirft jede nachträgliche Änderung des serialisierten Inhalts', () => {
    const built = buildPoaSigningSnapshot({
      subject: 'Vollmacht Finanzamt',
      signerName: 'Sina Signer',
      signerEmail: 'signer@example.de',
      validFrom: new Date('2026-08-01T00:00:00.000Z'),
      validUntil: null,
      scope: 'Vertretung gegenüber dem Finanzamt',
      document: null,
    });
    const tampered = built.serialized.replace('Finanzamt', 'Finanzgericht');
    expect(readPoaSigningSnapshot(tampered, built.sha256)).toBeNull();
  });
});

describe('PoA-Ablauftag', () => {
  it('ist am validUntil-Tag noch gültig und erst am Folgetag abgelaufen', () => {
    const validUntil = new Date('2026-08-01T00:00:00.000Z');
    expect(isPoaExpired(validUntil, new Date('2026-08-01T21:59:59.000Z'))).toBe(false);
    expect(isPoaExpired(validUntil, new Date('2026-08-01T22:00:00.000Z'))).toBe(true);
  });
});
