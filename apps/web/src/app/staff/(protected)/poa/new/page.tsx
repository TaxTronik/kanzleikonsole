import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { readModules } from '@/server/settings/modules';
import { NewPoaForm } from './form';
import { isStaffAdmin } from '@/server/auth/rbac';

export default async function NewPoaPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) redirect('/staff/poa');

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const modules = await readModules(ctx);
  const clients = await withTenantContext(ctx, (tx) =>
    tx.client.findMany({
      where: { allowActive: true },
      orderBy: { name: 'asc' },
      include: { contacts: { where: { active: true }, orderBy: { fullName: 'asc' } } },
    }),
  );

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/staff/poa" className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-bold text-primary">Neue Vollmacht</h1>
      </div>

      {modules.poaMode === 'OFF' ? (
        <div className="card p-8 text-center text-sm text-muted">
          Das Vollmachten-Modul ist deaktiviert (Einstellungen &rarr; Module).
        </div>
      ) : clients.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          Keine aktiven Mandanten. Bitte zuerst GwG-Prüfung abschließen.
        </div>
      ) : (
        <NewPoaForm
          poaMode={modules.poaMode}
          clients={clients.map((c) => ({
            id: c.id,
            name: c.name,
            contacts: c.contacts.map((ct) => ({
              id: ct.id,
              fullName: ct.fullName,
              email: ct.email,
            })),
          }))}
        />
      )}
    </div>
  );
}
