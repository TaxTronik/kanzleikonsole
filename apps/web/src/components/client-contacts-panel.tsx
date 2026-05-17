'use client';

import { useActionState, useState, useRef, useEffect, useTransition } from 'react';
import { Mail, Phone, UserX, Pencil, Plus, X } from 'lucide-react';
import {
  inviteContactAction,
  deactivateContactAction,
  updateContactAction,
  type ActionResult,
} from '@/app/staff/(protected)/clients/[id]/contacts/actions';

interface Contact {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: string | null;
  lastLoginAt: Date | null;
}

interface Props {
  clientId: string;
  contacts: Contact[];
}

export function ClientContactsPanel({ clientId, contacts }: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    inviteContactAction,
    null,
  );

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      setShowForm(false);
    }
  }, [state]);

  return (
    <div className="card overflow-hidden mb-6">
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
        <div>
          <h2 className="text-sm font-medium text-gray-900">
            Ansprechpartner ({contacts.length})
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Kontaktpersonen beim Mandanten. Per E-Mail bekommen sie Portal-Zugang und Benachrichtigungen.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="btn-secondary text-xs py-1"
        >
          {showForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          {showForm ? 'Schließen' : 'Anlegen'}
        </button>
      </div>

      {showForm && (
        <div className="px-5 py-4 border-b border-gray-200 bg-gray-50/60">
          <form ref={formRef} action={formAction} className="space-y-3">
            <input type="hidden" name="clientId" value={clientId} />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="contact-fullName">Name</label>
                <input id="contact-fullName" name="fullName" type="text" className="input" required minLength={2} maxLength={200} />
              </div>
              <div>
                <label className="label" htmlFor="contact-role">Rolle (optional)</label>
                <input id="contact-role" name="role" type="text" className="input" maxLength={80} placeholder="z. B. Geschäftsführer" />
              </div>
              <div>
                <label className="label" htmlFor="contact-email">E-Mail</label>
                <input id="contact-email" name="email" type="email" className="input" required />
              </div>
              <div>
                <label className="label" htmlFor="contact-phone">Telefon (optional)</label>
                <input id="contact-phone" name="phone" type="tel" className="input" maxLength={50} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" name="sendInvite" value="1" defaultChecked />
              Login-Link per E-Mail senden
            </label>
            {state?.error && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{state.error}</div>
            )}
            <button type="submit" className="btn-primary text-sm" disabled={isPending}>
              {isPending ? 'Speichert…' : 'Anlegen'}
            </button>
          </form>
        </div>
      )}

      {contacts.length === 0 ? (
        <div className="px-6 py-8 text-center">
          <Mail className="h-8 w-8 text-gray-200 mx-auto mb-2" />
          <p className="text-sm text-gray-400">Noch kein Ansprechpartner hinterlegt.</p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {contacts.map((c) =>
            editingId === c.id ? (
              <EditRow
                key={c.id}
                contact={c}
                clientId={clientId}
                onDone={() => setEditingId(null)}
              />
            ) : (
              <ContactRow
                key={c.id}
                contact={c}
                clientId={clientId}
                onEdit={() => setEditingId(c.id)}
              />
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function ContactRow({
  contact,
  clientId,
  onEdit,
}: {
  contact: Contact;
  clientId: string;
  onEdit: () => void;
}) {
  return (
    <li className="px-5 py-3 flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1 grid grid-cols-3 gap-4 items-center">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{contact.fullName}</p>
          {contact.role && <p className="text-xs text-gray-500 truncate">{contact.role}</p>}
        </div>
        <div className="min-w-0 flex items-center gap-1.5 text-xs text-gray-600">
          <Mail className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          <a href={`mailto:${contact.email}`} className="truncate hover:underline">{contact.email}</a>
        </div>
        <div className="min-w-0 flex items-center gap-1.5 text-xs text-gray-600">
          {contact.phone ? (
            <>
              <Phone className="h-3.5 w-3.5 text-gray-400 shrink-0" />
              <a href={`tel:${contact.phone}`} className="truncate hover:underline">{contact.phone}</a>
            </>
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={onEdit}
          className="text-gray-400 hover:text-gray-900 p-1.5"
          title="Bearbeiten"
        >
          <Pencil className="h-4 w-4" />
        </button>
        <form action={deactivateContactAction}>
          <input type="hidden" name="contactId" value={contact.id} />
          <input type="hidden" name="clientId" value={clientId} />
          <button type="submit" className="text-gray-400 hover:text-red-600 p-1.5" title="Deaktivieren">
            <UserX className="h-4 w-4" />
          </button>
        </form>
      </div>
    </li>
  );
}

function EditRow({
  contact,
  clientId,
  onDone,
}: {
  contact: Contact;
  clientId: string;
  onDone: () => void;
}) {
  const [fullName, setFullName] = useState(contact.fullName);
  const [email, setEmail] = useState(contact.email);
  const [role, setRole] = useState(contact.role ?? '');
  const [phone, setPhone] = useState(contact.phone ?? '');
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  function save() {
    setError(null);
    start(async () => {
      const r = await updateContactAction({
        contactId: contact.id,
        clientId,
        fullName: fullName.trim(),
        email: email.trim(),
        phone: phone.trim() || null,
        role: role.trim() || null,
      });
      if (!r.ok) {
        setError(r.error ?? 'Fehler.');
        return;
      }
      onDone();
    });
  }

  return (
    <li className="px-5 py-3 bg-brand-50/30">
      <div className="grid grid-cols-2 gap-3 mb-2">
        <input
          type="text"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          className="input text-sm"
          placeholder="Name"
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="input text-sm"
          placeholder="E-Mail"
          maxLength={255}
        />
        <input
          type="text"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="input text-sm"
          placeholder="Rolle"
          maxLength={80}
        />
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="input text-sm"
          placeholder="Telefon"
          maxLength={50}
        />
      </div>
      <p className="text-xs text-gray-500 mb-2">
        Die E-Mail ist die Portal-Login-Identität — eine Änderung wirkt sich auf
        künftige Magic-Link-Anmeldungen aus.
      </p>
      {error && <div className="rounded-md bg-red-50 p-2 text-xs text-red-700 mb-2">{error}</div>}
      <div className="flex items-center gap-2">
        <button type="button" onClick={save} disabled={isPending} className="btn-primary text-xs py-1">
          {isPending ? 'Speichert…' : 'Speichern'}
        </button>
        <button type="button" onClick={onDone} disabled={isPending} className="btn-secondary text-xs py-1">
          Abbrechen
        </button>
      </div>
    </li>
  );
}
