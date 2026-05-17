import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { readModules } from '@/server/settings/modules';
import { NewInvoiceForm } from './form';
import { ExternalInvoiceForm } from './external-form';

export default async function NewInvoicePage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { tenantId, staffId } = session.user;
  const modules = await readModules({ tenantId, actorId: staffId, actorType: 'STAFF' });
  if (modules.invoiceMode === 'OFF') redirect('/staff/dashboard');

  const [clients, categories, lastInvoice] = await withTenantContext(
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
        tx.invoice.findFirst({
          orderBy: { createdAt: 'desc' },
          select: { number: true, issueDate: true },
        }),
      ]),
  );

  // Vorschlag für nächste Rechnungsnummer: YYYY-XXXX, +1 wenn Format passt
  const year = new Date().getFullYear();
  const suggestNumber = (() => {
    if (lastInvoice?.number) {
      const m = lastInvoice.number.match(/^(\d{4})-(\d+)$/);
      if (m && m[1] === String(year)) {
        return `${year}-${String(Number(m[2]) + 1).padStart(4, '0')}`;
      }
    }
    return `${year}-0001`;
  })();

  const isExternal = modules.invoiceMode === 'EXTERNAL';

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/staff/invoices" className="text-gray-400 hover:text-gray-600 mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-1">
            {isExternal ? 'PDF-Rechnung hochladen' : 'Neue Rechnung'}
          </h1>
          <p className="text-gray-500 text-sm">
            {isExternal
              ? 'Rechnung kommt aus zentraler Rechnungssoftware — hier nur PDF + Empfänger.'
              : 'Nur aktive Mandanten (GwG-verifiziert) können Rechnungen empfangen.'}
          </p>
        </div>
      </div>

      {clients.length === 0 ? (
        <div className="card p-8 text-center text-sm text-gray-500">
          Keine aktiven Mandanten vorhanden. Bitte zuerst GwG-Prüfung abschließen.
        </div>
      ) : isExternal ? (
        <ExternalInvoiceForm
          clients={clients}
          categories={categories}
          suggestedNumber={suggestNumber}
        />
      ) : (
        <NewInvoiceForm clients={clients} suggestedNumber={suggestNumber} />
      )}
    </div>
  );
}
