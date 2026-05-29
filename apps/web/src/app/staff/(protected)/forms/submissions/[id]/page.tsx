// =============================================================================
// /staff/forms/submissions/[id] — Antwort einer Form-Submission ansehen
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, FileText } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import type { FormFieldType } from '@prisma/client';
import { ReviewForm } from './review-form';
import { fmtDateShort, fmtDateTimeMedium, fmtEUR } from '@/lib/fmt';

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Ausstehend',
  DRAFT: 'Entwurf',
  SUBMITTED: 'Eingegangen',
  REVIEWED: 'Geprüft',
};


function renderValue(type: FormFieldType, value: unknown, fieldOptions: unknown): React.ReactNode {
  if (value === null || value === undefined || value === '') {
    return <span className="text-disabled">—</span>;
  }
  if (type === 'CHECKBOX') {
    return value ? '✓ Ja' : 'Nein';
  }
  if (type === 'MONEY' && typeof value === 'number') {
    return fmtEUR(value);
  }
  if (type === 'DATE' && typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return fmtDateShort(d);
  }
  if (type === 'MULTISELECT' && Array.isArray(value)) {
    if (value.length === 0) return <span className="text-disabled">—</span>;
    return value.map((v) => labelForOption(fieldOptions, v)).join(', ');
  }
  if (type === 'SELECT' && typeof value === 'string') {
    return labelForOption(fieldOptions, value);
  }
  if (type === 'FILE' && typeof value === 'object' && value !== null) {
    const r = value as { documentId?: string; fileName?: string };
    if (r.documentId) {
      return (
        <a
          href={`/api/staff/documents/${r.documentId}/download`}
          className="inline-flex items-center gap-1 text-brand-700 hover:underline"
        >
          <FileText className="h-3 w-3" /> {r.fileName ?? 'Datei'}
        </a>
      );
    }
  }
  if (type === 'TEXTAREA' && typeof value === 'string') {
    return <span className="whitespace-pre-wrap">{value}</span>;
  }
  return String(value);
}

function labelForOption(opts: unknown, value: string): string {
  if (Array.isArray(opts)) {
    for (const o of opts) {
      if (typeof o === 'object' && o !== null) {
        const r = o as { value?: unknown; label?: unknown };
        if (String(r.value ?? '') === value) return String(r.label ?? value);
      }
    }
  }
  return value;
}

export default async function SubmissionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const sub = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.formSubmission.findUnique({
        where: { id },
        include: {
          client: { select: { id: true, name: true } },
          template: {
            include: { fields: { orderBy: { position: 'asc' } } },
          },
        },
      }),
  );
  if (!sub) notFound();

  const answers = (sub.answers as Record<string, unknown>) ?? {};

  return (
    <div className="p-8 max-w-3xl">
      <Link href={`/staff/clients/${sub.client.id}/forms`} className="back-link">
        <ArrowLeft className="h-4 w-4" /> Zurück
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary mb-1">{sub.name}</h1>
        <p className="text-muted text-sm">
          {sub.client.name} · versendet {fmtDateTimeMedium(sub.createdAt)}
          {sub.submittedAt && ` · eingegangen ${fmtDateTimeMedium(sub.submittedAt)}`}
        </p>
        <div className="mt-2">
          {sub.status === 'PENDING' && <span className="badge-yellow">{STATUS_LABELS[sub.status]}</span>}
          {sub.status === 'DRAFT' && <span className="badge-yellow">{STATUS_LABELS[sub.status]}</span>}
          {sub.status === 'SUBMITTED' && <span className="badge-green">{STATUS_LABELS[sub.status]}</span>}
          {sub.status === 'REVIEWED' && <span className="badge-gray">{STATUS_LABELS[sub.status]}</span>}
        </div>
      </div>

      <div className="card overflow-hidden">
        <dl className="divide-y divide-border-subtle">
          {sub.template.fields.map((f) => {
            if (f.type === 'INFO_TEXT') {
              return (
                <div key={f.id} className="px-6 py-3 bg-gray-50">
                  <p className="text-sm text-secondary whitespace-pre-wrap">{f.label}</p>
                </div>
              );
            }
            return (
              <div key={f.id} className="grid grid-cols-3 px-6 py-3 gap-4">
                <dt className="text-sm text-muted">{f.label}</dt>
                <dd className="col-span-2 text-sm text-primary">
                  {renderValue(f.type, answers[f.key], f.options)}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>

      {sub.status === 'SUBMITTED' && (
        <div className="mt-6">
          <ReviewForm id={sub.id} />
        </div>
      )}

      {sub.status === 'REVIEWED' && sub.reviewNotes && (
        <div className="card p-4 mt-6">
          <p className="text-xs text-muted uppercase mb-1">Prüfnotiz</p>
          <p className="text-sm text-secondary whitespace-pre-wrap">{sub.reviewNotes}</p>
        </div>
      )}
    </div>
  );
}
