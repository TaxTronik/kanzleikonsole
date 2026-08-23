import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(__dirname, '../../prisma/migrations/20260823160000_form_upload_relation/migration.sql'),
  'utf8',
);

describe('Formular-Upload-Provenienz', () => {
  it('bindet Submission und Feld per Constraint, FK und Index', () => {
    expect(migration).toContain('"document_form_upload_pair_check"');
    expect(migration).toContain('"document_form_submission_fkey"');
    expect(migration).toContain('"document_form_submission_idx"');
    expect(migration).toContain('"document_open_form_field_upload_unique"');
    expect(migration).toContain('WHERE "form_submission_id" IS NOT NULL');
    expect(migration).toContain('AND "deleted_at" IS NULL');
  });

  it('vertraut beim Legacy-Backfill nicht allein den vom Mandanten steuerbaren answers', () => {
    expect(migration).toContain('JOIN "audit_log" audit');
    expect(migration).toContain('audit."action" = \'form.submission.upload\'');
    expect(migration).toContain('audit."after" ->> \'submissionId\'');
    expect(migration).toContain('audit."after" ->> \'fieldKey\'');
    expect(migration).toContain("THEN (entry.value ->> 'documentId')::UUID");
    expect(migration).toContain('ELSE NULL');
  });

  it('oeffnet das geschuetzte Storage-Journal nur ueber einen eng gebundenen Portal-Pfad', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION app.journal_open_form_upload_discard');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain("app.current_actor_type() IS DISTINCT FROM 'CLIENT_CONTACT'");
    expect(migration).toContain('cc."id" = v_actor_id');
    expect(migration).toContain('d."form_submission_id" = fs."id"');
    expect(migration).toContain('d."form_field_key" = ff."key"');
    expect(migration).toContain("fs.\"status\" IN ('PENDING', 'DRAFT')");
    expect(migration).toContain('ORDER BY r."id"\n   FOR UPDATE;');
    expect(migration).toContain("r.\"status\" IN ('OPEN', 'IN_PROGRESS')");
    expect(migration).toContain('WHERE orphan."tenant_id" = v_tenant_id');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION app.journal_open_form_upload_discard(UUID, TEXT, UUID) FROM PUBLIC;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION app.journal_open_form_upload_discard(UUID, TEXT, UUID) TO taxtronik_app;',
    );
  });
});
