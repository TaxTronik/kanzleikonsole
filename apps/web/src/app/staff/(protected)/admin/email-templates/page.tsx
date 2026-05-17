import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { EmailTemplateEditor } from './editor';

export default async function EmailTemplatesPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) {
    redirect('/staff/dashboard');
  }
  const { tenantId, staffId } = session.user;

  const templates = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.emailTemplate.findMany({
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
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
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">E-Mail-Vorlagen</h1>
      <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">
        Wiederverwendbare Mail-Bausteine (Erinnerungen, Begleitschreiben,
        Jahresabschluss-Vorlage). Werden vom Workflow-Schritt „E-Mail an Mandant"
        referenziert — Änderungen wirken sofort auf alle Workflows, die diese
        Vorlage benutzen.
      </p>

      <EmailTemplateEditor
        initial={templates.map((t) => ({
          id: t.id,
          slug: t.slug,
          name: t.name,
          category: t.category,
          subject: t.subject,
          bodyMd: t.bodyMd,
          active: t.active,
        }))}
      />
    </div>
  );
}
