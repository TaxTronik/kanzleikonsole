// =============================================================================
// /staff/forms — Formular-Vorlagen-Übersicht
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ClipboardList, Plus, FileText } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { CreateFormForm } from './create-form';
import { FormRowActions } from './row-forms';

export default async function FormsListPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { tenantId, staffId } = session.user;

  const templates = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.formTemplate.findMany({
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
        include: {
          _count: { select: { fields: true, submissions: true } },
        },
      }),
  );

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-6">
        <h1 className="page-title">
          <ClipboardList className="h-6 w-6 text-brand-600" />
          Formulare
        </h1>
        <p className="text-muted text-sm">
          Eigene Anfrage-Formulare für Mandanten — z. B. „Steuerunterlagen 2025", „Fahrtenbuch",
          „Homeoffice-Erfassung". Mandanten füllen sie im Portal aus.
        </p>
      </div>

      <details className="card p-6 mb-6">
        <summary className="cursor-pointer text-sm font-medium text-primary flex items-center gap-2">
          <Plus className="h-4 w-4" /> Neue Vorlage anlegen
        </summary>
        <div className="mt-4">
          <CreateFormForm />
        </div>
      </details>

      {templates.length === 0 ? (
        <div className="card p-10 text-center">
          <FileText className="h-10 w-10 text-disabled mx-auto mb-3" />
          <p className="text-sm text-disabled">Noch keine Vorlagen.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-default">
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">
                  Vorlage
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">
                  Felder
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">
                  Anfragen
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">
                  Status
                </th>
                <th className="text-right px-6 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {templates.map((t) => (
                <tr key={t.id} className={t.active ? 'hover:bg-gray-50' : 'opacity-60'}>
                  <td className="px-6 py-3">
                    <Link
                      href={`/staff/forms/${t.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {t.name}
                    </Link>
                    {t.description && (
                      <p className="text-xs text-muted mt-0.5 truncate max-w-md">{t.description}</p>
                    )}
                  </td>
                  <td className="px-6 py-3 text-secondary">{t._count.fields}</td>
                  <td className="px-6 py-3 text-secondary">{t._count.submissions}</td>
                  <td className="px-6 py-3">
                    {t.active ? (
                      <span className="badge-green">Aktiv</span>
                    ) : (
                      <span className="badge-gray">Deaktiviert</span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-right">
                    <FormRowActions
                      id={t.id}
                      name={t.name}
                      active={t.active}
                      submissions={t._count.submissions}
                    />
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
