import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { hasStaffPermission } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { readModules } from '@/server/settings/modules';
import { NewInvoiceForm } from './form';
import { ExternalInvoiceForm } from './external-form';

export default async function NewInvoicePage() {
  const session = await requireStaffPage();

  const { tenantId, staffId } = session.user;
  const modules = await readModules({ tenantId, actorId: staffId, actorType: 'STAFF' });
  if (modules.invoiceMode === 'OFF') redirect('/staff/dashboard');

  // iter87: EXTERNAL-Upload = Ausstellen+Zustellen (INVOICE_SEND), In-App-
  // Anlage = Entwurf (INVOICE_MANAGE). Die Actions prüfen dieselbe Regel.
  const needed = modules.invoiceMode === 'EXTERNAL' ? 'INVOICE_SEND' : 'INVOICE_MANAGE';
  if (!hasStaffPermission(session, needed)) redirect('/staff/invoices');

  const [clients, categories] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.client.findMany({
          where: { allowActive: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
        tx.invoiceCategory.findMany({
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, name: true },
        }),
      ]),
  );

  // iter85 (GoB): In-App-Nummern vergibt der Nummernkreis automatisch und
  // lückenlos beim Anlegen — der frühere clientseitige Vorschlag entfällt.
  // EXTERNAL trägt weiterhin die Nummer des Fremdsystems (manuell).
  const isExternal = modules.invoiceMode === 'EXTERNAL';

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/staff/invoices" className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">
            {isExternal ? 'PDF-Rechnung hochladen' : 'Neue Rechnung'}
          </h1>
          <p className="text-muted text-sm">
            {isExternal
              ? 'Rechnung kommt aus zentraler Rechnungssoftware — hier nur PDF + Empfänger.'
              : 'Nur aktive Mandanten (GwG-verifiziert) können Rechnungen empfangen.'}
          </p>
        </div>
      </div>

      {clients.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          Keine aktiven Mandanten vorhanden. Bitte zuerst GwG-Prüfung abschließen.
        </div>
      ) : isExternal ? (
        <ExternalInvoiceForm clients={clients} categories={categories} />
      ) : (
        <NewInvoiceForm clients={clients} />
      )}
    </div>
  );
}
