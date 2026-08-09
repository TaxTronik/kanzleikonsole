import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { backupDownloadFilename, backupLocalDir, backupLocalPathForKey } from '../local-path';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
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
    expect(() => backupLocalPathForKey('pgdump/../../secret.dump')).toThrow(
      /Ungueltiger Backup-Key/,
    );
  });

  it('liefert einen stabilen Download-Dateinamen aus dem Key', () => {
    expect(backupDownloadFilename('pgdump/2026/06/17/taxtronik.dump')).toBe('taxtronik.dump');
    expect(backupDownloadFilename('')).toBe('taxtronik-backup.dump');
  });

  it('verwendet in der Entwicklung den statischen Workspace-Pfad', () => {
    delete process.env['BACKUP_LOCAL_DIR'];
    process.env = { ...process.env, NODE_ENV: 'development' };

    expect(backupLocalDir()).toBe(resolve(process.cwd(), '../../backups'));
  });

  it('verlangt in Produktion einen expliziten Operator-Pfad', () => {
    delete process.env['BACKUP_LOCAL_DIR'];
    process.env = { ...process.env, NODE_ENV: 'production' };

    expect(() => backupLocalDir()).toThrow(/BACKUP_LOCAL_DIR/);
  });
});
