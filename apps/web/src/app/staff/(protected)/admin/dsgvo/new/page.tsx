import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';

import { createDsgvoRequestAction } from '../actions';

export default async function NewDsgvoRequestPage() {
  await requireStaffPage({ admin: true });

  return (
    <div className="p-8 max-w-2xl">
      <div className="flex items-start gap-4 mb-6">
        <Link
          href="/staff/admin/dsgvo"
          aria-label="Zurück"
          className="text-disabled hover:text-secondary mt-1"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-bold text-primary">Neue DSGVO-Anfrage</h1>
      </div>

      <form action={createDsgvoRequestAction} className="card p-6 space-y-4">
        <div>
          <label className="label" htmlFor="type">
            Typ der Anfrage
          </label>
          <select id="type" name="type" className="input" required defaultValue="ACCESS">
            <option value="ACCESS">Auskunft (Art. 15)</option>
            <option value="RECTIFICATION">Berichtigung (Art. 16)</option>
            <option value="ERASURE">Löschung (Art. 17)</option>
            <option value="RESTRICTION">Einschränkung (Art. 18)</option>
            <option value="PORTABILITY">Datenübertragbarkeit (Art. 20)</option>
            <option value="OBJECTION">Widerspruch (Art. 21)</option>
          </select>
        </div>

        <div>
          <label className="label" htmlFor="subjectType">
            Betroffenen-Typ
          </label>
          <select
            id="subjectType"
            name="subjectType"
            className="input"
            required
            defaultValue="CLIENT_CONTACT"
          >
            <option value="CLIENT_CONTACT">Mandanten-Ansprechpartner</option>
            <option value="STAFF_USER">Mitarbeiter</option>
            <option value="CLIENT">Mandant (Firma)</option>
            <option value="EXTERNAL">Externe Person</option>
          </select>
        </div>

        <div>
          <label className="label" htmlFor="subjectName">
            Name der betroffenen Person
          </label>
          <input
            id="subjectName"
            name="subjectName"
            type="text"
            className="input"
            required
            maxLength={200}
          />
        </div>

        <div>
          <label className="label" htmlFor="subjectEmail">
            E-Mail-Adresse
          </label>
          <input
            id="subjectEmail"
            name="subjectEmail"
            type="email"
            className="input"
            required
            maxLength={255}
          />
        </div>

        <div>
          <label className="label" htmlFor="subjectRefId">
            Referenz-ID (optional, falls in System bekannt)
          </label>
          <input
            id="subjectRefId"
            name="subjectRefId"
            type="text"
            className="input"
            placeholder="UUID — z. B. ID des ClientContact"
          />
        </div>

        <div>
          <label className="label" htmlFor="description">
            Beschreibung der Anfrage
          </label>
          <textarea
            id="description"
            name="description"
            rows={5}
            className="input"
            required
            minLength={1}
            maxLength={5000}
            placeholder="Was wird konkret verlangt? Anlass? Welche Daten betroffen?"
          />
        </div>

        <div>
          <label className="label" htmlFor="receivedAt">
            Tatsächlich eingegangen am
          </label>
          <input id="receivedAt" name="receivedAt" type="date" className="input" required />
          <p className="text-xs text-muted mt-1">
            Die Monatsfrist wird aus diesem Eingangstag berechnet, nicht aus dem
            Erfassungszeitpunkt.
          </p>
        </div>

        <div className="text-xs text-muted bg-gray-50 rounded-md p-3">
          <strong>Frist:</strong> Antwort innerhalb 1 Monat (Art. 12 DSGVO), verlängerbar auf 3
          Monate bei komplexen Anfragen (mit Begründung).
        </div>

        <button type="submit" className="btn-primary">
          Anfrage erfassen
        </button>
      </form>
    </div>
  );
}
