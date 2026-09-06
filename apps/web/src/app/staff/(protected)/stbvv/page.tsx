import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { requireStaffPage } from '@/server/auth/staff-page';
import { accessibleClientsWhereFor, hasStaffPermission } from '@/server/auth/rbac';
import { assertModuleEnabled } from '@/server/settings/modules';
import { FeeCalculatorForm } from './calculator-form';
export default async function StbvvPage() {
  const session = await requireStaffPage();
  const ctx: TenantContext = {
    tenantId: session.user.tenantId,
    actorId: session.user.staffId,
    actorType: 'STAFF',
  };
  await assertModuleEnabled(ctx, 'feeCalculator');
  const clients = await withTenantContext(ctx, async (tx) =>
    tx.client.findMany({
      where: {
        tenantId: ctx.tenantId,
        anonymizedAt: null,
        mandateEndedAt: null,
        ...(await accessibleClientsWhereFor(tx, session)),
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  );
  return (
    <main className="p-8 max-w-6xl space-y-5">
      <h1 className="text-2xl font-bold">StBVV-Gebührenkalkulation</h1>
      <p>
        Aktueller Gebührenkatalog mit Tabellen A–D. Fachlicher Entwurf ohne Berufsträgerfreigabe.
        Tatbestand, Gegenstandswert und Rahmenwahl bleiben prüfpflichtig; externe RVG-Berechnungen
        werden ausdrücklich gekennzeichnet.
      </p>
      <FeeCalculatorForm
        clients={clients}
        canSave={hasStaffPermission(session, 'INVOICE_MANAGE')}
      />
    </main>
  );
}
