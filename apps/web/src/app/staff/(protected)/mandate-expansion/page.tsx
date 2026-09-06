import Link from 'next/link';
import { requireStaffPage } from '@/server/auth/staff-page';
import { isStaffAdmin } from '@/server/auth/rbac';
import { readModules } from '@/server/settings/modules';
import { resolveMandateExpansionItems } from '@/lib/navigation-registry';
export default async function MandateExpansionPage() {
  const s = await requireStaffPage();
  const m = await readModules({
    tenantId: s.user.tenantId,
    actorId: s.user.staffId,
    actorType: 'STAFF',
  });
  const items = resolveMandateExpansionItems(m, isStaffAdmin(s));
  return (
    <main className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Mandatsorganisation</h1>
      <div className="grid gap-4 md:grid-cols-2">
        {items.map((i) => (
          <Link className="card p-6 border rounded-lg" href={i.href} key={i.id}>
            <h2 className="font-semibold mb-2">{i.title}</h2>
            <p>{i.description}</p>
          </Link>
        ))}
      </div>
      {items.length === 0 && (
        <p>
          Die Erweiterungen sind noch nicht aktiviert. ADMIN/PARTNER kann die gewünschten Module in
          den Einstellungen einschalten.
        </p>
      )}
    </main>
  );
}
