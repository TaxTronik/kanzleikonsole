// Herkunfts-Badge einer BWA-Planung, gemeinsam genutzt von Portal-Vergleich und
// Staff-Planansicht (vorher in app/portal/(protected)/bwa/plan/plan-comparison.tsx).

/**
 * Klein-Badge zeigt Herkunft eines Plans:
 *   - „Mandant" wenn vom Mandant erstellt (oder zuletzt bearbeitet)
 *   - „Kanzlei" wenn vom Staff erstellt/bearbeitet
 *   - „Mandant → Kanzlei" wenn Übergang erkennbar
 */
export function ActorBadge({
  createdByType,
  updatedByType,
}: {
  createdByType?: 'STAFF' | 'CLIENT_CONTACT';
  updatedByType?: 'STAFF' | 'CLIENT_CONTACT' | null;
}) {
  if (!createdByType) return null;
  const created = createdByType === 'STAFF' ? 'Kanzlei' : 'Mandant';
  const updated =
    updatedByType && updatedByType !== createdByType
      ? updatedByType === 'STAFF'
        ? 'Kanzlei'
        : 'Mandant'
      : null;
  const cls =
    createdByType === 'STAFF'
      ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
      : 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300';
  return (
    <span
      className={'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ' + cls}
      title={`Erstellt von ${created}${updated ? `, zuletzt von ${updated}` : ''}`}
    >
      {created}
      {updated && (
        <>
          <span className="mx-1 opacity-60">→</span>
          {updated}
        </>
      )}
    </span>
  );
}
