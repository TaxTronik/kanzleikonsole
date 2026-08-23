import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260823120000_workflow_consistency_backstops/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const internalCommentPolicy = readFileSync(
  new URL(
    '../../prisma/migrations/20260823130000_request_internal_comment_staff_only/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('Workflow-/Auto-Request-Konsistenzmigration', () => {
  it('bereinigt bestehende Workflow-Duplikate vor den Unique-Backstops ohne Fachdaten zu löschen', () => {
    const requestDetach = migration.indexOf('UPDATE "request" r\n   SET "workflow_item_id" = NULL');
    const requestUnique = migration.indexOf('CREATE UNIQUE INDEX "request_workflow_item_unique"');
    const formDetach = migration.indexOf(
      'UPDATE "form_submission" s\n   SET "workflow_item_id" = NULL',
    );
    const formUnique = migration.indexOf(
      'CREATE UNIQUE INDEX "form_submission_workflow_item_unique"',
    );

    expect(requestDetach).toBeGreaterThan(-1);
    expect(requestUnique).toBeGreaterThan(requestDetach);
    expect(formDetach).toBeGreaterThan(-1);
    expect(formUnique).toBeGreaterThan(formDetach);
    expect(migration).toContain('Doppelte Request-Artefakte entkoppelt');
    expect(migration).toContain('Doppelte Formular-Artefakte entkoppelt');
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"?(request|form_submission)"?/i);
  });

  it('backfillt Tax-Request-Pointer nur bei gleichem Tenant und Mandanten', () => {
    expect(migration).toContain('AND td."tenant_id" = r."tenant_id"');
    expect(migration).toContain('AND td."client_id" = r."client_id"');
    expect(migration).toContain('Ungültige Request-Referenz entkoppelt');
  });

  it('erzwingt bidirektionale Pointer- sowie Tenant-/Mandanten-Konsistenz deferred', () => {
    expect(migration).toContain('CREATE CONSTRAINT TRIGGER "tax_deadline_request_consistency"');
    expect(migration).toContain('CREATE CONSTRAINT TRIGGER "request_tax_deadline_consistency"');
    expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/g)).toHaveLength(2);
    expect(migration).toContain('r.tenant_id = NEW.tenant_id');
    expect(migration).toContain('r.client_id = NEW.client_id');
    expect(migration).toContain('td.tenant_id = NEW.tenant_id');
    expect(migration).toContain('td.client_id = NEW.client_id');
    expect(migration).toContain('WHERE r.tax_deadline_id = NEW.id');
    expect(migration).toContain('WHERE td.request_id = NEW.id');
  });

  it('liefert DB-Backstops für Mail-Empfänger, n8n-Dedupe und Orphan-Cleanup', () => {
    expect(migration).toContain('"wf_email_recipient_item_email_uq"');
    expect(migration).toContain('"n8n_outbox_dedupe_key_uq"');
    expect(migration).toContain('"wf_n8n_dispatch_item_uq"');
    expect(migration).toContain('"actor_staff_id" UUID NOT NULL');
    expect(migration).toContain('CREATE POLICY "wf_n8n_dispatch_tenant"');
    expect(
      migration.match(/wfi\."tenant_id" = "workflow_n8n_dispatch"\."tenant_id"/g),
    ).toHaveLength(2);
    expect(migration).toContain('"storage_orphan_object_uq"');
    expect(migration).toContain('"cleanup_claimed_at" TIMESTAMPTZ(6)');
    expect(migration).toContain('"storage_orphan_resolution"');
    expect(migration).toContain('"document_version_storage_identity_idx"');
  });

  it('trennt interne Kommentare per RLS vom CLIENT_CONTACT-Portal', () => {
    expect(
      internalCommentPolicy.match(/app\.current_actor_type\(\) IN \('STAFF', 'SYSTEM'\)/g),
    ).toHaveLength(2);
    expect(internalCommentPolicy).not.toContain('CLIENT_CONTACT');
  });

  it('trennt auch Mailzustand, n8n-Dispatch und Storage-Journal vom Portal', () => {
    for (const policy of [
      'wf_email_recipient_tenant',
      'wf_n8n_dispatch_tenant',
      'storage_orphan_tenant',
    ]) {
      const start = migration.indexOf(`CREATE POLICY "${policy}"`);
      expect(start).toBeGreaterThan(-1);
      const statement = migration.slice(start, migration.indexOf(';', start) + 1);
      expect(statement).toContain("app.current_actor_type() IN ('STAFF', 'SYSTEM')");
    }
  });
});
