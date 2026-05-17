'use client';

import { useActionState } from 'react';
import { saveSellerInfoAction, type ActionResult } from './actions';
import type { SellerInfo } from '@/server/settings/tenant-settings';

export function SellerForm({ initial }: { initial: SellerInfo }) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    saveSellerInfoAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className="label" htmlFor="name">Kanzlei-Name</label>
        <input id="name" name="name" type="text" className="input" required maxLength={200}
               defaultValue={initial.name} />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className="label" htmlFor="street">Straße + Hausnr.</label>
          <input id="street" name="street" type="text" className="input" maxLength={200}
                 defaultValue={initial.street ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="postalCode">PLZ</label>
          <input id="postalCode" name="postalCode" type="text" className="input" maxLength={20}
                 defaultValue={initial.postalCode ?? ''} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className="label" htmlFor="city">Ort</label>
          <input id="city" name="city" type="text" className="input" maxLength={100}
                 defaultValue={initial.city ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="countryIso">Land (ISO 2)</label>
          <input id="countryIso" name="countryIso" type="text" className="input"
                 minLength={2} maxLength={2} pattern="[A-Za-z]{2}" defaultValue={initial.countryIso} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="vatId">USt-ID</label>
          <input id="vatId" name="vatId" type="text" className="input" maxLength={50}
                 placeholder="DE123456789"
                 defaultValue={initial.vatId ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="taxNumber">Steuernummer</label>
          <input id="taxNumber" name="taxNumber" type="text" className="input" maxLength={50}
                 defaultValue={initial.taxNumber ?? ''} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="email">E-Mail</label>
          <input id="email" name="email" type="email" className="input" maxLength={255}
                 defaultValue={initial.email ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="phone">Telefon</label>
          <input id="phone" name="phone" type="text" className="input" maxLength={50}
                 defaultValue={initial.phone ?? ''} />
        </div>
      </div>

      <fieldset className="border border-gray-200 rounded-md p-4 space-y-3">
        <legend className="text-xs font-medium text-gray-500 uppercase tracking-wide px-2">
          Bankverbindung (für XRechnung)
        </legend>
        <div>
          <label className="label" htmlFor="iban">IBAN</label>
          <input id="iban" name="iban" type="text" className="input font-mono" maxLength={50}
                 defaultValue={initial.iban ?? ''} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="bic">BIC</label>
            <input id="bic" name="bic" type="text" className="input font-mono" maxLength={20}
                   defaultValue={initial.bic ?? ''} />
          </div>
          <div>
            <label className="label" htmlFor="bankName">Bankname</label>
            <input id="bankName" name="bankName" type="text" className="input" maxLength={200}
                   defaultValue={initial.bankName ?? ''} />
          </div>
        </div>
      </fieldset>

      {state?.error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{state.error}</div>
      )}
      {state?.ok && (
        <div className="rounded-md bg-green-50 p-3 text-sm text-green-700">
          Gespeichert.
        </div>
      )}

      <button type="submit" className="btn-primary" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Speichern'}
      </button>
    </form>
  );
}
