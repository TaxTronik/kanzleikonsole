// =============================================================================
// /staff/workflows/templates — Workflow-Vorlagen-Verwaltung
//
// Liste aller Vorlagen, Anlegen einer neuen, Bearbeiten + Aktivieren/
// Deaktivieren einzelner. Detail-Editor unter /staff/workflows/templates/[id].
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Workflow, Plus, FileText, ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { CreateTemplateForm } from './create-form';
import { ToggleActiveForm, DeleteTemplateForm } from './row-forms';
import { QuickStartButton } from '../quick-start-button';

export default async function WorkflowsPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { tenantId, staffId } = session.user;

  const [templates, clients] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.workflowTemplate.findMany({
          orderBy: [{ active: 'desc' }, { name: 'asc' }],
          include: {
            _count: { select: { steps: true, instances: true } },
            defaultSkill: { select: { label: true } },
          },
        }),
        tx.client.findMany({
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
      ]),
  );

  return (
    <div className="p-8 max-w-5xl">
      <Link
        href="/staff/admin"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3"
      >
        <ArrowLeft className="h-3 w-3" />
        Administration
      </Link>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1 flex items-center gap-2">
          <Workflow className="h-6 w-6 text-brand-600" />
          Workflow-Vorlagen
        </h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          Wiederkehrende Prozesse als Vorlage definieren — pro Mandant
          instanziierbar, Schritte werden Mitarbeitern zugewiesen und abgehakt.
          Laufende Vorgänge unter <Link href="/staff/workflows" className="text-brand-700 hover:underline">Workflows</Link>.
        </p>
      </div>

      <details className="card p-6 mb-6">
        <summary className="cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <Plus className="h-4 w-4" />
          Neue Vorlage anlegen
        </summary>
        <div className="mt-4">
          <CreateTemplateForm />
        </div>
      </details>

      {templates.length === 0 ? (
        <div className="card p-10 text-center">
          <FileText className="h-10 w-10 text-gray-200 dark:text-gray-700 mx-auto mb-3" />
          <p className="text-sm text-gray-400">
            Noch keine Vorlagen. Lege eine an — z. B. „Neuer Mandant" oder „Jahresabschluss".
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-800">
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Vorlage</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Schritte</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Bereich</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Instanzen</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="text-right px-6 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {templates.map((t) => (
                <tr key={t.id} className={t.active ? 'hover:bg-gray-50 dark:hover:bg-gray-900/40' : 'opacity-60'}>
                  <td className="px-6 py-3">
                    <Link href={`/staff/workflows/templates/${t.id}`} className="font-medium text-gray-900 dark:text-gray-100 hover:underline">
                      {t.name}
                    </Link>
                    {t.description && (
                      <p className="text-xs text-gray-500 mt-0.5 truncate max-w-md">{t.description}</p>
                    )}
                  </td>
                  <td className="px-6 py-3 text-gray-700 dark:text-gray-300">{t._count.steps}</td>
                  <td className="px-6 py-3 text-xs text-gray-600 dark:text-gray-400">{t.defaultSkill?.label ?? '—'}</td>
                  <td className="px-6 py-3 text-gray-700 dark:text-gray-300">{t._count.instances}</td>
                  <td className="px-6 py-3">
                    {t.active ? <span className="badge-green">Aktiv</span> : <span className="badge-gray">Deaktiviert</span>}
                  </td>
                  <td className="px-6 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {t.active && t._count.steps > 0 && (
                        <QuickStartButton
                          templateId={t.id}
                          templateName={t.name}
                          clients={clients}
                        />
                      )}
                      <Link href={`/staff/workflows/templates/${t.id}`} className="text-xs text-brand-700 hover:underline">
                        Bearbeiten
                      </Link>
                      <ToggleActiveForm id={t.id} active={t.active} />
                      <DeleteTemplateForm id={t.id} name={t.name} instances={t._count.instances} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
