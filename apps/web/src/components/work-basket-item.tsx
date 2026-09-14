import Link from 'next/link';
import { CalendarClock, CalendarDays, Inbox, Phone } from 'lucide-react';
import { fmtDateShort, fmtDateTimeShort, fmtTimeShort } from '@/lib/fmt';
import type { WorkBasketItem, WorkBasketKind } from '@/server/work/basket';
import { MyDayToggle } from '@/app/staff/(protected)/dashboard/my-day-toggle';

export const WORK_KIND_LABELS: Record<WorkBasketKind, string> = {
  workflow: 'Workflows',
  reminder: 'Wiedervorlagen',
  appointment: 'Termine',
  'phone-note': 'Telefonzettel',
  'portal-inbox': 'Mandantenpost',
};

const BUCKET_LABELS = {
  overdue: 'Überfällig',
  today: 'Heute',
  later: 'Später',
  undated: 'Ohne Termin',
} as const;

function timing(item: WorkBasketItem): string | null {
  if (item.kind === 'appointment' && item.startsAt && item.endsAt) {
    return `${fmtDateShort(item.startsAt)} · ${fmtTimeShort(item.startsAt)}–${fmtTimeShort(item.endsAt)}`;
  }
  if ((item.kind === 'workflow' || item.kind === 'reminder') && item.dueAt) {
    return `fällig ${fmtDateShort(item.dueAt)}`;
  }
  if (item.occurredAt) return `eingegangen ${fmtDateTimeShort(item.occurredAt)}`;
  return null;
}

/** Gemeinsame Zeile für Arbeitskorb und Dashboard, mit eigenständiger Erledigen-Aktion. */
export function WorkBasketItemRow({
  item,
  displayBucket = false,
}: {
  item: WorkBasketItem;
  displayBucket?: boolean;
}) {
  const time = timing(item);
  const isWorkflow = item.kind === 'workflow';
  const Icon =
    item.kind === 'reminder'
      ? CalendarClock
      : item.kind === 'appointment'
        ? CalendarDays
        : item.kind === 'phone-note'
          ? Phone
          : Inbox;

  return (
    <li className="work-basket-row flex items-start transition-colors">
      {isWorkflow && (
        <div className="shrink-0 py-3 pl-5">
          <MyDayToggle id={item.sourceId} />
        </div>
      )}
      <Link
        href={item.href}
        className={`flex min-w-0 flex-1 items-start gap-3 py-3 pr-5 ${isWorkflow ? 'pl-3' : 'pl-5'}`}
      >
        {!isWorkflow && (
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-muted">
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <p className="min-w-0 flex-1 break-words text-sm font-medium text-primary">
              {item.title}
            </p>
            <span className="text-[10px] text-muted">{WORK_KIND_LABELS[item.kind]}</span>
          </div>
          {item.context && <p className="truncate text-xs text-muted">{item.context}</p>}
          {(time || displayBucket) && (
            <p
              className={
                item.bucket === 'overdue'
                  ? 'text-xs font-medium text-red-700'
                  : 'text-xs text-muted'
              }
            >
              {displayBucket && BUCKET_LABELS[item.bucket]}
              {displayBucket && time && ' · '}
              {time}
            </p>
          )}
        </div>
      </Link>
    </li>
  );
}
