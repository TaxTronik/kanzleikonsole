import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { backupDownloadFilename, backupLocalDir, backupLocalPathForKey } from '../local-path';

const previousDir = process.env['BACKUP_LOCAL_DIR'];

afterEach(() => {
  if (previousDir === undefined) delete process.env['BACKUP_LOCAL_DIR'];
  else process.env['BACKUP_LOCAL_DIR'] = previousDir;
});

describe('backup local path helpers', () => {
  it('legt lokale Kopie flach (nur Dateiname) unter dem Backup-Root', () => {
    process.env['BACKUP_LOCAL_DIR'] = resolve('tmp-backups');

    expect(backupLocalDir()).toBe(resolve('tmp-backups'));
    expect(backupLocalPathForKey('pgdump/2026/06/17/taxtronik.dump')).toBe(
      resolve('tmp-backups', 'taxtronik.dump'),
    );
  });

  it('blockt Pfad-Traversal im Backup-Key', () => {
    process.env['BACKUP_LOCAL_DIR'] = resolve('tmp-backups');

    expect(() => backupLocalPathForKey('../secret.dump')).toThrow(/Ungueltiger Backup-Key/);
    expect(() => backupLocalPathForKey('pgdump/../../secret.dump')).toThrow(/Ungueltiger Backup-Key/);
  });

  it('liefert einen stabilen Download-Dateinamen aus dem Key', () => {
    expect(backupDownloadFilename('pgdump/2026/06/17/taxtronik.dump')).toBe('taxtronik.dump');
    expect(backupDownloadFilename('')).toBe('taxtronik-backup.dump');
  });
});
