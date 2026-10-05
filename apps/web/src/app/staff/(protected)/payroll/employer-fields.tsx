'use client';

import { useRef, useState } from 'react';
import { ClientCombobox, type ClientComboboxValue } from '@/components/ui/client-combobox';
import { loadPayrollEmployerContactsAction } from './actions';

interface ContactsState {
  items: Array<{ id: string; fullName: string }>;
  loading: boolean;
  error: string | null;
}

const NO_CONTACTS: ContactsState = { items: [], loading: false, error: null };

/**
 * Mandat per Serversuche, danach nur dessen aktive Kontakte. Früher lud die
 * Seite alle Mandate und alle Kontakte und löste Namen per clients.find auf.
 */
export function PayrollEmployerFields() {
  const [client, setClient] = useState<ClientComboboxValue | null>(null);
  const [contacts, setContacts] = useState<ContactsState>(NO_CONTACTS);
  const request = useRef(0);

  async function onClientChange(next: ClientComboboxValue | null) {
    setClient(next);
    const current = ++request.current;
    if (!next) {
      setContacts(NO_CONTACTS);
      return;
    }
    setContacts({ ...NO_CONTACTS, loading: true });
    const result = await loadPayrollEmployerContactsAction(next.id).catch(() => ({
      ok: false as const,
      error: 'Kontakte konnten nicht geladen werden.',
      contacts: undefined,
    }));
    // Nur die Antwort zur zuletzt gewählten Auswahl übernehmen.
    if (current !== request.current) return;
    setContacts({
      items: result.contacts ?? [],
      loading: false,
      error: result.ok ? null : (result.error ?? 'Kontakte konnten nicht geladen werden.'),
    });
  }

  return (
    <>
      <div className="block">
        <label htmlFor="payroll-client">Mandat</label>
        <ClientCombobox
          id="payroll-client"
          name="clientId"
          filters={['active', 'notEnded']}
          value={client}
          onChange={onClientChange}
          required
        />
      </div>
      <label className="block">
        Ausdrücklich berechtigter Arbeitgeberkontakt
        {/* Neues Mandat = neue Liste; ein Schlüsselwechsel verwirft die alte Wahl. */}
        <select
          key={client?.id ?? 'none'}
          className="input"
          name="contactId"
          required
          disabled={!client || contacts.loading}
          aria-busy={contacts.loading}
          defaultValue=""
        >
          <option value="">{client ? 'Bitte wählen' : 'Zuerst Mandat wählen'}</option>
          {contacts.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.fullName}
            </option>
          ))}
        </select>
      </label>
      {contacts.error && <p className="text-sm text-red-700">{contacts.error}</p>}
    </>
  );
}
