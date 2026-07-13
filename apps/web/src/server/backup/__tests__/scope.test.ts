import { describe, expect, it } from 'vitest';
import { matchesSingleTenantBackupScope } from '../scope';

describe('matchesSingleTenantBackupScope', () => {
  it('erlaubt einen Browser-Backup-Lauf nur für die einzige Kanzlei der Installation', () => {
    expect(matchesSingleTenantBackupScope(['tenant-a'], 'tenant-a')).toBe(true);
    expect(matchesSingleTenantBackupScope(['tenant-a'], 'tenant-b')).toBe(false);
    expect(matchesSingleTenantBackupScope(['tenant-a', 'tenant-b'], 'tenant-a')).toBe(false);
    expect(matchesSingleTenantBackupScope([], 'tenant-a')).toBe(false);
  });
});
