// =============================================================================
// /portal/forms/[id] — Mandant füllt Formular aus
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { renderSafeMarkdown } from '@/server/markdown';
import { PortalFormFiller } from './filler';
import { readFormSchema } from '@/server/forms/schema-snapshot';
import { FormRevisionHistory } from '@/components/form-revision-history';

export default async function PortalFormFillerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');
  const { id } = await params;
  const { tenantId, contactId, clientId } = session.user;

  const sub = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    async (tx) => {
      const submission = await tx.formSubmission.findUnique({
        where: { id },
        include: {
          revisions: { include: { files: true }, orderBy: { sequence: 'desc' } },
          template: { include: { fields: { orderBy: { position: 'asc' } } } },
          requests: {
            where: { tenantId, clientId },
            select: { id: true, status: true },
            orderBy: { id: 'asc' },
          },
        },
      });
      if (!submission) return null;
      const linkedRequests = submission.requestId
        ? submission.requests.filter((request) => request.id === submission.requestId)
        : submission.requests;
      return {
        ...submission,
        linkedRequests,
        linkedRequestMissing: Boolean(submission.requestId && linkedRequests.length !== 1),
      };
    },
  );
  if (!sub) notFound();
  if (sub.clientId !== clientId) notFound();
  const formSchema = readFormSchema(sub.schemaSnapshot, sub.template);

  const submitted = sub.status === 'SUBMITTED' || sub.status === 'REVIEWED';
  const requestClosed =
    sub.linkedRequestMissing ||
    sub.linkedRequests.some((request) => !['OPEN', 'IN_PROGRESS'].includes(request.status));

  return (
    <div className="p-8 max-w-3xl">
      <Link href="/portal/forms" className="back-link">
        <ArrowLeft className="h-4 w-4" /> Zurück
      </Link>

      <h1 className="text-2xl font-bold text-primary mb-1">{sub.name}</h1>
      {sub.status === 'DRAFT' && sub.submittedAt && sub.requestId && (
        <p className="card border-amber-300 p-4 mb-4">
          Die Kanzlei bittet um Ergänzung des bereits eingereichten Formulars.{' '}
          <Link className="underline" href={'/portal/requests/' + sub.requestId}>
            Rückfrage in der zugehörigen Anforderung lesen
          </Link>
          . Bitte danach erneut einreichen.
        </p>
      )}
      {!sub.schemaSnapshot && (
        <p className="text-sm text-muted">
          Altbestand: Ein historischer Vorlagenstand ist nicht gespeichert.
        </p>
      )}
      {formSchema.description && (
        <p className="text-muted text-sm mb-4">{formSchema.description}</p>
      )}

      {formSchema.introMd && (
        // W-4: Feld heißt introMd — also auch als Markdown rendern.
        // `renderSafeMarkdown` läuft auf admin-controlled Input (Form-Template-
        // Editor), HTML-escaped vorab, und erzeugt eine kuratierte Tag-Liste
        // (`p`, `br`, `strong`, `em`, `ul`, `li`, `a`). Sicher für
        // dangerouslySetInnerHTML in genau diesem Trust-Boundary-Kontext.
        <div
          className="card p-4 mb-6 text-sm text-secondary prose prose-sm max-w-none"
          dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(formSchema.introMd) }}
        />
      )}

      <PortalFormFiller
        submissionId={sub.id}
        submitted={submitted}
        requestClosed={requestClosed}
        initialAnswers={(sub.answers as Record<string, unknown>) ?? {}}
        fields={formSchema.fields.map((f) => ({
          id: f.id,
          key: f.key,
          label: f.label,
          type: f.type,
          required: f.required,
          helpText: f.helpText,
          defaultValue: f.defaultValue,
          minValue: f.minValue,
          maxValue: f.maxValue,
          options: f.options as Array<{ value: string; label: string }> | null,
        }))}
      />
      <FormRevisionHistory rows={sub.revisions} surface="portal" />
    </div>
  );
}
