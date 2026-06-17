import { dirname, join, resolve, sep } from 'node:path';
import { mkdir } from 'node:fs/promises';

const DEFAULT_BACKUP_DIR = 'backups';

export function backupLocalDir(): string {
  return resolve(process.env['BACKUP_LOCAL_DIR'] ?? join(process.cwd(), DEFAULT_BACKUP_DIR));
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

  const target = resolve(root, ...parts);
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
