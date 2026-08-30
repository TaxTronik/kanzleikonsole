import Link from 'next/link';
import type { ReactNode } from 'react';
import { calendarModeHref, type CalendarMode } from './calendar-mode';

export function CalendarModeSwitch({ active, month }: { active: CalendarMode; month?: string }) {
  return (
    <div className="toggle-group" role="group" aria-label="Kalenderansicht">
      <CalendarModeOption active={active} mode="calendar" month={month}>
        Kanzleikalender
      </CalendarModeOption>
      <CalendarModeOption active={active} mode="tax-deadlines" month={month}>
        Nur Steuertermine
      </CalendarModeOption>
    </div>
  );
}

function CalendarModeOption({
  active,
  mode,
  month,
  children,
}: {
  active: CalendarMode;
  mode: CalendarMode;
  month?: string;
  children: ReactNode;
}) {
  const className =
    active === mode
      ? 'px-3 py-1.5 bg-brand-600 text-on-brand'
      : 'px-3 py-1.5 text-secondary hover:bg-gray-50';

  if (active === mode) {
    return (
      <span className={className} aria-current="page">
        {children}
      </span>
    );
  }

  return (
    <Link href={calendarModeHref(mode, month)} className={className}>
      {children}
    </Link>
  );
}
