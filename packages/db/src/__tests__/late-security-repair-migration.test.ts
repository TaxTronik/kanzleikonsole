import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Fachkatalog: ACCESS-CLIENT-MODE-001,
// ACCESS-NOTIFICATION-RECIPIENT-001, ACCESS-TENANT-RLS-001,
// INV-ARCHIVE-EINVOICE-001, TAX-CONTROL-STATUS-001,
// TAX-DEADLINE-AUTOREQUEST-001, TAX-NOTICE-APPEAL-001.
const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260827100000_reconcile_late_security_guards/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('Forward-Reparatur der späten Sicherheitsmigrationen', () => {
  it('attestiert ausschließlich die beiden bekannten Ledger-Zustände', () => {
    expect(migration).toContain('20260823201000_tax_professional_control_model');
    expect(migration).toContain('b828cca902a2336b2419e4817fe9a90e661726b747e62b58327ff524e8a5b676');
    expect(migration).toContain('7c401ee74bc4de95f24cf84349634122cb03e6d76384f2387c39baa1e51e94aa');
    expect(migration).toContain('20260823202000_notification_client_scope');
    expect(migration).toContain('2c245e87e70139c3d49c4e798a15ba367e87ebceb7548918b33fad7a1dd78379');
    expect(migration).toContain('48a645cea2c55377835a3da0d925937e8edfba9faa748010e0a7ed87ac15e80d');
    expect(migration).toContain('IF active_rows <> 1');
    expect(migration).toContain('actual_checksum NOT IN');
  });

  it('entzieht direkte App-Aufrufe für interne Rechnungs- und Bescheidfunktionen', () => {
    expect(migration).toContain("class.oid = 'public.invoice'::regclass");
    expect(migration).toContain("class.oid = 'public.document'::regclass");
    expect(migration).toContain('IF invoice_owner IS DISTINCT FROM document_owner THEN');
    expect(migration).toContain(
      "'ALTER FUNCTION app.enforce_invoice_xrechnung_document_scope() OWNER TO %I'",
    );
    expect(migration).toContain(
      "'ALTER FUNCTION app.enforce_xrechnung_document_invoice_scope() OWNER TO %I'",
    );
    expect(migration).toMatch(
      /enforce_xrechnung_document_invoice_scope\(\) OWNER TO %I'[\s\S]*?invoice_owner/,
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION app.enforce_invoice_xrechnung_document_scope() FROM taxtronik_app',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION app.enforce_xrechnung_document_invoice_scope() FROM taxtronik_app',
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION app\.tax_notice_apply_calculated_reassessment\([\s\S]*?\) FROM taxtronik_app;/,
    );
  });

  it('stellt den Teilabhilfe-Nachweis und die interne Fristenhistorie fail-closed her', () => {
    const pairLock = migration.indexOf(
      'LOCK TABLE public."tax_notice" IN SHARE ROW EXCLUSIVE MODE',
    );
    const pairAttestation = migration.indexOf('DO $partial_relief_pair_attestation$');
    const pairConstraint = migration.indexOf(
      'ADD CONSTRAINT "tax_notice_partial_relief_evidence_check"',
    );

    expect(pairLock).toBeGreaterThanOrEqual(0);
    expect(pairAttestation).toBeGreaterThan(pairLock);
    expect(pairConstraint).toBeGreaterThan(pairAttestation);
    expect(migration).toContain('DO $partial_relief_pair_attestation$');
    expect(migration).toContain(
      '("partial_relief_received_at" IS NULL)\n           <> ("partial_relief_received_by" IS NULL)',
    );
    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS "tax_notice_partial_relief_evidence_check"',
    );
    expect(migration).toMatch(
      /ADD CONSTRAINT "tax_notice_partial_relief_evidence_check"[\s\S]*?\(\("partial_relief_received_at" IS NULL\) = \("partial_relief_received_by" IS NULL\)\)[\s\S]*?NOT VALID/,
    );
    expect(migration).toContain(
      'partial relief receipt evidence must be completed before status progress',
    );
    expect(migration).toContain('CREATE TRIGGER tax_notice_partial_relief_evidence_guard');
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public."tax_deadline_notification_history" FROM taxtronik_app',
    );
  });

  it('installiert Empfängerbindung und Ressourcenprüfung für Notifications neu', () => {
    expect(migration).toContain('ELSE\n      resource_is_known := FALSE;');
    expect(migration).toContain('NEW."staff_id" IS DISTINCT FROM OLD."staff_id"');
    expect(migration).toContain('AND ("staff_id" IS NULL OR "staff_id" = app.current_actor_id())');
    expect(migration).toContain('AND app.notification_resource_matches_client(');
    expect(migration).toContain('AND app.notification_staff_can_access_client(');
    expect(migration).toContain('ALTER TABLE public."notification" FORCE ROW LEVEL SECURITY');
  });

  it('konvergiert das Ledger erst nach den Objekt-Reparaturen', () => {
    const invoiceRepair = migration.indexOf(
      'REVOKE ALL ON FUNCTION app.enforce_invoice_xrechnung_document_scope()',
    );
    const taxRepair = migration.indexOf('CREATE TRIGGER tax_notice_partial_relief_evidence_guard');
    const deadlineRepair = migration.indexOf(
      'REVOKE ALL ON TABLE public."tax_deadline_notification_history" FROM taxtronik_app',
    );
    const notificationRepair = migration.indexOf('CREATE POLICY "notification_delete"');
    const converge = migration.indexOf('UPDATE public._prisma_migrations AS ledger');

    for (const repair of [invoiceRepair, taxRepair, deadlineRepair, notificationRepair]) {
      expect(repair).toBeGreaterThanOrEqual(0);
      expect(converge).toBeGreaterThan(repair);
    }
    expect(migration).toContain('ledger.checksum <> known.canonical_checksum');
  });
});
