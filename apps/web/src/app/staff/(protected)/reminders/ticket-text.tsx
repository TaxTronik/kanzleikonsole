import { Fragment } from 'react';
import Link from 'next/link';
import { splitByTicketReferences } from '@/lib/reminder-ticket-references';
import { splitByMentions } from '@/lib/reminder-mentions';

/** REMINDER-TICKET-001: Nummern sind keine Berechtigung. Nur aufgelöste Ziele verlinken. */
export function TicketText({
  text,
  references,
  staffOptions = [],
}: {
  text: string;
  references: ReadonlyArray<{ ticketNumber: number }>;
  staffOptions?: Array<{ id: string; fullName: string }>;
}) {
  const allowed = new Set(references.map((reference) => reference.ticketNumber));
  return splitByTicketReferences(text).map((segment, index) =>
    segment.ticketNumber !== null && allowed.has(segment.ticketNumber) ? (
      <Link
        key={index}
        href={`/staff/reminders/${segment.ticketNumber}`}
        className="text-brand-600 hover:underline font-medium"
      >
        {segment.text}
      </Link>
    ) : (
      <Fragment key={index}>
        {splitByMentions(segment.text, staffOptions).map((part, partIndex) =>
          part.mention ? (
            <span key={partIndex} className="text-brand-600 font-medium">
              {part.text}
            </span>
          ) : (
            <Fragment key={partIndex}>{part.text}</Fragment>
          ),
        )}
      </Fragment>
    ),
  );
}
