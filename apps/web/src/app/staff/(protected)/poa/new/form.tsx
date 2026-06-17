'use client';

import { useState } from 'react';
import { createPoaAction } from '../actions';

interface Client {
  id: string;
  name: string;
  contacts: Array<{ id: string; fullName: string; email: string }>;
}

export function NewPoaForm({ clients, poaMode }: { clients: Client[]; poaMode: 'MARKDOWN_OTP' | 'PDF_TEMPLATE' }) {
  const today = new Date().toISOString().slice(0, 10);
  const [clientId, setClientId] = useState(clients[0]?.id ?? '');
  const [contactId, setContactId] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [signerName, setSignerName] = useState('');

  const client = clients.find((c) => c.id === clientId);

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
    <form action={createPoaAction} className="card p-6 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="clientId">Mandant</label>
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
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="signerContactId">Bestehender Kontakt (optional)</label>
          <select
            id="signerContactId"
            name="signerContactId"
            className="input"
            value={contactId}
            onChange={(e) => onContactChange(e.target.value)}
          >
            <option value="">— manuell eingeben —</option>
            {client?.contacts.map((c) => (
              <option key={c.id} value={c.id}>{c.fullName} ({c.email})</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="signerName">Unterzeichner-Name</label>
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
          <label className="label" htmlFor="signerEmail">Unterzeichner-E-Mail</label>
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
        <label className="label" htmlFor="subject">Betreff</label>
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
          <label className="label" htmlFor="scope">Umfang (Markdown)</label>
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
        <div className="rounded-md border border-default bg-surface p-4 text-sm text-muted">
          Modus „PDF-Template (extern)": der Vollmachtstext wird außerhalb von taxtronik
          gepflegt (externe Vollmachtsdatenbank). Ein Inline-Textentfall entfällt hier —
          die externe PDF kann nach dem Anlegen am Datensatz hinterlegt werden.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="validFrom">Gültig ab</label>
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
          <label className="label" htmlFor="validUntil">Gültig bis (optional)</label>
          <input
            id="validUntil"
            name="validUntil"
            type="date"
            className="input"
          />
        </div>
      </div>

      <div className="flex gap-2">
        <button type="submit" className="btn-primary">Anlegen</button>
        <p className="text-xs text-muted self-center">
          Nach Anlegen können Sie die Vollmacht zur Unterschrift senden.
        </p>
      </div>
    </form>
  );
}
