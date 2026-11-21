// =============================================================================
// /staff/workflows/templates — Workflow-Vorlagen-Verwaltung
//
// Liste aller Vorlagen, Anlegen einer neuen, Bearbeiten + Aktivieren/
// Deaktivieren einzelner. Detail-Editor unter /staff/workflows/templates/[id].
// =============================================================================

import Link from 'next/link';
import { Workflow, Plus, FileText, ArrowLeft } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { requireModulePage } from '@/server/settings/module-page';
import { withTenantContext } from '@taxtronik/db';
import { CreateTemplateForm } from './create-form';
import { ToggleActiveForm, DeleteTemplateForm } from './row-forms';
import { QuickStartButton } from '../quick-start-button';

export default async function WorkflowsPage() {
  const session = await requireStaffPage();
  await requireModulePage('staff', 'workflows');
  const { tenantId, staffId } = session.user;

  // Die Mandantenauswahl im Startdialog sucht serverseitig (mit Zugriffsregel);
  // früher wurde hier der gesamte Bestand ohne Sichtbarkeitsfilter geladen.
  const templates = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.workflowTemplate.findMany({
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
        include: {
          _count: { select: { steps: true, instances: true } },
          defaultSkill: { select: { label: true } },
        },
      }),
  );

  return (
    <div className="p-4 sm:p-8 max-w-5xl">
      <Link href="/staff/admin" className="back-link mb-3">
        <ArrowLeft className="h-3 w-3" />
        Administration
      </Link>
      <div className="mb-6">
        <h1 className="page-title">
          <Workflow className="h-6 w-6 text-brand-600" />
          Workflow-Vorlagen
        </h1>
        <p className="text-muted text-sm">
          Wiederkehrende Prozesse als Vorlage definieren — pro Mandant instanziierbar, Schritte
          werden Mitarbeitern zugewiesen und abgehakt. Laufende Vorgänge unter{' '}
          <Link href="/staff/workflows" className="text-brand-700 underline underline-offset-2">
            Workflows
          </Link>
          .
        </p>
      </div>

      <details className="card p-6 mb-6">
        <summary className="cursor-pointer text-sm font-medium text-primary flex items-center gap-2">
          <Plus className="h-4 w-4" />
          Neue Vorlage anlegen
        </summary>
        <div className="mt-4">
          <CreateTemplateForm />
        </div>
      </details>

      {templates.length === 0 ? (
        <div className="card p-10 text-center">
          <FileText className="h-10 w-10 text-disabled dark:text-secondary mx-auto mb-3" />
          <p className="text-sm text-disabled">
            Noch keine Vorlagen. Lege eine an — z. B. „Neuer Mandant" oder „Jahresabschluss".
          </p>
        </div>
      ) : (
        <ul className="card divide-y divide-border-subtle">
          {templates.map((t) => (
            <li key={t.id} className="space-y-3 p-4 sm:p-5">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                <Link
                  href={`/staff/workflows/templates/${t.id}`}
                  className="min-w-0 break-words font-medium text-primary hover:underline"
                >
                  {t.name}
                </Link>
                <span className={t.active ? 'badge-green' : 'badge-gray'}>
                  {t.active ? 'Aktiv' : 'Deaktiviert'}
                </span>
              </div>
              {t.description && <p className="break-words text-sm text-muted">{t.description}</p>}
              <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary">
                <div className="flex gap-1">
                  <dt>Schritte</dt>
                  <dd>{t._count.steps}</dd>
                </div>
                <div className="flex gap-1">
                  <dt>Instanzen</dt>
                  <dd>{t._count.instances}</dd>
                </div>
                {t.defaultSkill && (
                  <div className="flex gap-1">
                    <dt>Bereich</dt>
                    <dd>{t.defaultSkill.label}</dd>
                  </div>
                )}
              </dl>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {t.active && t._count.steps > 0 && (
                  <QuickStartButton templateId={t.id} templateName={t.name} />
                )}
                <Link
                  href={`/staff/workflows/templates/${t.id}`}
                  className="text-xs text-brand-700 hover:underline"
                >
                  Bearbeiten
                </Link>
                <ToggleActiveForm id={t.id} active={t.active} />
                <DeleteTemplateForm id={t.id} name={t.name} instances={t._count.instances} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
