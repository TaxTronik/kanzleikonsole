import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CASE_KINDS } from './definitions';

export const ASSISTANCE_GENERATOR = 'client-assistance/1';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const AssistanceSnapshotSchema = z.object({
  version: z.literal(1),
  caseId: z.uuid(),
  title: z.string(),
  kind: z.enum(CASE_KINDS),
  revision: z.number().int().positive(),
  status: z.enum(['DRAFT', 'SUBMITTED', 'RETURNED', 'REVIEWED']),
  occurredAt: z.iso.datetime(),
  answers: z.record(z.string(), z.string()),
  schema: z.object({
    title: z.string(),
    version: z.number(),
    fields: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        required: z.boolean().optional(),
        type: z.enum(['date', 'text', 'textarea', 'money']).optional(),
      }),
    ),
  }),
  sourceVersionId: z.uuid().nullable(),
  sourceHash: z.string().nullable(),
  externalVersionId: z.uuid().nullable(),
  externalHash: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  reviewNote: z.string().nullable(),
  reviewedByStaff: z.uuid().nullable(),
});
export type AssistanceSnapshot = z.infer<typeof AssistanceSnapshotSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function assistanceSnapshotHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function checkedAssistanceSnapshot(raw: unknown, hash: string): AssistanceSnapshot {
  const parsed = AssistanceSnapshotSchema.parse(raw);
  if (assistanceSnapshotHash(parsed) !== hash)
    throw new Error('Revision snapshot integrity mismatch');
  return parsed;
}
export function buildAssistanceSnapshot(
  item: {
    id: string;
    title: string;
    kind: string;
    revision: number;
    status: string;
    answers: unknown;
    schemaSnapshot: unknown;
    sourceDocumentVersionId: string | null;
    sourceHash: string | null;
    externalDocumentVersionId: string | null;
    externalDocumentHash: string | null;
    confirmedAt: Date | null;
    reviewNote: string | null;
    reviewedByStaff: string | null;
  },
  occurredAt: Date,
): AssistanceSnapshot {
  return AssistanceSnapshotSchema.parse({
    version: 1,
    caseId: item.id,
    title: item.title,
    kind: item.kind,
    revision: item.revision,
    status: item.status,
    occurredAt: occurredAt.toISOString(),
    answers: item.answers,
    schema: item.schemaSnapshot,
    sourceVersionId: item.sourceDocumentVersionId,
    sourceHash: item.sourceHash,
    externalVersionId: item.externalDocumentVersionId,
    externalHash: item.externalDocumentHash,
    confirmedAt: item.confirmedAt?.toISOString() ?? null,
    reviewNote: item.reviewNote,
    reviewedByStaff: item.reviewedByStaff,
  });
}
