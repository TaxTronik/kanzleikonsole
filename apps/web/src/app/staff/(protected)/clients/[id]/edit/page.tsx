// =============================================================================
// /staff/clients/:id/edit — Mandanten-Stammdaten-Bearbeitung
//
// Zwei klar getrennte Sektionen:
//   1. Verwaltungsdaten (frei änderbar): DATEV/Addison-Nr, Notizen, Mails,
//      Bearbeiter-Zuordnung
//   2. GwG-relevante Daten: Name, Adresse, USt-ID, Rechtsform.
//      Änderungen lösen GwG-Re-Verifikation aus → bestehender Check landet
//      auf IN_REVIEW, Mandant bleibt aktiv aber visuell markiert.
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, AlertTriangle } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { saveAdminFieldsAction, saveGwgFieldsAction, setResponsibilitiesAction } from './actions';
import { CustomFieldsForm } from './custom-fields-form';

const KIND_LABELS: Record<string, string> = {
  NATPERS: 'Natürliche Person',
  JURPERS: 'Juristische Person',
  PERSGES: 'Personengesellschaft',
};

export default async function ClientEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const client = await tx.client.findUnique({
        where: { id },
        include: { responsibilities: true },
      });
      if (!client) return null;
      const [staff, customDefs, customValues] = await Promise.all([
        tx.staffUser.findMany({
          where: { active: true },
          orderBy: { fullName: 'asc' },
          select: { id: true, fullName: true, email: true },
        }),
        tx.clientCustomFieldDef.findMany({
          where: { active: true },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        }),
        tx.clientCustomFieldValue.findMany({
          where: { clientId: id },
        }),
      ]);
      return { client, staff, customDefs, customValues };
    },
  );
  if (!data) notFound();
  const { client, staff, customDefs, customValues } = data;

  const customDefsForKind = customDefs.filter(
    (d) => d.appliesTo.length === 0 || d.appliesTo.includes(client.kind),
  );
  const valuesById = new Map(customValues.map((v) => [v.fieldId, v.value]));
  const berufstraegerId =
    client.responsibilities.find((r) => r.role === 'BERUFSTRAEGER')?.staffId ?? '';
  const hauptbearbeiterIds = new Set(
    client.responsibilities.filter((r) => r.role === 'HAUPTBEARBEITER').map((r) => r.staffId),
  );

  return (
    <div className="p-8 max-w-4xl">
      <Link
        href={`/staff/clients/${id}`}
        className="text-sm text-gray-500 hover:text-gray-900 inline-flex items-center gap-1 mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Zurück zum Mandanten
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">Stammdaten bearbeiten</h1>
      <p className="text-gray-500 text-sm mb-6">{client.name}</p>

      {/* Sektion 1: Verwaltungsdaten (frei änderbar) */}
      <form action={saveAdminFieldsAction} className="card p-6 mb-6">
        <h2 className="text-sm font-medium text-gray-900 mb-4">Verwaltung (frei änderbar)</h2>
        <input type="hidden" name="clientId" value={client.id} />
        <div className="grid grid-cols-2 gap-4">
          <Field label="DATEV-Nr." name="datevNo" defaultValue={client.datevNo ?? ''} />
          <Field label="Addison-Nr." name="addisonNo" defaultValue={client.addisonNo ?? ''} />
          <Field
            label="Rechnungs-E-Mail"
            name="invoiceEmail"
            type="email"
            defaultValue={client.invoiceEmail ?? ''}
            colspan={2}
          />
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              Priorität
            </label>
            <select
              name="priority"
              defaultValue={client.priority ?? ''}
              className="input w-full"
            >
              <option value="">— keine —</option>
              <option value="A">A — wichtigster Mandant</option>
              <option value="B">B — Standard</option>
              <option value="C">C — nachrangig</option>
            </select>
          </div>
        </div>
        <div className="mt-4">
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            Interne Akten-Notiz <span className="text-gray-400">(nur Kanzlei, nie für Mandant sichtbar)</span>
          </label>
          <textarea
            name="internalNotes"
            defaultValue={client.internalNotes ?? ''}
            rows={4}
            maxLength={10_000}
            className="input w-full font-mono text-sm"
            placeholder="Markdown — Hintergrundinformationen, Hinweise zum Mandanten, persönliche Eigenheiten…"
          />
        </div>
        <div className="flex justify-end mt-4">
          <button type="submit" className="btn-primary">Speichern</button>
        </div>
      </form>

      {/* Bearbeiter-Zuordnung */}
      <form action={setResponsibilitiesAction} className="card p-6 mb-6">
        <h2 className="text-sm font-medium text-gray-900 mb-1">Zuständigkeit</h2>
        <p className="text-xs text-gray-500 mb-4">
          Berufsträger: verantwortlicher Steuerberater (§ 32 StBerG). Bearbeiter:
          Mitarbeiter, die den Mandanten betreuen und in „Meine Mandanten" sehen.
        </p>
        <input type="hidden" name="clientId" value={client.id} />

        <div className="mb-4">
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Verantwortlicher Berufsträger
          </label>
          <select name="berufstraegerId" defaultValue={berufstraegerId} className="input w-full">
            <option value="">— kein Berufsträger zugewiesen —</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName}
              </option>
            ))}
          </select>
        </div>

        <div>
          <p className="text-xs font-medium text-gray-700 mb-2">Bearbeiter (Mehrfachauswahl)</p>
          <div className="space-y-2">
            {staff.map((s) => (
              <label key={s.id} className="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  name="hauptbearbeiterIds"
                  value={s.id}
                  defaultChecked={hauptbearbeiterIds.has(s.id)}
                  className="rounded border-gray-300 text-brand-600"
                />
                <span className="text-gray-900">{s.fullName}</span>
                <span className="text-xs text-gray-500">{s.email}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <button type="submit" className="btn-primary">Zuordnung speichern</button>
        </div>
      </form>

      {/* Custom-Felder (tenant-individuell) */}
      {customDefsForKind.length > 0 && (
        <div className="mb-6">
          <CustomFieldsForm
            clientId={client.id}
            defs={customDefsForKind.map((d) => ({
              id: d.id,
              key: d.key,
              label: d.label,
              type: d.type as
                | 'TEXT' | 'TEXTAREA' | 'NUMBER' | 'MONEY' | 'DATE' | 'SELECT' | 'CHECKBOX' | 'URL',
              helpText: d.helpText,
              options:
                Array.isArray(d.options)
                  ? (d.options as Array<{ value: string; label: string }>)
                  : null,
            }))}
            initialValues={Object.fromEntries(
              customDefsForKind.map((d) => [d.id, valuesById.get(d.id) ?? null]),
            )}
          />
        </div>
      )}

      {/* Sektion 2: GwG-relevante Daten */}
      <form action={saveGwgFieldsAction} className="card p-6 border-amber-200">
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
          <div>
            <h2 className="text-sm font-medium text-gray-900">GwG-relevante Stammdaten</h2>
            <p className="text-xs text-amber-700 mt-1">
              Änderungen an Name, Adresse, USt-ID oder Rechtsform setzen den GwG-Status
              auf <strong>IN_REVIEW</strong> — der Mandant muss erneut identifiziert
              werden (§§ 10 ff. GwG).
            </p>
          </div>
        </div>
        <input type="hidden" name="clientId" value={client.id} />
        <div className="grid grid-cols-2 gap-4">
          <Field label="Firma / Name" name="name" defaultValue={client.name} required colspan={2} />
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Rechtsform</label>
            <select name="kind" defaultValue={client.kind} className="input w-full" required>
              {Object.entries(KIND_LABELS).map(([k, l]) => (
                <option key={k} value={k}>{l}</option>
              ))}
            </select>
          </div>
          <Field label="USt-ID" name="vatId" defaultValue={client.vatId ?? ''} placeholder="DE123456789" />
          <Field label="Straße" name="street" defaultValue={client.street ?? ''} colspan={2} />
          <Field label="PLZ" name="postalCode" defaultValue={client.postalCode ?? ''} />
          <Field label="Ort" name="city" defaultValue={client.city ?? ''} />
          <Field label="Land (ISO 2)" name="countryIso" defaultValue={client.countryIso ?? 'DE'} />
        </div>
        <div className="flex justify-end mt-4">
          <button type="submit" className="btn-primary">GwG-Stammdaten speichern</button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  name,
  defaultValue,
  type = 'text',
  required,
  placeholder,
  colspan,
}: {
  label: string;
  name: string;
  defaultValue: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  colspan?: 2;
}) {
  return (
    <div className={colspan === 2 ? 'col-span-2' : ''}>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue}
        required={required}
        placeholder={placeholder}
        className="input w-full"
      />
    </div>
  );
}
