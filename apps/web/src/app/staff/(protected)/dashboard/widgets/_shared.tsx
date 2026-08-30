import type { ReactNode } from 'react';
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
import type { BooleanTenantModules } from '@taxtronik/db/tenant-modules';
import { CountUp } from '@/components/count-up';

// Prisma-Transaktions-Client aus withTenantContext (RLS-gebunden).
export type Tx = TxClient;

export interface RenderCtx {
  tx: Tx;
  staffId: string;
  isAdmin?: boolean;
  modules: BooleanTenantModules;
  /**
   * Zugriffsmodell (vertraulich-Flag / RESTRICTED): Mandanten-IDs, die der
   * Mitarbeiter nicht sehen darf — EINMAL pro Dashboard-Render berechnet und
   * an alle Widgets durchgereicht, die Mandantennamen/-inhalte zeigen.
   */
  deniedClientIds?: string[];
}

/**
 * Where-Fragment für Widgets mit Pflicht-`clientId`: blendet Datensätze
 * gesperrter Mandanten aus. Für nullable `clientId` (Termine, Telefonzettel)
 * stattdessen die OR-Variante inline nutzen, damit Einträge ohne
 * Mandantenbezug sichtbar bleiben.
 */
export function notDeniedClient(deniedClientIds: string[] | undefined): {
  clientId?: { notIn: string[] };
} {
  return deniedClientIds?.length ? { clientId: { notIn: deniedClientIds } } : {};
}

export { NOTICE_KIND_LABELS } from '@/lib/domain-labels';

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
  children: ReactNode;
  emptyText: string;
  isEmpty: boolean;
  footer?: ReactNode;
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
        <ul
          aria-label={`${title} – scrollbare Liste`}
          tabIndex={0}
          className="divide-y divide-border-subtle overflow-y-auto scrollbar-thin flex-1 min-h-0"
        >
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
): Promise<ReactNode> {
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
            accent === 'yellow' && value > 0 ? 'h-4 w-4 text-yellow-600' : 'h-4 w-4 text-disabled'
          }
        />
      </div>
      <div>
        <p className="text-xs font-medium text-muted uppercase tracking-wide truncate">{label}</p>
        <p className="text-2xl font-bold text-primary tabular-nums">
          <CountUp value={value} />
        </p>
      </div>
    </Link>
  );
}
