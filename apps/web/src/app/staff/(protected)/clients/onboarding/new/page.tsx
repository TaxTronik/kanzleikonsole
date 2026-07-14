// =============================================================================
// /staff/clients/onboarding/new — Schritt 1: Stammdaten
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Wand2 } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { readModules } from '@/server/settings/modules';
import { withTenantContext } from '@taxtronik/db';
import { Stepper } from '../stepper';
import { stepsForTenant } from '../steps';
import { createOnboardingClientAction } from './actions';
import { ResponsibilityFields } from '../../responsibility-fields';

export default async function OnboardingStartPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const sp = await searchParams;
  const { tenantId, staffId } = session.user;

  const [modules, staff] = await Promise.all([
    readModules({ tenantId, actorId: staffId, actorType: 'STAFF' }),
    withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, (tx) =>
      tx.staffUser.findMany({
        where: { active: true },
        orderBy: { fullName: 'asc' },
        select: { id: true, fullName: true, email: true },
      }),
    ),
  ]);
  const steps = stepsForTenant(modules);

  return (
    <div className="p-8 max-w-3xl">
      <Link href="/staff/clients" className="back-link">
        <ArrowLeft className="h-4 w-4" /> Zurück zur Mandantenliste
      </Link>

      <div className="mb-6">
        <h1 className="page-title">
          <Wand2 className="h-6 w-6 text-brand-600" />
          Neuer Mandant — Onboarding
        </h1>
        <p className="text-muted text-sm">
          Geführter Erstkontakt vom Stammdaten-Eintrag bis zum Portal-Zugang.
        </p>
      </div>

      <Stepper steps={steps} currentKey="master_data" doneKeys={new Set()} />

      <div className="card p-6">
        <h2 className="text-sm font-medium text-primary mb-4">Stammdaten</h2>
        <form action={createOnboardingClientAction} className="space-y-4">
          {sp.error && <div className="alert-error-sm">{sp.error}</div>}

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="label" htmlFor="name">
                Name / Firma <span className="text-red-600">*</span>
              </label>
              <input id="name" name="name" type="text" required maxLength={200} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="kind">
                Typ <span className="text-red-600">*</span>
              </label>
              <select id="kind" name="kind" required defaultValue="JURPERS" className="input">
                <option value="NATPERS">Natürliche Person</option>
                <option value="JURPERS">Juristische Person</option>
                <option value="PERSGES">Personengesellschaft</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="datevNo">
                DATEV-Nummer
              </label>
              <input id="datevNo" name="datevNo" type="text" maxLength={40} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="addisonNo">
                Addison-Nummer
              </label>
              <input id="addisonNo" name="addisonNo" type="text" maxLength={40} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="vatId">
                USt-ID
              </label>
              <input
                id="vatId"
                name="vatId"
                type="text"
                maxLength={50}
                className="input"
                placeholder="DE123456789"
              />
            </div>
            <div className="col-span-2">
              <label className="label" htmlFor="street">
                Straße
              </label>
              <input id="street" name="street" type="text" maxLength={200} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="postalCode">
                PLZ
              </label>
              <input
                id="postalCode"
                name="postalCode"
                type="text"
                maxLength={20}
                className="input"
              />
            </div>
            <div>
              <label className="label" htmlFor="city">
                Ort
              </label>
              <input id="city" name="city" type="text" maxLength={100} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="countryIso">
                Land (ISO-2)
              </label>
              <input
                id="countryIso"
                name="countryIso"
                type="text"
                maxLength={2}
                defaultValue="DE"
                className="input"
              />
            </div>
            <div>
              <label className="label" htmlFor="invoiceEmail">
                Rechnungs-E-Mail
              </label>
              <input
                id="invoiceEmail"
                name="invoiceEmail"
                type="email"
                maxLength={255}
                className="input"
              />
            </div>
          </div>

          <ResponsibilityFields staff={staff} />

          <div className="flex justify-end gap-2 pt-3 border-t border-subtle">
            <Link href="/staff/clients" className="btn-secondary text-sm">
              Abbrechen
            </Link>
            <button type="submit" className="btn-primary text-sm">
              Anlegen &amp; weiter
            </button>
          </div>
        </form>
      </div>

      <p className="text-xs text-muted mt-4">
        Pflichtfelder: Name + Typ. Alle anderen Felder können später ergänzt werden.
      </p>
    </div>
  );
}
