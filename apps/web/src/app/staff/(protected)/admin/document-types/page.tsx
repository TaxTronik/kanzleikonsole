import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';

import { withTenantContext } from '@taxtronik/db';
import { DocumentTypeEditor } from './editor';

export default async function DocumentTypesPage() {
  const session = await requireStaffPage({ admin: true });
  const { tenantId, staffId } = session.user;

  const types = await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, (tx) =>
    tx.documentType.findMany({
      orderBy: [{ builtin: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      // Nur aktive Dokumente zählen — soft-gelöschte sind aus Sicht der
      // Verwaltung „weg" (Aufbewahrung läuft im Object-Store separat).
      include: { _count: { select: { documents: { where: { deletedAt: null } } } } },
    }),
  );

  return (
    <div className="p-8 max-w-4xl">
      <Link href="/staff/admin" className="back-link mb-3">
        <ArrowLeft className="h-3 w-3" />
        Administration
      </Link>
      <h1 className="text-2xl font-bold text-primary mb-1">Datei-Typen</h1>
      <p className="text-muted text-sm mb-6">
        Jedes Dokument hat einen Typ. Der Typ trägt die <strong>Schutzstufe</strong>, die Bucket und
        Object-Lock-Modus steuert — genau drei Stufen:
        <em> Kein Lock</em>, <em>GwG · 5 Jahre Grundlock + fachliche Prüfung</em>, <em>GoBD</em>.
        Bei GoBD wird zusätzlich die dokumentartabhängige Frist von 6, 8 oder 10 Jahren festgelegt.
        Bei GwG können andere Gesetze länger verpflichten; spätestens nach zehn Jahren ist zu
        vernichten. Die 7 Kern-Typen sind gesetzlich fixiert und nicht änderbar. Eigene Typen (z. B.
        „Arbeitspapiere") können Sie ergänzen und einer Stufe zuweisen; die Stufe ist nach Anlage
        unveränderbar.
      </p>
      <DocumentTypeEditor
        initial={types.map((t) => ({
          id: t.id,
          name: t.name,
          tier: t.tier,
          retentionYears: t.retentionYears,
          builtin: t.builtin,
          active: t.active,
          docCount: t._count.documents,
        }))}
      />
    </div>
  );
}
