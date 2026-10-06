import Link from 'next/link';
import { requireStaffPage } from '@/server/auth/staff-page';
import { isStaffAdmin } from '@/server/auth/rbac';
import { readModules } from '@/server/settings/modules';
import { requireModulePage } from '@/server/settings/module-page';
import { resolveMandateExpansionItems } from '@/lib/navigation-registry';
import { ClientCombobox } from '@/components/ui/client-combobox';
/** Seiten-Gate der Unterseiten: Registry-Bereich je Unterseite (requireModulePage). */
export async function expansionPage(
  area: 'mandateStructure' | 'workflowDependencies' | 'mandateOffboarding' | 'vdbPreparation',
  admin = false,
) {
  const session = await requireStaffPage({ admin });
  const ctx = {
    tenantId: session.user.tenantId,
    actorId: session.user.staffId,
    actorType: 'STAFF' as const,
  };
  const modules = await requireModulePage('staff', area);
  return { session, ctx, modules };
}
export async function ExpansionNavigation() {
  const session = await requireStaffPage();
  const modules = await readModules({
    tenantId: session.user.tenantId,
    actorId: session.user.staffId,
    actorType: 'STAFF',
  });
  const items = resolveMandateExpansionItems(modules, isStaffAdmin(session));
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Mandatsorganisation">
      <Link className="btn-secondary" href="/staff/mandate-expansion">
        Übersicht
      </Link>
      {items.map((item) => (
        <Link className="btn-secondary" href={item.href} key={item.id}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
export function ClientSelect({ selected }: { selected: { id: string; name: string } | null }) {
  // Serversuche statt der alphabetisch ersten 1.000 Mandanten.
  return (
    <form method="get" className="card flex flex-wrap items-end gap-3 p-5">
      <div className="block min-w-0 flex-1 sm:max-w-md">
        <label className="label" htmlFor="mandate-expansion-client">
          Mandant
        </label>
        <ClientCombobox
          id="mandate-expansion-client"
          name="clientId"
          filters={['notAnonymized']}
          defaultValue={selected}
        />
      </div>
      <button className="btn-secondary" type="submit">
        Öffnen
      </button>
    </form>
  );
}
