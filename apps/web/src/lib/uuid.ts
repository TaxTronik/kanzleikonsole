// =============================================================================
// UUID-Guard für Route-Parameter.
//
// Prisma-Spalten mit `@db.Uuid` lehnen Nicht-UUID-Text mit einem Postgres-Fehler
// (22P02 → P2023) ab. Wird ein roher `params.id` ungeprüft in eine Query
// gereicht, endet ein Tippfehler/Fuzzing in einem generischen 500 (Log-Rauschen,
// Alarm-Fatigue, 5xx-Retry-Sturm) statt in einem sauberen 404. Dieser Guard
// filtert die offensichtlich ungültige Eingabe VOR dem DB-Roundtrip heraus.
// =============================================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True, wenn `s` ein kanonisches UUID-Format hat (Version-agnostisch). */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
