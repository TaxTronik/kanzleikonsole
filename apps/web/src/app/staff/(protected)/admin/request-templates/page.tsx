import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { RequestTemplateEditor } from './editor';

export default async function RequestTemplatesPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) {
    redirect('/staff/dashboard');
  }
  const { tenantId, staffId } = session.user;

  const [templates, formTemplates] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.requestTemplate.findMany({
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          include: { formTemplate: { select: { id: true, name: true } } },
        }),
        tx.formTemplate.findMany({
          where: { active: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
      ]),
  );

  return (
    <div className="p-8 max-w-4xl">
      <Link
        href="/staff/admin"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3"
      >
        <ArrowLeft className="h-3 w-3" />
        Administration
      </Link>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Anforderungs-Vorlagen</h1>
      <p className="text-gray-500 text-sm mb-6">
        Wiederkehrende Anforderungen (FiBu, Lohnunterlagen, Jahresabschluss-Belege …)
        einmal definieren — beim Anlegen einer Anforderung schnell auswählen. Optional
        ein Formular verknüpfen, das der Mandant gleich mit ausfüllt.
      </p>

      <RequestTemplateEditor
        initial={templates.map((t) => ({
          id: t.id,
          name: t.name,
          category: t.category,
          title: t.title,
          description: t.description,
          priority: t.priority,
          dueAfterDays: t.dueAfterDays,
          formTemplateId: t.formTemplateId,
          formTemplateName: t.formTemplate?.name ?? null,
          active: t.active,
        }))}
        formTemplates={formTemplates}
      />
    </div>
  );
}
