'use client';

import { useActionState, useRef, useState } from 'react';
import Link from 'next/link';
import { createPoaAction, loadPoaSignerContactsAction, type ActionResult } from '../actions';
import { FileButton } from '@/components/file-button';
import { ClientCombobox, type ClientComboboxValue } from '@/components/ui/client-combobox';
import { poaCreateResumeHref, type PoaCreateReturnContext } from './return-context';

interface Contact {
  id: string;
  fullName: string;
  email: string;
}

interface Client {
  id: string;
  name: string;
  contacts: Contact[];
}

interface ContactsState {
  contacts: Contact[];
  loading: boolean;
  error: string | null;
}

/**
 * Mandant per Serversuche, Kontakte nur des gewählten Mandanten (früher: alle
 * Mandanten samt aller Kontakte im Seiten-Payload). Ein fest übergebener
 * Mandant (Onboarding/Upload) bleibt gesperrt; dann trägt ein eigenes
 * verstecktes Feld die ID, weil gesperrte Felder nicht mitgesendet werden.
 */
function PoaClientFields({
  client,
  contacts,
  contactId,
  locked,
  onClientChange,
  onContactChange,
}: {
  client: ClientComboboxValue | null;
  contacts: ContactsState;
  contactId: string;
  locked: boolean;
  onClientChange: (client: ClientComboboxValue | null) => void;
  onContactChange: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className="label" htmlFor="clientId">
          Mandant
        </label>
        <ClientCombobox
          id="clientId"
          name="clientId"
          filters={['active', 'notEnded', 'notAnonymized']}
          value={client}
          onChange={onClientChange}
          required
          disabled={locked}
        />
      </div>
      <div>
        <label className="label" htmlFor="signerContactId">
          Bestehender Kontakt (optional)
        </label>
        <select
          id="signerContactId"
          name="signerContactId"
          className="input"
          value={contactId}
          onChange={(e) => onContactChange(e.target.value)}
          disabled={!client || contacts.loading}
          aria-busy={contacts.loading}
        >
          <option value="">— manuell eingeben —</option>
          {contacts.contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.fullName} ({c.email})
            </option>
          ))}
        </select>
        {contacts.error && <p className="mt-1 text-xs text-red-700">{contacts.error}</p>}
      </div>
    </div>
  );
}

const NO_CONTACTS: ContactsState = { contacts: [], loading: false, error: null };

export function NewPoaForm({
  poaMode,
  initialClient,
  initialPendingDocumentId,
  uploadIntentId,
  returnContext,
}: {
  poaMode: 'MARKDOWN_OTP' | 'PDF_TEMPLATE';
  initialClient?: Client;
  initialPendingDocumentId?: string;
  uploadIntentId?: string;
  returnContext?: PoaCreateReturnContext;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createPoaAction,
    null,
  );
  const [client, setClient] = useState<ClientComboboxValue | null>(
    initialClient ? { id: initialClient.id, name: initialClient.name } : null,
  );
  const [contacts, setContacts] = useState<ContactsState>(
    initialClient ? { ...NO_CONTACTS, contacts: initialClient.contacts } : NO_CONTACTS,
  );
  const contactRequest = useRef(0);
  const [contactId, setContactId] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [signerName, setSignerName] = useState('');

  const clientId = client?.id ?? '';
  const pendingDocumentId = state?.pendingDocumentId ?? initialPendingDocumentId;

  async function onClientChange(next: ClientComboboxValue | null) {
    setClient(next);
    setContactId('');
    setSignerEmail('');
    setSignerName('');
    const request = ++contactRequest.current;
    if (!next) {
      setContacts(NO_CONTACTS);
      return;
    }
    setContacts({ ...NO_CONTACTS, loading: true });
    const result = await loadPoaSignerContactsAction(next.id).catch(() => ({
      ok: false as const,
      error: 'Kontakte konnten nicht geladen werden.',
      contacts: undefined,
    }));
    // Nur die Antwort zur zuletzt gewählten Auswahl übernehmen.
    if (request !== contactRequest.current) return;
    setContacts({
      ...NO_CONTACTS,
      contacts: result.contacts ?? [],
      error: result.ok ? null : (result.error ?? 'Kontakte konnten nicht geladen werden.'),
    });
  }

  function onContactChange(id: string) {
    setContactId(id);
    if (id) {
      const c = contacts.contacts.find((x) => x.id === id);
      if (c) {
        setSignerEmail(c.email);
        setSignerName(c.fullName);
      }
    }
  }

  return (
    <form action={formAction} className="card p-6 space-y-4">
      {uploadIntentId ? <input type="hidden" name="uploadIntentId" value={uploadIntentId} /> : null}
      {returnContext ? <input type="hidden" name="returnContext" value={returnContext} /> : null}
      {returnContext && !pendingDocumentId ? (
        <input type="hidden" name="clientId" value={clientId} />
      ) : null}
      {pendingDocumentId ? (
        <>
          <input type="hidden" name="pendingDocumentId" value={pendingDocumentId} />
          <input type="hidden" name="clientId" value={clientId} />
        </>
      ) : null}
      <PoaClientFields
        client={client}
        contacts={contacts}
        contactId={contactId}
        locked={Boolean(pendingDocumentId || returnContext)}
        onClientChange={onClientChange}
        onContactChange={onContactChange}
      />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="signerName">
            Unterzeichner-Name
          </label>
          <input
            id="signerName"
            name="signerName"
            type="text"
            className="input"
            value={signerName}
            onChange={(e) => setSignerName(e.target.value)}
            required
            maxLength={200}
          />
        </div>
        <div>
          <label className="label" htmlFor="signerEmail">
            Unterzeichner-E-Mail
          </label>
          <input
            id="signerEmail"
            name="signerEmail"
            type="email"
            className="input"
            value={signerEmail}
            onChange={(e) => setSignerEmail(e.target.value)}
            required
          />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="subject">
          Betreff
        </label>
        <input
          id="subject"
          name="subject"
          type="text"
          className="input"
          required
          maxLength={300}
          placeholder="z. B. Vertretung gegenüber Finanzamt München"
        />
      </div>

      {poaMode === 'MARKDOWN_OTP' ? (
        <div>
          <label className="label" htmlFor="scope">
            Umfang (Markdown)
          </label>
          <textarea
            id="scope"
            name="scope"
            rows={10}
            className="input font-mono text-sm"
            required
            minLength={1}
            maxLength={20000}
            placeholder={`Hiermit bevollmächtige ich…\n\n## Umfang\n- …\n- …\n\n## Wirksamkeit\n…`}
          />
        </div>
      ) : (
        <div>
          <span className="label">Vollmacht als PDF</span>
          <div className="mt-1">
            <FileButton id="poaPdf" name="poaPdf" accept="application/pdf">
              PDF auswählen
            </FileButton>
          </div>
          <p className="text-xs text-muted mt-1">
            Die PDF wird revisionssicher (GoBD) abgelegt und am Vollmacht-Datensatz verknüpft.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="validFrom">
            Gültig ab
          </label>
          <input
            id="validFrom"
            name="validFrom"
            type="date"
            className="input"
            defaultValue={today}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="validUntil">
            Gültig bis (optional)
          </label>
          <input id="validUntil" name="validUntil" type="date" className="input" />
        </div>
      </div>

      <div className="flex gap-2 items-center">
        <button type="submit" disabled={isPending} className="btn-primary disabled:opacity-60">
          {isPending ? 'Lege an …' : 'Anlegen'}
        </button>
        <p className="text-xs text-muted self-center">
          {poaMode === 'MARKDOWN_OTP'
            ? 'Nach Anlegen können Sie die Vollmacht zur Unterschrift senden.'
            : 'Nach Anlegen können Sie die Vollmacht bei Bedarf zur Unterschrift weiterleiten.'}
        </p>
      </div>
      {state && !state.ok && (
        <div className="alert-error-sm space-y-2">
          <p>{state.error}</p>
          {state.pendingDocumentId ? (
            <p className="text-xs">
              Der revisionssichere Upload bleibt erhalten.{' '}
              <Link
                className="underline font-medium"
                href={poaCreateResumeHref({
                  clientId,
                  pendingDocumentId: state.pendingDocumentId,
                  returnContext,
                })}
              >
                Vorgang fortsetzen
              </Link>{' '}
              oder{' '}
              <Link
                className="underline font-medium"
                href={`/staff/documents/${encodeURIComponent(state.pendingDocumentId)}`}
              >
                Dokument ansehen
              </Link>
              .
            </p>
          ) : null}
        </div>
      )}
    </form>
  );
}
