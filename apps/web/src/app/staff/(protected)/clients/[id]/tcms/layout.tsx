// =============================================================================
// Rahmen des Tax-CMS-Bereichs eines Mandanten (TCMS Stufe 3): Rückweg zur
// Mandantenakte, Überschrift mit dem Namen aus der kanzleikonsole und die
// Unternavigation. Prüft wie jede Seite zuerst den Mandantenzugriff
// (tcmsMandantSeite → requireClientPageAccess, Guard:
// src/__tests__/client-page-authz.test.ts); die Seiten prüfen selbst erneut
// (Layouts rendern bei Navigation zwischen Unterseiten nicht neu), `cache()`
// hält es bei einer Prüfung je Request. Unterseiten verwenden h2 als oberste
// Überschrift; die h1 steht hier.
// =============================================================================

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { TcmsMandantNavigation } from '@/components/tcms/navigation';
import { tcmsMandantSeite } from '@/server/tcms/seite';
import { TcmsText } from '@/components/tcms/text';

export default async function TcmsMandantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const seite = await tcmsMandantSeite(id);
  return (
    <div className="p-8">
      <Link href={`/staff/clients/${encodeURIComponent(id)}`} className="back-link">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Zur Mandantenakte
      </Link>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-primary">Tax-CMS</h1>
        {seite.ok ? (
          <p className="text-sm text-muted">
            <TcmsText>{seite.mandant.name}</TcmsText>
          </p>
        ) : null}
      </div>
      {seite.ok ? <TcmsMandantNavigation basis={seite.basis} /> : null}
      {children}
    </div>
  );
}
