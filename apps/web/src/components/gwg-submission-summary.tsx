import { ChevronRight, FileCheck, IdCard, UserRound } from 'lucide-react';
import { fmtDateShort, fmtDateTimeShort } from '@/lib/fmt';
import { DocumentPreviewButton } from '@/components/document-preview';

export interface GwgSummaryDocument {
  id: string;
  title: string;
  createdAt: string | null;
}

export interface GwgSummaryOwner {
  id: string;
  fullName: string;
  birthDate: string | null;
  birthPlace: string | null;
  nationality: string | null;
  residence: string | null;
  ownershipPct: string | null;
  isPep: boolean;
  notes: string | null;
}

export interface GwgSummaryIdDocument {
  id: string;
  type: string;
  ownerName: string;
  number: string | null;
  issuedBy: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  notes: string | null;
  document: GwgSummaryDocument | null;
}

export interface GwgSummaryClient {
  name: string;
  kind?: string | null;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  countryIso: string | null;
  allowActive?: boolean;
}

export interface GwgSummaryInvite {
  cancellationReason?: string | null;
  inviteName: string;
  inviteEmail: string;
  status: string;
  createdAt: string | null;
  expiresAt: string | null;
  submittedAt: string | null;
}

export interface GwgSubmissionSummaryData {
  client: GwgSummaryClient;
  invite: GwgSummaryInvite | null;
  owners: GwgSummaryOwner[];
  idDocuments: GwgSummaryIdDocument[];
  uploadedDocuments: GwgSummaryDocument[];
}

const idTypeLabels: Record<string, string> = {
  PERSONALAUSWEIS: 'Personalausweis',
  REISEPASS: 'Reisepass',
  HANDELSREGISTERAUSZUG: 'Handelsregisterauszug',
  GESELLSCHAFTSVERTRAG: 'Gesellschaftsvertrag',
  VOLLMACHT: 'Vollmacht',
  TRANSPARENZREGISTER_AUSZUG: 'Transparenzregister-Auszug',
  SONSTIGES: 'Sonstiges',
};

const statusLabels: Record<string, string> = {
  PENDING: 'Versendet',
  STARTED: 'In Bearbeitung',
  SUBMITTED: 'Übermittelt',
  EXPIRED: 'Abgelaufen',
  CANCELLED: 'Abgebrochen',
};

function fmtMaybeDate(value: string | null): string {
  return value ? fmtDateShort(new Date(value)) : '—';
}

function fmtMaybeDateTime(value: string | null): string {
  return value ? fmtDateTimeShort(new Date(value)) : '—';
}

function address(client: GwgSummaryClient): string {
  return (
    [client.street, [client.postalCode, client.city].filter(Boolean).join(' '), client.countryIso]
      .filter(Boolean)
      .join(', ') || '—'
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm text-primary font-medium break-words">{value || '—'}</dd>
    </div>
  );
}

export function GwgSubmissionSummary({
  data,
  title = 'Eingereichte GwG-Angaben',
}: {
  data: GwgSubmissionSummaryData;
  title?: string;
}) {
  const hasSubmission =
    data.owners.length > 0 || data.idDocuments.length > 0 || data.uploadedDocuments.length > 0;

  return (
    <section className="card p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-primary">{title}</h2>
          <p className="text-sm text-muted mt-1">
            Stammdaten, wirtschaftlich Berechtigte und hochgeladene Nachweise im Prüfkontext.
          </p>
        </div>
        {data.invite && (
          <span className={data.invite.status === 'SUBMITTED' ? 'badge-green' : 'badge-yellow'}>
            {statusLabels[data.invite.status] ?? data.invite.status}
          </span>
        )}
      </div>

      {data.invite && (
        <dl className="grid grid-cols-1 md:grid-cols-3 gap-3 rounded-md border border-default bg-gray-50 p-3">
          <Field
            label="Eingeladen"
            value={`${data.invite.inviteName} · ${data.invite.inviteEmail}`}
          />
          <Field label="Gültig bis" value={fmtMaybeDateTime(data.invite.expiresAt)} />
          <Field label="Übermittelt" value={fmtMaybeDateTime(data.invite.submittedAt)} />
          {data.invite.cancellationReason && (
            <Field
              label="Hinweis zur abgebrochenen Einladung"
              value={data.invite.cancellationReason}
            />
          )}
        </dl>
      )}

      <div>
        <h3 className="text-sm font-semibold text-primary mb-3">Mandanten-Stammdaten</h3>
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Name / Firma" value={data.client.name} />
          <Field label="Rechtsform / Art" value={data.client.kind ?? null} />
          <Field label="Adresse" value={address(data.client)} />
        </dl>
      </div>

      {!hasSubmission && (
        <div className="rounded-md border border-dashed border-strong p-4 text-sm text-muted">
          Noch keine hochgeladenen oder übermittelten GwG-Unterlagen vorhanden.
        </div>
      )}

      {data.owners.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-primary mb-3 flex items-center gap-2">
            <UserRound className="h-4 w-4 text-brand-600" />
            Wirtschaftlich Berechtigte
          </h3>
          <div className="space-y-3">
            {data.owners.map((owner) => (
              <div key={owner.id} className="rounded-md border border-default p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="font-medium text-primary">{owner.fullName}</span>
                  {owner.isPep && <span className="badge-red">PEP</span>}
                </div>
                <dl className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Field label="Geburtsdatum" value={fmtMaybeDate(owner.birthDate)} />
                  <Field label="Geburtsort" value={owner.birthPlace} />
                  <Field label="Staatsangehörigkeit" value={owner.nationality} />
                  <Field label="Wohnadresse" value={owner.residence} />
                  <Field
                    label="Anteil"
                    value={owner.ownershipPct ? `${owner.ownershipPct} %` : null}
                  />
                  <Field label="Notiz" value={owner.notes} />
                </dl>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.idDocuments.length > 0 && (
        <details className="details-box" open={data.idDocuments.length <= 3}>
          <summary>
            <ChevronRight className="h-4 w-4" />
            <IdCard className="h-4 w-4 text-brand-600" />
            Identitäts- und Rechtsträgernachweise
            <span className="badge badge-gray">{data.idDocuments.length}</span>
          </summary>
          <div className="details-body">
            <ul className="divide-y divide-border-subtle border border-default rounded-md">
              {data.idDocuments.map((doc) => {
                const personal = doc.type === 'PERSONALAUSWEIS' || doc.type === 'REISEPASS';
                return (
                  <li key={doc.id} className="p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <FileCheck className="h-4 w-4 text-green-600" />
                      <span className="font-medium text-primary">
                        {idTypeLabels[doc.type] ?? doc.type}
                      </span>
                      {personal && <span className="text-xs text-muted">für {doc.ownerName}</span>}
                      {doc.expiryDate && new Date(doc.expiryDate) < new Date() && (
                        <span className="badge-red">abgelaufen</span>
                      )}
                    </div>
                    {personal && (
                      <dl className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
                        <Field label="Nummer" value={doc.number} />
                        <Field label="Ausgestellt am" value={fmtMaybeDate(doc.issueDate)} />
                        <Field label="Gültig bis" value={fmtMaybeDate(doc.expiryDate)} />
                        <Field label="Behörde" value={doc.issuedBy} />
                      </dl>
                    )}
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-muted">{doc.notes ?? ''}</span>
                      {doc.document && (
                        <div className="flex items-center gap-1">
                          <span className="text-muted truncate">{doc.document.title}</span>
                          <DocumentPreviewButton
                            documentId={doc.document.id}
                            documentTitle={doc.document.title}
                          />
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </details>
      )}

      {data.uploadedDocuments.length > 0 && (
        <details className="details-box">
          <summary>
            <ChevronRight className="h-4 w-4" />
            <FileCheck className="h-4 w-4 text-brand-600" />
            Hochgeladene Unterlagen aus der Einladung
            <span className="badge badge-gray">{data.uploadedDocuments.length}</span>
          </summary>
          <div className="details-body">
            <ul className="divide-y divide-border-subtle border border-default rounded-md">
              {data.uploadedDocuments.map((doc) => (
                <li
                  key={doc.id}
                  className="px-4 py-3 flex items-center justify-between gap-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-primary truncate">{doc.title}</p>
                    <p className="text-xs text-muted">
                      {doc.createdAt ? fmtDateTimeShort(new Date(doc.createdAt)) : '—'}
                    </p>
                  </div>
                  <DocumentPreviewButton documentId={doc.id} documentTitle={doc.title} />
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}
    </section>
  );
}
