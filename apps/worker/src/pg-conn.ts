// =============================================================================
// Geteilte Postgres-/Prisma-Hilfen für die Worker-Jobs (Backup/Restore/Rotate).
//
// pgConnArgs + prismaBytes waren zuvor mehrfach identisch in einzelnen Jobs
// dupliziert (backup-drill, backup-run, audit-rotate). Hier gebündelt, damit
// die sicherheitsrelevante Passwort-Behandlung (PGPASSWORD statt Args, P-2) an
// EINER Stelle liegt und nicht driftet.
// =============================================================================

/**
 * P-2: Verbindungs-URL in Args + PGPASSWORD-ENV zerlegen. spawn-Argumente sind
 * via /proc/<pid>/cmdline für andere User sichtbar — eine vollständige
 * `postgresql://user:pw@host/db`-URL als Arg würde das Passwort leaken.
 * PGPASSWORD wird nur an den Child-Prozess durchgereicht.
 */
export function pgConnArgs(dbUrl: string): { args: string[]; env: Record<string, string> } {
  const u = new URL(dbUrl);
  const args = [
    '-h', u.hostname,
    '-p', u.port || '5432',
    '-U', decodeURIComponent(u.username),
    '-d', u.pathname.slice(1) || decodeURIComponent(u.username),
  ];
  const e: Record<string, string> = { PGPASSWORD: decodeURIComponent(u.password) };
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode) e['PGSSLMODE'] = sslmode;
  return { args, env: e };
}

/** Buffer → Uint8Array für Prisma-Bytes-Spalten. */
export function prismaBytes(value: Buffer | Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}
