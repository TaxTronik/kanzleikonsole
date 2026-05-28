import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { NewPoaForm } from './form';

export default async function NewPoaPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { tenantId, staffId } = session.user;
  const clients = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
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

      {clients.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          Keine aktiven Mandanten. Bitte zuerst GwG-Prüfung abschließen.
        </div>
      ) : (
        <NewPoaForm clients={clients.map((c) => ({
          id: c.id,
          name: c.name,
          contacts: c.contacts.map((ct) => ({ id: ct.id, fullName: ct.fullName, email: ct.email })),
        }))} />
      )}
    </div>
  );
}
