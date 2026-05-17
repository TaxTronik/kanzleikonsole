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

export default async function PortalFormFillerPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');
  const { id } = await params;
  const { tenantId, contactId, clientId } = session.user;

  const sub = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    (tx) =>
      tx.formSubmission.findUnique({
        where: { id },
        include: {
          template: { include: { fields: { orderBy: { position: 'asc' } } } },
        },
      }),
  );
  if (!sub) notFound();
  if (sub.clientId !== clientId) notFound();

  const submitted = sub.status === 'SUBMITTED' || sub.status === 'REVIEWED';

  return (
    <div className="p-8 max-w-3xl">
      <Link href="/portal/forms" className="text-sm text-gray-500 hover:text-gray-900 inline-flex items-center gap-1 mb-4">
        <ArrowLeft className="h-4 w-4" /> Zurück
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">{sub.name}</h1>
      {sub.template.description && (
        <p className="text-gray-500 text-sm mb-4">{sub.template.description}</p>
      )}

      {sub.template.introMd && (
        // W-4: Feld heißt introMd — also auch als Markdown rendern.
        // `renderSafeMarkdown` läuft auf admin-controlled Input (Form-Template-
        // Editor), HTML-escaped vorab, und erzeugt eine kuratierte Tag-Liste
        // (`p`, `br`, `strong`, `em`, `ul`, `li`, `a`). Sicher für
        // dangerouslySetInnerHTML in genau diesem Trust-Boundary-Kontext.
        <div
          className="card p-4 mb-6 text-sm text-gray-700 prose prose-sm max-w-none"
          dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(sub.template.introMd) }}
        />
      )}

      <PortalFormFiller
        submissionId={sub.id}
        submitted={submitted}
        initialAnswers={(sub.answers as Record<string, unknown>) ?? {}}
        fields={sub.template.fields.map((f) => ({
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
    </div>
  );
}
