// =============================================================================
// Status eines DSGVO-Paketauftrags (Welle 15, Folgepunkt P-11)
//
// Fachkatalog: DSGVO-CONTACT-EXPORT-001
//
// Je Antrag ist höchstens ein Auftrag REQUESTED/RUNNING aktiv. Geht der Job
// verloren (Redis geleert, Worker hart beendet und BullMQ gibt ihn nach dem
// Stall-Limit auf), bliebe der Antrag sonst dauerhaft blockiert. Ein Auftrag,
// der so lange offen ist, gilt deshalb als hängengeblieben: Die Oberfläche
// erlaubt eine neue Anforderung, die ihn zuvor als FAILED abschließt. Ein doch
// noch laufender Worker kann ihn danach nicht mehr abschließen (Guard
// app.guard_dsgvo_export friert FAILED ein) und verwirft sein Paket.
// =============================================================================

/** Paketaufbau ≤ 120 s, Ablage ≤ 25 MiB: 15 Minuten sind großzügig. */
export const DSGVO_EXPORT_STALE_AFTER_MS = 15 * 60_000;

export const DSGVO_EXPORT_STALE_ERROR =
  'Der Auftrag wurde nicht innerhalb von 15 Minuten abgeschlossen und durch eine neue Anforderung ersetzt.';

export function isDsgvoExportStale(
  row: { status: string; requestedAt: Date; startedAt: Date | null },
  now: Date,
): boolean {
  if (row.status === 'REQUESTED') {
    return now.getTime() - row.requestedAt.getTime() > DSGVO_EXPORT_STALE_AFTER_MS;
  }
  if (row.status === 'RUNNING') {
    const since = row.startedAt ?? row.requestedAt;
    return now.getTime() - since.getTime() > DSGVO_EXPORT_STALE_AFTER_MS;
  }
  return false;
}
