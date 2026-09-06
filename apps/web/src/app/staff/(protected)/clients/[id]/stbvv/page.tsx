import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import type { FeeCalculation } from '@taxtronik/tax';
import { requireStaffPage } from '@/server/auth/staff-page';
import { assertClientAccessTx, hasStaffPermission } from '@/server/auth/rbac';
import { assertModuleEnabled, readModules } from '@/server/settings/modules';
import { FeeCalculatorForm, FeeDraftForm } from '../../../stbvv/calculator-form';
export default async function ClientStbvvPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params,
    session = await requireStaffPage();
  const ctx: TenantContext = {
    tenantId: session.user.tenantId,
    actorId: session.user.staffId,
    actorType: 'STAFF',
  };
  await assertModuleEnabled(ctx, 'feeCalculator');
  const data = await withTenantContext(ctx, async (tx) => {
    await assertClientAccessTx(tx, session, id);
    return {
      client: await tx.client.findUnique({ where: { id }, select: { id: true, name: true } }),
      quotes: await tx.stbvvQuote.findMany({
        where: { tenantId: ctx.tenantId, clientId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { invoiceExport: true },
      }),
    };
  });
  if (!data.client) notFound();
  const modules = await readModules(ctx),
    canSave = hasStaffPermission(session, 'INVOICE_MANAGE');
  return (
    <main className="p-8 max-w-6xl space-y-5">
      <Link href={`/staff/clients/${id}`}>← {data.client.name}</Link>
      <h1 className="text-2xl font-bold">Gebührenkalkulationen</h1>
      <p>
        Gespeicherte Nachweise bleiben unverändert. Neue Berechnungen ersetzen keinen früheren
        Nachweis. Die Übernahme legt ausschließlich einen neuen Rechnungsentwurf an.
      </p>
      <details>
        <summary>Neue Kalkulation erstellen</summary>
        <FeeCalculatorForm clients={[data.client]} canSave={canSave} />
      </details>
      {data.quotes.map((q) => {
        const r = q.result as unknown as FeeCalculation;
        return (
          <article key={q.id} className="rounded border p-4 space-y-2">
            <h2 className="font-semibold">
              {q.title} ·{' '}
              {(r.grossCents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}
            </h2>
            <p className="text-sm">
              {q.createdAt.toLocaleString('de-DE')} · {q.lawVersion} · Bearbeiter {q.createdBy}
            </p>
            <details>
              <summary>Vollständiger Berechnungsnachweis</summary>
              <pre className="whitespace-pre-wrap overflow-auto text-xs">
                {JSON.stringify({ inputs: q.inputs, result: q.result }, null, 2)}
              </pre>
            </details>
            {q.invoiceExport ? (
              <Link className="underline" href={`/staff/invoices/${q.invoiceExport.invoiceId}`}>
                Übernommene Rechnung
              </Link>
            ) : canSave && modules.invoiceMode === 'IN_APP' ? (
              <FeeDraftForm clientId={id} quoteId={q.id} />
            ) : (
              <p className="text-sm">
                Rechnungsübernahme benötigt IN_APP und das Einzelrecht INVOICE_MANAGE.
              </p>
            )}
          </article>
        );
      })}
    </main>
  );
}
