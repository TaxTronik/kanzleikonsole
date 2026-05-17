import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { DocumentTypeEditor } from './editor';

export default async function DocumentTypesPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) redirect('/staff/dashboard');
  const { tenantId, staffId } = session.user;

  const types = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.documentType.findMany({
        orderBy: [{ builtin: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { documents: true } } },
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
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">Datei-Typen</h1>
      <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">
        Jedes Dokument hat einen Typ. Der Typ trägt die <strong>Schutzstufe</strong>,
        die Bucket, Object-Lock und Aufbewahrung steuert — genau drei Stufen:
        <em> Kein Lock</em>, <em>GwG · 5 Jahre</em>, <em>GoBD · 10 Jahre</em>.
        Die 7 Kern-Typen sind gesetzlich fixiert und nicht änderbar. Eigene
        Typen (z. B. „Arbeitspapiere") können Sie ergänzen und einer Stufe
        zuweisen; die Stufe ist nach Anlage unveränderbar.
      </p>
      <DocumentTypeEditor
        initial={types.map((t) => ({
          id: t.id,
          name: t.name,
          tier: t.tier,
          builtin: t.builtin,
          active: t.active,
          docCount: t._count.documents,
        }))}
      />
    </div>
  );
}

export const dynamic = 'force-dynamic';
