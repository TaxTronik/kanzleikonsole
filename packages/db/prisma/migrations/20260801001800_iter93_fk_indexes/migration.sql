-- iter93 (Audit-Befund M-3): Indizes auf haeufig referenzierten Foreign-Key-
-- Spalten, die bisher unindiziert waren. Ohne Index auf der FK-Spalte muss
-- Postgres bei Joins/Lookups ueber die Relation (und bei ON DELETE-Kaskaden des
-- referenzierten Datensatzes) sequentiell scannen. Bei tenant-scoped Tabellen
-- fuehrt der Index tenant_id voran (deckt sich mit RLS + den bestehenden
-- @@index-Mustern des Schemas); reine tenant_id-Faelle bekommen einen
-- einfachen tenant_id-Index.
--
-- Indexnamen + Spalten entsprechen exakt den von Prisma generierten Defaults
-- (<table>_<col>_idx bzw. <table>_<col1>_<col2>_idx auf den @@map-Tabellennamen).
-- IF NOT EXISTS macht die Migration idempotent. KEIN CONCURRENTLY: die
-- Migration laeuft in einer Transaktion.

-- document.id-Referenzen (documentId)
CREATE INDEX IF NOT EXISTS "absence_tenant_id_document_id_idx" ON "absence" ("tenant_id", "document_id");
CREATE INDEX IF NOT EXISTS "gwg_id_document_document_id_idx" ON "gwg_id_document" ("document_id");
CREATE INDEX IF NOT EXISTS "invoice_tenant_id_document_id_idx" ON "invoice" ("tenant_id", "document_id");
CREATE INDEX IF NOT EXISTS "request_response_document_id_idx" ON "request_response" ("document_id");
CREATE INDEX IF NOT EXISTS "tax_filing_tenant_id_document_id_idx" ON "tax_filing" ("tenant_id", "document_id");
CREATE INDEX IF NOT EXISTS "tax_notice_tenant_id_document_id_idx" ON "tax_notice" ("tenant_id", "document_id");

-- sonstige FK-Spalten
CREATE INDEX IF NOT EXISTS "request_tenant_id_form_submission_id_idx" ON "request" ("tenant_id", "form_submission_id");
CREATE INDEX IF NOT EXISTS "risk_research_result_tenant_id_research_request_id_idx" ON "risk_research_result" ("tenant_id", "research_request_id");
CREATE INDEX IF NOT EXISTS "tax_deadline_tenant_id_config_id_idx" ON "tax_deadline" ("tenant_id", "config_id");
CREATE INDEX IF NOT EXISTS "workflow_instance_tenant_id_template_id_idx" ON "workflow_instance" ("tenant_id", "template_id");
CREATE INDEX IF NOT EXISTS "form_submission_tenant_id_template_id_idx" ON "form_submission" ("tenant_id", "template_id");
CREATE INDEX IF NOT EXISTS "phone_note_tenant_id_done_by_staff_idx" ON "phone_note" ("tenant_id", "done_by_staff");
CREATE INDEX IF NOT EXISTS "client_master_change_request_tenant_id_contact_id_idx" ON "client_master_change_request" ("tenant_id", "contact_id");
CREATE INDEX IF NOT EXISTS "client_master_change_request_tenant_id_decided_by_idx" ON "client_master_change_request" ("tenant_id", "decided_by");
CREATE INDEX IF NOT EXISTS "appointment_request_tenant_id_created_by_contact_idx" ON "appointment_request" ("tenant_id", "created_by_contact");
CREATE INDEX IF NOT EXISTS "client_handover_tenant_id_created_by_staff_idx" ON "client_handover" ("tenant_id", "created_by_staff");
CREATE INDEX IF NOT EXISTS "workflow_step_skill_id_idx" ON "workflow_step" ("skill_id");
CREATE INDEX IF NOT EXISTS "workflow_item_skill_id_idx" ON "workflow_item" ("skill_id");
CREATE INDEX IF NOT EXISTS "request_template_tenant_id_form_template_id_idx" ON "request_template" ("tenant_id", "form_template_id");

-- reine tenant_id-Indizes (bisher kein tenant_id-fuehrender Index)
CREATE INDEX IF NOT EXISTS "staff_bookmark_tenant_id_idx" ON "staff_bookmark" ("tenant_id");
CREATE INDEX IF NOT EXISTS "staff_note_tenant_id_idx" ON "staff_note" ("tenant_id");
CREATE INDEX IF NOT EXISTS "state_machine_transition_tenant_id_idx" ON "state_machine_transition" ("tenant_id");
