import Link from 'next/link';
import { CornerDownRight, Paperclip, Quote, Users } from 'lucide-react';
import { fmtDateShort, fmtDateTimeShort } from '@/lib/fmt';
import { DocumentActions } from '@/components/document-actions';
import { DocumentUploadButton } from '@/components/document-upload-button';
import type { ReminderDetail } from '@/server/reminders/detail';
import { TicketHistoryPagination } from './ticket-history-pagination';

export function TicketContext({
  detail,
  currentStaffId,
  onUploaded,
}: {
  detail: ReminderDetail;
  currentStaffId: string;
  onUploaded: () => void;
}) {
  const sourceAnalysis = detail.originResearchAnalysisId ?? detail.researchAnalysisId;
  const sourceMarking = detail.originResearchMarkingId ?? detail.researchMarkingId;
  return (
    <div className="space-y-4">
      <section aria-label="Zuständige" className="card p-4 space-y-2">
        <h2 className="text-sm font-medium text-primary inline-flex items-center gap-2">
          <Users className="h-4 w-4 text-disabled" />
          Zuständig ({detail.assignees.length})
        </h2>
        <div className="flex flex-wrap gap-1.5">
          {detail.assignees.map((staff) => (
            <span
              key={staff.staffId}
              className={
                staff.staffId === currentStaffId
                  ? 'badge-brand text-[11px]'
                  : 'badge-gray text-[11px]'
              }
            >
              {staff.fullName}
              {staff.staffId === currentStaffId ? ' (du)' : ''}
            </span>
          ))}
        </div>
        <p className="text-[11px] text-muted">
          Eine gemeinsame Aufgabe — Erledigen gilt für alle Zuständigen.
        </p>
      </section>
      <section aria-label="Verknüpfte Tickets" className="card p-4 space-y-2">
        <h2 className="text-sm font-medium text-primary">Verknüpfte Tickets</h2>
        {detail.references.length === 0 ? (
          <p className="text-xs text-muted">
            Noch keine Verweise. Erwähne ein zugängliches Ticket mit #Nummer in einem Kommentar.
          </p>
        ) : (
          <ul className="space-y-2">
            {detail.references.map((reference) => (
              <li key={`${reference.direction}:${reference.id}`}>
                <Link
                  href={`/staff/reminders/${reference.ticketNumber}`}
                  className="text-sm text-brand-600 hover:underline break-words"
                >
                  #{reference.ticketNumber} {reference.subject}
                </Link>
                <p className="text-[11px] text-muted">
                  {reference.direction === 'incoming'
                    ? 'Verweist auf dieses Ticket'
                    : 'Von diesem Ticket erwähnt'}{' '}
                  · {reference.archivedAt ? 'archiviert' : reference.doneAt ? 'erledigt' : 'offen'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Anhänge" className="card p-4 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-medium text-primary inline-flex items-center gap-2">
            <Paperclip className="h-4 w-4 text-disabled" />
            Anhänge ({detail.attachmentsTotal})
          </h2>
          {!detail.archivedAt && (
            <DocumentUploadButton
              {...(detail.clientId ? { clientId: detail.clientId } : {})}
              reminderId={detail.id}
              buttonLabel="Datei anhängen"
              buttonClassName="btn-secondary text-xs py-1"
              onUploaded={onUploaded}
            />
          )}
        </div>
        {detail.attachments.length === 0 ? (
          <p className="text-xs text-disabled">Noch keine Datei angehängt.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {detail.attachments.map((document) => (
              <li key={document.id} className="py-1.5 flex items-center gap-2 text-sm">
                <div className="flex-1 min-w-0">
                  <p className="text-primary break-words">{document.title}</p>
                  <p className="text-[11px] text-muted">
                    {document.uploadedByName} · {fmtDateTimeShort(new Date(document.createdAt))}
                  </p>
                </div>
                <DocumentActions
                  documentId={document.id}
                  documentTitle={document.title}
                  mimeType={document.mimeType}
                />
              </li>
            ))}
          </ul>
        )}
        <TicketHistoryPagination detail={detail} kind="attachments" />
      </section>
      {(sourceAnalysis ||
        detail.begriff ||
        detail.normAnker.length > 0 ||
        detail.fundstelle ||
        detail.phoneNote) && (
        <section aria-label="Herkunft" className="card p-4 space-y-2">
          <h2 className="text-sm font-medium text-primary">Herkunft und Recherche</h2>
          <div className="flex flex-wrap gap-1.5">
            {detail.begriff && <span className="badge-yellow text-[11px]">{detail.begriff}</span>}
            {detail.normAnker.map((norm) => (
              <span key={norm} className="badge-gray text-[11px] font-mono">
                {norm}
              </span>
            ))}
          </div>
          {detail.fundstelle && (
            <blockquote className="flex gap-1.5 rounded border-l-2 border-strong bg-surface-raised px-2 py-1 text-xs text-secondary italic">
              <Quote className="h-3 w-3 shrink-0 mt-0.5 text-disabled" />
              <span className="break-words">{detail.fundstelle}</span>
            </blockquote>
          )}
          {sourceAnalysis && sourceMarking && detail.clientId && (
            <Link
              href={`/staff/clients/${detail.clientId}/subsumtion/${sourceAnalysis}?marking=${sourceMarking}`}
              className="text-xs text-brand-600 hover:underline inline-block"
            >
              Markierung im Subsumtions-Space öffnen
            </Link>
          )}
          {detail.phoneNote && (
            <p className="text-xs text-muted">
              Telefonnotiz:{' '}
              <Link href="/staff/phone-notes" className="text-brand-600 hover:underline">
                {detail.phoneNote.subject}
              </Link>{' '}
              · {fmtDateShort(new Date(detail.phoneNote.createdAt))}
            </p>
          )}
        </section>
      )}
      {(detail.vorgaenger.length > 0 || detail.folgestufen.length > 0) && (
        <details className="card p-4 space-y-2">
          <summary className="text-sm font-medium text-primary cursor-pointer">
            <CornerDownRight className="h-4 w-4 inline mr-1 text-disabled" />
            Frühere Nachfragekette
          </summary>
          <ol className="space-y-2">
            {detail.vorgaenger.map((item) => (
              <ChainRow key={item.id} item={item} />
            ))}
            <li className="text-sm text-primary font-medium pl-3 border-l-2 border-brand-500">
              #{detail.ticketNumber} {detail.subject}{' '}
              <span className="text-xs text-muted">· dieses Ticket</span>
            </li>
            {detail.folgestufen.map((item) => (
              <ChainRow key={item.id} item={item} />
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function ChainRow({ item }: { item: ReminderDetail['vorgaenger'][number] }) {
  return (
    <li className="pl-3 border-l-2 border-border-subtle">
      <Link
        href={`/staff/reminders/${item.ticketNumber}`}
        className="text-sm text-secondary hover:underline"
      >
        #{item.ticketNumber} {item.subject}
      </Link>
      <p className="text-[11px] text-muted">
        {item.archivedAt ? 'archiviert' : item.doneAt ? 'erledigt' : 'offen'} · fällig{' '}
        {fmtDateShort(new Date(item.dueDate))}
      </p>
    </li>
  );
}
