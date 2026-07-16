// =============================================================================
// Geteilte Postgres-/Prisma-Hilfen für die Worker-Jobs (Backup/Restore/Rotate).
//
// pgConnArgs + prismaBytes waren zuvor mehrfach identisch in einzelnen Jobs
// dupliziert (backup-drill, backup-run, audit-rotate). Hier gebündelt, damit
// die sicherheitsrelevante Passwort-Behandlung (PGPASSWORD statt Args, P-2) an
// EINER Stelle liegt und nicht driftet.
// =============================================================================

export { pgConnArgs, prismaBytes } from '@taxtronik/db/pg-tools';
