// =============================================================================
// Cockpit-Karten aus den Kopfdaten (Review-Befund K-04): Ansprechpartner,
// Stammdaten, Custom-Felder und GwG-Status. Ihre Daten kommen mit der
// Mandantenauflösung (loadClientCockpitHeader), die die Seite ohnehin für
// Zugriff, Kopf und Navigation braucht; sie rendern deshalb sofort und ohne
// eigene Transaktion. Ob die Custom-Felder-Karte erscheint, steht vor dem
// Layout fest (customFieldsForKind), damit das Grid keine leere Zelle setzt.
// =============================================================================

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ClientContactsPanel } from '@/components/client-contacts-panel';
import { fmtDateShort, fmtEUR } from '@/lib/fmt';
import { CLIENT_KIND_LABELS } from '@/lib/domain-labels';
import {
  deactivateContactAction,
  inviteContactAction,
  rotateIcalTokenAction,
  updateContactAction,
} from './contacts/actions';
import type { ClientCockpitClient, ClientCockpitHeaderData } from './_data';

type CustomFieldDef = ClientCockpitHeaderData['customDefs'][number];
type GwgCheck = ClientCockpitClient['gwgChecks'][number];

const GWG_EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000;

export function ContactsCockpitCard({
  clientId,
  contacts,
}: {
  clientId: string;
  contacts: ClientCockpitClient['contacts'];
}) {
  return (
    <ClientContactsPanel
      key="contacts"
      clientId={clientId}
      actions={{
        invite: inviteContactAction,
        deactivate: deactivateContactAction,
        update: updateContactAction,
        rotateIcalToken: rotateIcalTokenAction,
      }}
      contacts={contacts.map((c) => ({
        id: c.id,
        email: c.email,
        fullName: c.fullName,
        phone: c.phone,
        role: c.role,
        lastLoginAt: c.lastLoginAt,
      }))}
    />
  );
}

export function MasterDataCockpitCard({
  client,
}: {
  client: Pick<ClientCockpitClient, 'kind' | 'datevNo' | 'addisonNo' | 'createdAt'>;
}) {
  return (
    <div key="master_data" className="card p-6">
      <h2 className="text-sm font-medium text-muted uppercase tracking-wide mb-4">Stammdaten</h2>
      <dl className="space-y-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">Typ</dt>
          <dd className="text-primary font-medium">{CLIENT_KIND_LABELS[client.kind]}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">DATEV-Nr.</dt>
          <dd className="text-primary font-medium">{client.datevNo ?? '—'}</dd>
        </div>
        {client.addisonNo && (
          <div className="flex justify-between">
            <dt className="text-muted">Addison-Nr.</dt>
            <dd className="text-primary font-medium">{client.addisonNo}</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-muted">Angelegt</dt>
          <dd className="text-primary font-medium">{fmtDateShort(client.createdAt)}</dd>
        </div>
      </dl>
    </div>
  );
}

/** Aktive Custom-Felder, die für die Mandantenart gelten (leere Zuordnung = alle Arten). */
export function customFieldsForKind(
  defs: CustomFieldDef[],
  kind: ClientCockpitClient['kind'],
): CustomFieldDef[] {
  return defs.filter((d) => d.appliesTo.length === 0 || d.appliesTo.includes(kind));
}

export function formatCustomValue(type: string, value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') {
    return <span className="text-disabled font-normal">—</span>;
  }
  if (type === 'CHECKBOX') return value ? 'Ja' : 'Nein';
  if (type === 'MONEY' && typeof value === 'number') return fmtEUR(value);
  if (type === 'NUMBER' && typeof value === 'number') return value.toLocaleString('de-DE');
  if (type === 'DATE' && typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : fmtDateShort(d);
  }
  if (type === 'URL' && typeof value === 'string') {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        className="text-brand-700 hover:underline"
      >
        {value}
      </a>
    );
  }
  return String(value);
}

export function CustomFieldsCockpitCard({
  defs,
  values,
}: {
  defs: CustomFieldDef[];
  values: ClientCockpitHeaderData['customValues'];
}) {
  const valuesById = new Map(values.map((v) => [v.fieldId, v.value]));
  return (
    <div key="custom_fields" className="card p-6">
      <h2 className="text-sm font-medium text-muted uppercase tracking-wide mb-4">Custom-Felder</h2>
      <dl className="space-y-3 text-sm">
        {defs.map((d) => (
          <div key={d.id} className="flex justify-between gap-3">
            <dt className="text-muted">{d.label}</dt>
            <dd className="text-primary font-medium text-right break-words">
              {formatCustomValue(d.type, valuesById.get(d.id))}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Läuft die Gültigkeit der GwG-Prüfung in weniger als 30 Tagen ab (oder ist sie abgelaufen)? */
export function gwgCheckExpiresSoon(validUntil: Date | null, now: Date): boolean {
  return Boolean(validUntil && validUntil.getTime() - now.getTime() < GWG_EXPIRY_WARNING_MS);
}

export function GwgStatusCockpitCard({
  clientId,
  latest,
  now,
}: {
  clientId: string;
  latest: GwgCheck | undefined;
  now: Date;
}) {
  return (
    <div key="gwg_status" className="card p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wide">GwG-Status</h2>
        <Link
          href={`/staff/clients/${clientId}/gwg`}
          className="text-xs text-brand-700 hover:underline"
        >
          Prüfung öffnen →
        </Link>
      </div>
      <GwgStatusDetails latest={latest} now={now} />
    </div>
  );
}

function GwgStatusDetails({ latest, now }: { latest: GwgCheck | undefined; now: Date }) {
  if (!latest) {
    return (
      <p className="text-sm text-secondary">
        Noch keine Prüfung. Erst nach Verifikation kann der Mandant aktiv werden.
      </p>
    );
  }
  const isExpiring = gwgCheckExpiresSoon(latest.validUntil, now);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {latest.status === 'VERIFIED' && <span className="badge-green">Verifiziert</span>}
        {latest.status === 'IN_REVIEW' && <span className="badge-yellow">In Prüfung</span>}
        {latest.status === 'DRAFT' && <span className="badge-gray">Entwurf</span>}
        {latest.status === 'REJECTED' && <span className="badge-red">Abgelehnt</span>}
        {latest.status === 'EXPIRED' && <span className="badge-red">Abgelaufen</span>}
        {latest.riskLevel === 'HIGH' && <span className="badge-red">Risiko: HIGH</span>}
        {latest.riskLevel === 'MEDIUM' && <span className="badge-yellow">Risiko: MEDIUM</span>}
        {latest.riskLevel === 'LOW' && <span className="badge-green">Risiko: LOW</span>}
      </div>
      {latest.validUntil && (
        <p className={isExpiring ? 'text-xs text-yellow-700' : 'text-xs text-muted'}>
          Gültig bis {fmtDateShort(latest.validUntil)}
          {isExpiring && ' · läuft bald aus'}
        </p>
      )}
    </div>
  );
}
