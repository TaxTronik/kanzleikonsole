import 'server-only';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import {
  prepareBytesCommitWithTier,
  commitPreparedBytes,
  recoverPreparedBytesCommit,
  s3,
  MAX_UPLOAD_BYTES,
  type PreparedBytesCommit,
} from '@taxtronik/storage';
import { payrollTx, type PayrollSurface } from './service';
import { requireGuestHash, guestRead, withPayrollCapability } from './capability';
import { ActionError } from '@/server/actions/action-error';
import type { PayrollIntake } from '@prisma/client';
export type PayrollFile = {
  id: string;
  tenantId: string;
  intakeId: string;
  audience: string;
  revision: number;
  filename: string;
  mimeType: string;
  status: string;
  storageBucket: string;
  storageKey: string;
  storageVersionId: string | null;
  sha256: string;
  sizeBytes: bigint;
};
const rawFile = z.object({
  id: z.uuid(),
  tenant_id: z.uuid(),
  intake_id: z.uuid(),
  audience: z.string(),
  revision: z.number(),
  filename: z.string(),
  mime_type: z.string(),
  status: z.string(),
  storage_bucket: z.string(),
  storage_key: z.string(),
  storage_version_id: z.string().nullable(),
  sha256: z.string(),
  size_bytes: z.union([z.number(), z.string()]),
});
function fromGuest(raw: unknown): PayrollFile {
  const a = rawFile.parse(raw);
  return {
    id: a.id,
    tenantId: a.tenant_id,
    intakeId: a.intake_id,
    audience: a.audience,
    revision: a.revision,
    filename: a.filename,
    mimeType: a.mime_type,
    status: a.status,
    storageBucket: a.storage_bucket,
    storageKey: a.storage_key,
    storageVersionId: a.storage_version_id,
    sha256: a.sha256,
    sizeBytes: BigInt(a.size_bytes),
  };
}
export async function getPayrollFile(
  surface: PayrollSurface | 'employee',
  id: string,
  intakeId?: string,
): Promise<PayrollFile> {
  if (surface === 'employee') {
    const hash = await requireGuestHash();
    const result = await withPayrollCapability(
      async (tx) =>
        (
          await tx.$queryRaw<
            Array<{ data: unknown }>
          >`SELECT app.payroll_guest_attachment(${hash},${id}::uuid) AS data`
        )[0]?.data,
    );
    if (!result) throw new ActionError('Anlage nicht verfügbar.');
    return fromGuest(result);
  }
  if (!intakeId) throw new ActionError('Vorgang fehlt.');
  return payrollTx(surface, intakeId, async (tx, item) => {
    const a = await tx.payrollAttachment.findFirst({ where: { id, intakeId: item.id } });
    if (!a) throw new ActionError('Anlage nicht verfügbar.');
    return a;
  });
}
export class PayrollUploadError extends Error {
  constructor(readonly pendingId: string) {
    super(
      'Upload gespeichert, aber noch nicht abgeschlossen. Dieselbe Datei mit dieser Upload-ID erneut versuchen: ' +
        pendingId,
    );
  }
}

type PersistPayrollFileInput = {
  surface: PayrollSurface | 'employee';
  intakeId: string;
  filename: string;
  bytes: () => Promise<Buffer>;
  resumeId?: string;
  artifact?: boolean;
  expectedRevision?: number;
  onJournal?: (row: PayrollFile) => Promise<void>;
};
type PendingPayrollUpload = {
  row: PayrollFile;
  prepared: PreparedBytesCommit;
  bytes?: Buffer;
};

function assertPayrollArtifactInput(input: PersistPayrollFileInput): void {
  if (input.artifact && (input.surface !== 'staff' || input.expectedRevision === undefined))
    throw new ActionError('Prüfexport benötigt einen gebundenen Kanzleistand.');
}

async function resumedPayrollUpload(input: PersistPayrollFileInput): Promise<PendingPayrollUpload> {
  const row = await getPayrollFile(input.surface, input.resumeId!, input.intakeId);
  return {
    row,
    prepared: {
      tenantId: row.tenantId,
      tier: 'NONE',
      targetBucket: row.storageBucket,
      targetKey: row.storageKey,
      sha256: Buffer.from(row.sha256, 'hex'),
      sizeBytes: row.sizeBytes,
      immutable: false,
      retentionUntil: null,
      detectedMime: row.mimeType,
    },
  };
}

function payrollUploadValues(input: PersistPayrollFileInput, prepared: PreparedBytesCommit) {
  return {
    filename: [...input.filename]
      .map((character) =>
        character.charCodeAt(0) < 32 || character === '/' || character === '\\' ? '_' : character,
      )
      .join('')
      .slice(0, 180),
    mimeType: prepared.detectedMime!,
    storageBucket: prepared.targetBucket,
    storageKey: prepared.targetKey,
    sha256: prepared.sha256.toString('hex'),
    sizeBytes: prepared.sizeBytes.toString(),
  };
}

function assertPayrollUploadMime(
  input: PersistPayrollFileInput,
  detectedMime: string | null,
): void {
  const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
  if (input.artifact) allowed.push('application/zip');
  if (!allowed.includes(detectedMime ?? ''))
    throw new ActionError('Nur PDF, PNG oder JPEG zulässig.');
}

function assertStaffPayrollUploadOpen(item: PayrollIntake, input: PersistPayrollFileInput): void {
  if (
    item.revokedAt ||
    (!input.artifact &&
      (!['DRAFT', 'RETURNED'].includes(item.status) || item.expiresAt <= new Date()))
  )
    throw new ActionError('Vorgang nicht mehr für Uploads offen.');
  if (input.artifact && item.status !== 'REVIEWED')
    throw new ActionError('PDF/ZIP erst nach Kanzleiprüfung.');
  if (input.artifact && item.revision !== input.expectedRevision)
    throw new ActionError('Prüfstand wurde geändert.');
  if (input.surface === 'portal' && item.employerConfirmedAt)
    throw new ActionError('Arbeitgeberteil bereits bestätigt.');
}

async function createGuestPayrollUploadRow(
  values: ReturnType<typeof payrollUploadValues>,
): Promise<PayrollFile> {
  const hash = await requireGuestHash();
  const id = await withPayrollCapability(
    async (tx) =>
      (
        await tx.$queryRaw<
          Array<{ id: string | null }>
        >`SELECT app.payroll_guest_upload_intent(${hash},${JSON.stringify(values)}::jsonb) AS id`
      )[0]?.id,
  );
  if (!id) throw new ActionError('Upload nicht mehr möglich.');
  return getPayrollFile('employee', id);
}

async function createStaffPayrollUploadRow(
  input: PersistPayrollFileInput,
  prepared: PreparedBytesCommit,
  values: ReturnType<typeof payrollUploadValues>,
): Promise<PayrollFile> {
  return payrollTx(input.surface as PayrollSurface, input.intakeId, async (tx, item, g) => {
    assertStaffPayrollUploadOpen(item, input);
    if ((await tx.payrollAttachment.count({ where: { intakeId: item.id } })) >= 60)
      throw new ActionError('Anlagenlimit erreicht.');
    return tx.payrollAttachment.create({
      data: {
        ...values,
        sizeBytes: prepared.sizeBytes,
        tenantId: g.tenantId,
        intakeId: item.id,
        audience: input.surface === 'portal' ? 'EMPLOYER' : 'STAFF',
        uploadedBy: g.ctx.actorId!,
        revision: item.revision,
      },
    });
  });
}

async function newPayrollUpload(input: PersistPayrollFileInput): Promise<PendingPayrollUpload> {
  const guest = input.surface === 'employee' ? await guestRead() : null;
  if (input.surface === 'employee' && (!guest || guest.id !== input.intakeId))
    throw new ActionError('Zugang abgelaufen.');
  const tenantId =
    guest?.tenantId ??
    (await payrollTx(
      input.surface as PayrollSurface,
      input.intakeId,
      async (_tx, item) => item.tenantId,
    ));
  const bytes = await input.bytes();
  if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES)
    throw new ActionError('Datei muss zwischen 1 Byte und 25 MiB groß sein.');
  const prepared = await prepareBytesCommitWithTier({ tenantId, fileData: bytes, tier: 'NONE' });
  assertPayrollUploadMime(input, prepared.detectedMime);
  const values = payrollUploadValues(input, prepared);
  const row =
    input.surface === 'employee'
      ? await createGuestPayrollUploadRow(values)
      : await createStaffPayrollUploadRow(input, prepared, values);
  return { row, prepared, bytes };
}

function assertStaffPayrollFinalizationAllowed(
  item: PayrollIntake,
  input: PersistPayrollFileInput,
  row: PayrollFile,
): void {
  if (item.revokedAt) throw new ActionError('Upload nicht mehr für diesen Stand zulässig.');
  if (input.artifact) {
    if (
      item.status !== 'REVIEWED' ||
      item.revision !== input.expectedRevision ||
      row.revision !== item.revision
    )
      throw new ActionError('Upload nicht mehr für diesen Stand zulässig.');
    return;
  }
  if (
    !['DRAFT', 'RETURNED'].includes(item.status) ||
    item.expiresAt <= new Date() ||
    (input.surface === 'portal' && !!item.employerConfirmedAt)
  )
    throw new ActionError('Upload nicht mehr für diesen Stand zulässig.');
}

async function finishPayrollUpload(
  input: PersistPayrollFileInput,
  row: PayrollFile,
  storageVersionId: string,
): Promise<void> {
  if (input.surface === 'employee') {
    const hash = await requireGuestHash();
    const done = await withPayrollCapability(
      async (tx) =>
        (
          await tx.$queryRaw<
            Array<{ done: boolean }>
          >`SELECT app.payroll_guest_upload_finish(${hash},${row.id}::uuid,${storageVersionId}) AS done`
        )[0]?.done,
    );
    if (!done) throw new Error('Finalize denied');
    return;
  }
  await payrollTx(input.surface, input.intakeId, async (tx, item) => {
    assertStaffPayrollFinalizationAllowed(item, input, row);
    const updated = await tx.payrollAttachment.updateMany({
      where: {
        id: row.id,
        intakeId: item.id,
        status: 'PENDING',
        revision: row.revision,
        sha256: row.sha256,
      },
      data: { status: 'COMPLETE', storageVersionId },
    });
    if (updated.count !== 1) throw new ActionError('Upload wurde zwischenzeitlich geändert.');
  });
}

async function commitPayrollUpload(
  input: PersistPayrollFileInput,
  pending: PendingPayrollUpload,
): Promise<PayrollFile> {
  await input.onJournal?.(pending.row);
  const existing = await recoverPreparedBytesCommit(pending.prepared);
  const commit =
    existing ??
    (await commitPreparedBytes({
      prepared: pending.prepared,
      fileData: pending.bytes ?? (await input.bytes()),
    }));
  if (!commit.storageVersionId) throw new Error('Missing storage version');
  await finishPayrollUpload(input, pending.row, commit.storageVersionId);
  return { ...pending.row, status: 'COMPLETE', storageVersionId: commit.storageVersionId };
}

export async function persistPayrollFile(input: PersistPayrollFileInput): Promise<PayrollFile> {
  assertPayrollArtifactInput(input);
  const pending = input.resumeId
    ? await resumedPayrollUpload(input)
    : await newPayrollUpload(input);
  if (pending.row.status === 'COMPLETE') return pending.row;
  try {
    return await commitPayrollUpload(input, pending);
  } catch {
    throw new PayrollUploadError(pending.row.id);
  }
}
export async function payrollFileBytes(row: PayrollFile): Promise<Buffer> {
  if (row.status !== 'COMPLETE' || !row.storageVersionId)
    throw new ActionError('Anlage noch nicht verfügbar.');
  const object = await s3.send(
    new GetObjectCommand({
      Bucket: row.storageBucket,
      Key: row.storageKey,
      VersionId: row.storageVersionId,
    }),
  );
  if (!object.Body) throw new ActionError('Datei nicht verfügbar.');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const part of object.Body as AsyncIterable<Uint8Array>) {
    const b = Buffer.from(part);
    length += b.length;
    if (length > MAX_UPLOAD_BYTES) throw new ActionError('Datei zu groß.');
    chunks.push(b);
  }
  const bytes = Buffer.concat(chunks);
  if (
    BigInt(length) !== row.sizeBytes ||
    createHash('sha256').update(bytes).digest('hex') !== row.sha256
  )
    throw new ActionError('Dateiintegrität konnte nicht bestätigt werden.');
  return bytes;
}
