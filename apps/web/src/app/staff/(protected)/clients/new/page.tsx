import { staffAuth } from '@/server/auth/staff';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { createClientAction } from './actions';
import { withTenantContext } from '@taxtronik/db';
import { ResponsibilityFields } from '../responsibility-fields';

export default async function NewClientPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const sp = await searchParams;
  const { tenantId, staffId } = session.user;
  const staff = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) => tx.staffUser.findMany({
      where: { active: true },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true, email: true },
    }),
  );

  return (
    <div className="p-8 max-w-2xl">
      <div className="flex items-center gap-3 mb-8">
        <Link href="/staff/clients" className="text-disabled hover:text-secondary">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-bold text-primary">Mandant anlegen</h1>
      </div>

      <div className="card p-6">
        <form action={createClientAction} className="space-y-6">
          {sp.error && <div className="alert-error-sm">{sp.error}</div>}

          <div>
            <label className="label" htmlFor="name">Name / Firma *</label>
            <input
              id="name"
              name="name"
              type="text"
              className="input"
              required
              placeholder="Mustermann GmbH"
            />
          </div>

          <div>
            <label className="label" htmlFor="kind">Mandantentyp *</label>
            <select id="kind" name="kind" className="input" required defaultValue="">
              <option value="" disabled>Bitte wählen…</option>
              <option value="NATPERS">Natürliche Person</option>
              <option value="JURPERS">Juristische Person</option>
              <option value="PERSGES">Personengesellschaft</option>
            </select>
          </div>

          <div>
            <label className="label" htmlFor="datevNo">DATEV-Nummer (optional)</label>
            <input
              id="datevNo"
              name="datevNo"
              type="text"
              className="input"
              placeholder="12345"
            />
          </div>

          <fieldset className="border border-default rounded-md p-4 space-y-3">
            <legend className="text-xs font-medium text-muted uppercase tracking-wide px-2">
              Rechnungsadresse (für XRechnung)
            </legend>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="label" htmlFor="street">Straße + Hausnr.</label>
                <input id="street" name="street" type="text" className="input" maxLength={200} />
              </div>
              <div>
                <label className="label" htmlFor="postalCode">PLZ</label>
                <input id="postalCode" name="postalCode" type="text" className="input" maxLength={20} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="label" htmlFor="city">Ort</label>
                <input id="city" name="city" type="text" className="input" maxLength={100} />
              </div>
              <div>
                <label className="label" htmlFor="countryIso">Land (ISO 2)</label>
                <input id="countryIso" name="countryIso" type="text" className="input"
                       minLength={2} maxLength={2} pattern="[A-Za-z]{2}" defaultValue="DE" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="vatId">USt-ID (optional)</label>
                <input id="vatId" name="vatId" type="text" className="input" maxLength={50}
                       placeholder="DE123456789" />
              </div>
              <div>
                <label className="label" htmlFor="invoiceEmail">Rechnungs-E-Mail</label>
                <input id="invoiceEmail" name="invoiceEmail" type="email" className="input" maxLength={255} />
              </div>
            </div>
          </fieldset>

          <ResponsibilityFields staff={staff} />

          <div className="alert-warning">
            <strong>Hinweis:</strong> Der Mandant wird zunächst mit dem Status{' '}
            <em>GwG ausstehend</em> angelegt. Er kann erst aktiviert werden, wenn die
            GwG-Prüfung abgeschlossen ist.
          </div>

          <div className="flex gap-3 pt-2">
            <button type="submit" className="btn-primary">
              Mandant anlegen
            </button>
            <Link href="/staff/clients" className="btn-secondary">
              Abbrechen
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
