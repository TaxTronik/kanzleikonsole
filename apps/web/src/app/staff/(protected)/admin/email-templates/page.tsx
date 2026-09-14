import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';

import { withTenantContext } from '@taxtronik/db';
import { EmailTemplateEditor } from './editor';

export default async function EmailTemplatesPage() {
  const session = await requireStaffPage({ admin: true });
  const { tenantId, staffId } = session.user;

  const templates = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.emailTemplate.findMany({
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
  );

  return (
    <div className="min-w-0 max-w-4xl p-4 sm:p-6 lg:p-8">
      <Link href="/staff/admin" className="back-link mb-3">
        <ArrowLeft className="h-3 w-3" />
        Administration
      </Link>
      <h1 className="page-title [overflow-wrap:anywhere]">E-Mail-Vorlagen</h1>
      <p className="text-muted text-sm mb-6">
        Wiederverwendbare Mail-Bausteine (Erinnerungen, Begleitschreiben, Jahresabschluss-Vorlage).
        Werden vom Workflow-Schritt „E-Mail an Mandant" referenziert — Änderungen wirken sofort auf
        alle Workflows, die diese Vorlage benutzen.
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
