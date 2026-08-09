import { dirname, resolve, sep } from 'node:path';
import { mkdir } from 'node:fs/promises';

const DEVELOPMENT_BACKUP_DIR = '../../backups';

/**
 * Produktion verlangt einen expliziten Operator-Pfad. In der Entwicklung ist
 * der statische Workspace-Pfad erlaubt, damit CLI (`./taxtronik backup`) und
 * Browser-Trigger denselben Ort verwenden. Eine Dateisystemsuche nach dem
 * Monorepo-Root gibt es bewusst nicht: sie ließ Next den Quellbaum tracen.
 */
export function backupLocalDir(): string {
  const configured = process.env['BACKUP_LOCAL_DIR']?.trim();
  if (configured) return resolve(configured);

  if (process.env.NODE_ENV === 'production') {
    throw new Error('BACKUP_LOCAL_DIR muss in Produktion explizit gesetzt sein.');
  }

  return resolve(process.cwd(), DEVELOPMENT_BACKUP_DIR);
}

export function backupLocalPathForKey(key: string): string {
  const root = backupLocalDir();
  const parts = key.replace(/\\/g, '/').split('/').filter(Boolean);

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
