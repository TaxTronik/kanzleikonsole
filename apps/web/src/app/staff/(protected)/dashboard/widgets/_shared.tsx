// =============================================================================
// Dashboard-Widget-Shared-Utilities
//
// Geteilt zwischen allen Widget-Modulen unterhalb `dashboard/widgets/`. Vorher
// inline in `widgets.tsx` (962 LoC); jetzt zentral, damit jedes Widget seine
// eigene überschaubare Datei haben kann.
// =============================================================================

import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import type { TxClient } from '@taxtronik/db';

// Prisma-Transaktions-Client aus withTenantContext (RLS-gebunden).
export type Tx = TxClient;

export interface RenderCtx {
  tx: Tx;
  staffId: string;
  isAdmin?: boolean;
}

export const NOTICE_KIND_LABELS: Record<string, string> = {
  USTA: 'USt-Voranmeldung',
  UST_JAHR: 'USt-Jahresbescheid',
  EST: 'Einkommensteuer',
  KST: 'Körperschaftsteuer',
  GEWST_MESSBESCHEID: 'GewSt-Messbescheid',
  GEWST: 'GewSt-Bescheid',
  LSTA: 'LSt-Anmeldung',
  FESTSTELLUNG: 'Feststellungsbescheid',
  ZERLEGUNG: 'Zerlegungsbescheid',
  SONSTIGE: 'Sonstige',
};

/**
 * List-Widget-Skelett: Header (optional Icon + Title), Body als ul mit
 * Dividers, optional Footer. Body scrollt; Header/Footer bleiben sichtbar.
 */
export function ListShell({
  icon: Icon,
  title,
  children,
  emptyText,
  isEmpty,
  footer,
}: {
  icon?: LucideIcon;
  title: string;
  children: React.ReactNode;
  emptyText: string;
  isEmpty: boolean;
  footer?: React.ReactNode;
}) {
  return (
    <div className="card h-full flex flex-col">
      <div className="px-5 py-3 border-b border-default flex items-center gap-2 shrink-0">
        {Icon && <Icon className="h-4 w-4 text-muted" />}
        <h2 className="text-sm font-medium text-primary">{title}</h2>
      </div>
      {isEmpty ? (
        <p className="px-5 py-8 text-sm text-muted text-center flex-1">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-border-subtle overflow-y-auto scrollbar-thin flex-1 min-h-0">
          {children}
        </ul>
      )}
      {footer && (
        <div className="px-5 py-2 border-t border-default text-xs text-muted shrink-0">
          {footer}
        </div>
      )}
    </div>
  );
}

/**
 * KPI-Karte — eine Zahl + Label, klickbar. `accent='yellow'` markiert
 * Achtung-Werte (Inbox-Style) sobald `value > 0`.
 */
export async function kpi(
  ctx: RenderCtx,
  Icon: LucideIcon,
  label: string,
  href: string,
  count: (t: Tx) => Promise<number>,
  accent: 'gray' | 'yellow' = 'gray',
): Promise<React.ReactNode> {
  let value = 0;
  try {
    value = await count(ctx.tx);
  } catch {
    // Bei DB-Fehler den Wert 0 anzeigen, statt das ganze Dashboard zu kippen.
  }
  return (
    <Link
      href={href}
      className="card h-full p-4 hover:bg-gray-50 transition-colors group flex flex-col justify-between"
    >
      <div className="flex items-center justify-between">
        <Icon
          className={
            accent === 'yellow' && value > 0
              ? 'h-4 w-4 text-yellow-600'
              : 'h-4 w-4 text-disabled'
          }
        />
      </div>
      <div>
        <p className="text-xs font-medium text-muted uppercase tracking-wide truncate">
          {label}
        </p>
        <p className="text-2xl font-bold text-primary">{value}</p>
      </div>
    </Link>
  );
}
