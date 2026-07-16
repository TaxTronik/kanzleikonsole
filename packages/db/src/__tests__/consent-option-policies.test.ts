import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../prisma/migrations/20260801004850_consent_option_policies/migration.sql',
  ),
  'utf8',
);

describe('consent option policy migration', () => {
  it('backfills only the current V1 catalog and leaves consent evidence untouched', () => {
    expect(sql).toContain(`ts."key" = 'privacy.consent_options'`);
    expect(sql).toContain(`ts."value" ->> 'version' = '1'`);
    expect(sql).toContain("'required', FALSE");
    expect(sql).toContain("'recommended', FALSE");
    expect(sql).not.toContain("'defaultSelected'");
    expect(sql).not.toContain('client_consent');
  });

  it('advances the optimistic-lock revision when a legacy catalog changes', () => {
    expect(sql).toContain('"updated_at" = CURRENT_TIMESTAMP');
  });
});
