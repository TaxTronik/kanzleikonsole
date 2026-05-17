import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { InvoiceCategoryEditor } from './editor';

export default async function InvoiceCategoriesPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) {
    redirect('/staff/dashboard');
  }
  const { tenantId, staffId } = session.user;

  const [categories, templates] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      Promise.all([
        tx.invoiceCategory.findMany({
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
        tx.emailTemplate.findMany({
          where: { active: true },
          orderBy: { name: 'asc' },
          select: { slug: true, name: true },
        }),
      ]),
  );

  return (
    <div className="p-8 max-w-4xl">
      <Link href="/staff/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3">
        <ArrowLeft className="h-3 w-3" />
        Administration
      </Link>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">Rechnungstypen</h1>
      <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">
        Im EXTERNAL-Rechnungsmodus wählst du beim Hochladen einer Rechnung
        einen Typ aus. Jeder Typ kann eine eigene E-Mail-Vorlage referenzieren
        — so wird der Mandant je nach Anlass (Honorar / Mahnung / Beratung …)
        passend angeschrieben.
      </p>
      <InvoiceCategoryEditor
        initial={categories.map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          emailTemplateSlug: c.emailTemplateSlug,
          active: c.active,
        }))}
        emailTemplates={templates
          .filter((t): t is { slug: string; name: string } => !!t.slug)
          .map((t) => ({ slug: t.slug, name: t.name }))}
      />
    </div>
  );
}

export const dynamic = 'force-dynamic';
