import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export const PoaSigningSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    subject: z.string().min(1).max(300),
    signerName: z.string().min(1).max(200),
    signerEmail: z.string().email().max(255),
    validFrom: z.string().regex(DATE_ONLY),
    validUntil: z.string().regex(DATE_ONLY).nullable(),
    scope: z.string().max(20_000).nullable(),
    document: z
      .object({
        documentId: z.string().uuid(),
        versionId: z.string().uuid(),
        sha256: z.string().regex(SHA256_HEX),
      })
      .nullable(),
  })
  .superRefine((value, ctx) => {
    if ((value.scope === null) === (value.document === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Der Snapshot muss genau einen Text- oder Dokumentinhalt enthalten.',
      });
    }
    if (value.validUntil && value.validUntil < value.validFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['validUntil'],
        message: 'Das Gültig-bis-Datum darf nicht vor dem Gültig-ab-Datum liegen.',
      });
    }
  });

export type PoaSigningSnapshot = z.infer<typeof PoaSigningSnapshotSchema>;

type SnapshotInput = {
  subject: string;
  signerName: string;
  signerEmail: string;
  validFrom: Date;
  validUntil: Date | null;
  scope: string;
  document: {
    documentId: string;
    versionId: string;
    sha256: Uint8Array;
  } | null;
};

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function buildPoaSigningSnapshot(input: SnapshotInput): {
  snapshot: PoaSigningSnapshot;
  serialized: string;
  sha256: Buffer;
} {
  const snapshot = PoaSigningSnapshotSchema.parse({
    schemaVersion: 1,
    subject: input.subject,
    signerName: input.signerName,
    signerEmail: input.signerEmail,
    validFrom: dateOnly(input.validFrom),
    validUntil: input.validUntil ? dateOnly(input.validUntil) : null,
    scope: input.document ? null : input.scope,
    document: input.document
      ? {
          documentId: input.document.documentId,
          versionId: input.document.versionId,
          sha256: Buffer.from(input.document.sha256).toString('hex'),
        }
      : null,
  });
  const serialized = JSON.stringify(snapshot);
  return {
    snapshot,
    serialized,
    sha256: createHash('sha256').update(serialized, 'utf8').digest(),
  };
}

export function readPoaSigningSnapshot(
  serialized: string | null | undefined,
  expectedSha256: Uint8Array | null | undefined,
): PoaSigningSnapshot | null {
  if (!serialized || !expectedSha256 || expectedSha256.byteLength !== 32) return null;

  const actual = createHash('sha256').update(serialized, 'utf8').digest();
  const expected = Buffer.from(expectedSha256);
  if (!timingSafeEqual(actual, expected)) return null;

  try {
    const parsed = PoaSigningSnapshotSchema.safeParse(JSON.parse(serialized));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * @db.Date values are represented as UTC midnight. The product treats a PoA as
 * valid through the complete validUntil day in Europe/Berlin, so it expires
 * only when validUntil is before today's Berlin calendar date.
 */
export function berlinTodayUtcMidnight(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return new Date(Date.UTC(value('year'), value('month') - 1, value('day')));
}

export function isPoaExpired(validUntil: Date | string | null, now = new Date()): boolean {
  if (!validUntil) return false;
  const date =
    typeof validUntil === 'string' ? new Date(`${validUntil}T00:00:00.000Z`) : validUntil;
  return date.getTime() < berlinTodayUtcMidnight(now).getTime();
}

export function snapshotDocumentMatches(
  snapshot: PoaSigningSnapshot,
  version: { id: string; documentId: string; sha256: Uint8Array } | null,
): boolean {
  if (!snapshot.document) return version === null;
  if (!version) return false;
  return (
    version.id === snapshot.document.versionId &&
    version.documentId === snapshot.document.documentId &&
    Buffer.from(version.sha256).toString('hex') === snapshot.document.sha256
  );
}
