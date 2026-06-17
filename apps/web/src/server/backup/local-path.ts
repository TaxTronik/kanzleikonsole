import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { mkdir } from 'node:fs/promises';

const DEFAULT_BACKUP_DIR = 'backups';
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/**
 * Löst das lokale Backup-Verzeichnis auf. Ohne ENV-Override
 * (`BACKUP_LOCAL_DIR`) wird das Backup-Dir am Monorepo-Root abgelegt — nicht
 * in apps/web/backups —, damit CLI- (`./taxtronik backup`) und Browser-Trigger
 * (Admin-Button) denselben Ort nutzen. In Docker ist BACKUP_LOCAL_DIR gesetzt
 * (/app/backups) und dieser Lookup entfällt.
 */
function resolveBackupRoot(): string {
  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) {
      return join(dir, DEFAULT_BACKUP_DIR);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), DEFAULT_BACKUP_DIR);
}

export function backupLocalDir(): string {
  return resolve(process.env['BACKUP_LOCAL_DIR'] ?? resolveBackupRoot());
}

export function backupLocalPathForKey(key: string): string {
  const root = backupLocalDir();
  const parts = key
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);

  if (parts.length === 0 || parts.some((part) => part === '..' || part.includes('\0'))) {
    throw new Error('Ungueltiger Backup-Key.');
  }

  // Lokale Kopie flach unter dem Backup-Root: nur der Dateiname (Leaf), ohne
  // pgdump/YYYY/MM/DD/-Verschachtelung. Der S3-Key bleibt davon unberührt
  // strukturiert (S3-Lifecycle-Policies brauchen die Datumsprefixe).
  const leaf = parts[parts.length - 1]!;
  const target = resolve(root, leaf);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('Ungueltiger Backup-Pfad.');
  }
  return target;
}

export async function ensureBackupLocalPathForKey(key: string): Promise<string> {
  const target = backupLocalPathForKey(key);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  return target;
}

export function backupDownloadFilename(key: string): string {
  const leaf = key.replace(/\\/g, '/').split('/').filter(Boolean).pop();
  return leaf || 'taxtronik-backup.dump';
}
