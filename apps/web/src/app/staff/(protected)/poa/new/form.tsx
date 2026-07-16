'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { createPoaAction, type ActionResult } from '../actions';
import { FileButton } from '@/components/file-button';
import { poaCreateResumeHref, type PoaCreateReturnContext } from './return-context';

interface Client {
  id: string;
  name: string;
  contacts: Array<{ id: string; fullName: string; email: string }>;
}

export function NewPoaForm({
  clients,
  poaMode,
  initialClientId,
  initialPendingDocumentId,
  uploadIntentId,
  returnContext,
}: {
  clients: Client[];
  poaMode: 'MARKDOWN_OTP' | 'PDF_TEMPLATE';
  initialClientId?: string;
  initialPendingDocumentId?: string;
  uploadIntentId?: string;
  returnContext?: PoaCreateReturnContext;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createPoaAction,
    null,
  );
  const [clientId, setClientId] = useState(
    clients.some((client) => client.id === initialClientId)
      ? (initialClientId ?? '')
      : (clients[0]?.id ?? ''),
  );
  const [contactId, setContactId] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [signerName, setSignerName] = useState('');

  const client = clients.find((c) => c.id === clientId);
  const pendingDocumentId = state?.pendingDocumentId ?? initialPendingDocumentId;

  function onContactChange(id: string) {
    setContactId(id);
    if (id) {
      const c = client?.contacts.find((x) => x.id === id);
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
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="clientId">
            Mandant
          </label>
          <select
            id="clientId"
            name="clientId"
            className="input"
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              setContactId('');
              setSignerEmail('');
              setSignerName('');
            }}
            required
            disabled={Boolean(pendingDocumentId || returnContext)}
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
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
          >
            <option value="">— manuell eingeben —</option>
            {client?.contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.fullName} ({c.email})
              </option>
            ))}
          </select>
        </div>
      </div>

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
