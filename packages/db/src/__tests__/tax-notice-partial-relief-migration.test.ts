import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260823201000_tax_professional_control_model/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('Teilabhilfe-Ereignisnachweis', () => {
  // Fachkatalog: TAX-NOTICE-APPEAL-001, TAX-CONTROL-STATUS-001
  it('modelliert Bekanntgabetag und dokumentierende Person als eigenes Paar', () => {
    expect(schema).toContain('@map("partial_relief_received_at") @db.Date');
    expect(schema).toContain('@map("partial_relief_received_by") @db.Uuid');

    const constraintStart = migration.indexOf(
      'ADD CONSTRAINT "tax_notice_partial_relief_evidence_check"',
    );
    const constraintEnd = migration.indexOf(
      'ADD CONSTRAINT "tax_notice_court_filing_evidence_check"',
      constraintStart,
    );
    const constraint = migration.slice(constraintStart, constraintEnd);

    expect(constraintStart).toBeGreaterThan(-1);
    expect(constraint).toContain(
      '(("partial_relief_received_at" IS NULL) = ("partial_relief_received_by" IS NULL))',
    );
    // Historische TEILABHILFE-Zeilen ohne erfundene Tatsachen dürfen bei
    // fachfremden Updates nicht am NOT-VALID-Constraint hängen bleiben.
    expect(constraint).not.toContain('"status" <> \'TEILABHILFE\'::public."tax_notice_status"');
    expect(constraint).toMatch(/\) NOT VALID,\s*$/);
    expect(migration).toContain('CREATE TRIGGER tax_notice_partial_relief_evidence_guard');
    expect(migration).toContain(
      "RAISE EXCEPTION 'partial relief requires receipt date and documenting staff'",
    );
  });

  it('erhält echte historische Teilabhilfen ohne erfundene Ereignisdaten', () => {
    const legacyStart = migration.indexOf('-- Die alte UI verwendete TEILABHILFE');
    const legacyEnd = migration.indexOf(
      'ENABLE TRIGGER tax_notice_progress_evidence_trigger',
      legacyStart,
    );
    const legacyMigration = migration.slice(legacyStart, legacyEnd);

    expect(legacyStart).toBeGreaterThan(-1);
    expect(legacyMigration).toContain(
      '"status" = \'TEILEINSPRUCHSENTSCHEIDUNG\'::public."tax_notice_status"',
    );
    expect(legacyMigration).not.toContain('"status" = \'EINSPRUCH\'');
    expect(legacyMigration).not.toContain('"partial_relief_received_at" =');
    expect(legacyMigration).not.toContain('"partial_relief_received_by" =');
  });

  it('verlangt den Nachweis beim Fortschritt und prüft die Ereignisreihenfolge', () => {
    expect(migration).toContain('"partial_relief_received_at" >= "appeal_filed_at"::date');
    expect(migration).toContain('"appeal_decision_received_at" >= "partial_relief_received_at"');
    expect(migration).toContain('"appeal_resolved_at"::date >= "partial_relief_received_at"');
    expect(migration).toContain(
      'NEW.partial_relief_received_at IS NULL\n       OR NEW.partial_relief_received_by IS NULL',
    );
    expect(migration).toContain(
      "RAISE EXCEPTION 'partial relief receipt evidence must be completed before status progress'",
    );
    expect(migration).toContain(
      "RAISE EXCEPTION 'partial relief receipt evidence is immutable once recorded'",
    );
  });
});
