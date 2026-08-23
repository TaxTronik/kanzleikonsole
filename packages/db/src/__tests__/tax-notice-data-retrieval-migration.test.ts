import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260823000000_tax_notice_data_retrieval_cutover/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('DATA_RETRIEVAL-Migrationsstrategie', () => {
  it('erhält Altfristen ohne den alten Deadline-Trigger auszulösen', () => {
    const disable = migration.indexOf('DISABLE TRIGGER tax_notice_appeal_deadline_trigger');
    const backfill = migration.indexOf('UPDATE public."tax_notice"');
    const enable = migration.indexOf('ENABLE TRIGGER tax_notice_appeal_deadline_trigger');

    expect(disable).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(disable);
    expect(enable).toBeGreaterThan(backfill);
  });

  it('behauptet für vorhandenes received_at keinen bestrittenen Benachrichtigungszugang', () => {
    expect(migration).toContain('"retrieval_notification_disputed_or_late" = false');
    expect(migration).toContain('"retrieved_at" = "received_at"');
    expect(migration).toContain('"retrieval_issued_at" = NULL');
    expect(migration).toContain('"retrieval_notification_legacy_fallback" = true');
  });

  it('bewahrt Altfristen bis zur belegten fachlichen Korrektur unverändert', () => {
    const legacyGuard = migration.indexOf('OLD.retrieval_notification_legacy_fallback');
    const preserve = migration.indexOf('NEW.appeal_deadline := OLD.appeal_deadline', legacyGuard);
    const returnEarly = migration.indexOf('RETURN NEW;', preserve);
    const recalculation = migration.indexOf('IF NEW.delivery_method NOT IN', returnEarly);

    expect(legacyGuard).toBeGreaterThan(-1);
    expect(preserve).toBeGreaterThan(legacyGuard);
    expect(returnEarly).toBeGreaterThan(preserve);
    expect(recalculation).toBeGreaterThan(returnEarly);
  });
});
