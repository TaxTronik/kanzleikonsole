import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireStaffPage } from '@/server/auth/staff-page';
import { isStaffAdmin } from '@/server/auth/rbac';
import { readModules, type BooleanModuleKey } from '@/server/settings/modules';
import { resolveMandateExpansionItems } from '@/lib/navigation-registry';
export async function expansionPage(module: BooleanModuleKey, admin = false) {
  const session = await requireStaffPage({ admin });
  const ctx = {
    tenantId: session.user.tenantId,
    actorId: session.user.staffId,
    actorType: 'STAFF' as const,
  };
  const modules = await readModules(ctx);
  if (!modules[module]) notFound();
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
export function ClientSelect({
  clients,
  selected,
}: {
  clients: Array<{ id: string; name: string }>;
  selected: string;
}) {
  return (
    <form method="get" className="card flex flex-wrap items-end gap-3 p-5">
      <label className="block min-w-0 flex-1 sm:max-w-md">
        <span className="label">Mandant</span>
        <select className="input" name="clientId" defaultValue={selected}>
          <option value="">Bitte wählen</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <button className="btn-secondary" type="submit">
        Öffnen
      </button>
    </form>
  );
}
