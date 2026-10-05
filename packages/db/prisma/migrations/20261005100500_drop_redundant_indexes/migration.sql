-- AUDIT-HASH-CHAIN-001 / TAX-CONTROL-STATUS-001 (audit_seal, deadline_daily_review);
-- die übrigen Indizes haben keinen Regelbezug.
--
-- Verhaltensneutral; Review-Finding D-06. Diese B-Tree-Indizes sind vollständig
-- von einem anderen Index derselben Tabelle gedeckt: dessen führende Spalten
-- sind genau ihre Spalten, mit gleicher Operatorklasse und Collation, ohne
-- Prädikat oder Ausdruck; der gedeckte Index ist nicht eindeutig und trägt
-- keinen Constraint. Sie kosten bei jedem INSERT/UPDATE Schreib-I/O, am
-- meisten bei document_version (eine Zeile je Upload). Alle Unique-Constraints
-- bleiben.
--
-- Gedeckt durch (Spalten des gedeckten Index stehen vorn):
--   audit_seal_tenant_id_seal_date_idx      audit_seal_tenant_id_seal_date_key (identisch)
--   bwa_position_period_id_idx              bwa_position_period_id_number_key
--   client_tenant_id_idx                    client_tenant_id_id_key
--   client_contact_tenant_id_client_id_idx  client_contact_tenant_id_client_id_email_key
--   client_tax_registration_tenant_id_client_id_idx
--                                           client_tax_registration_tenant_id_client_id_id_key
--   deadline_daily_review_tenant_date_idx   deadline_daily_review_tenant_date_key; nur
--                                           review_date absteigend, gelesen wird je Tenant
--                                           per Gleichheit (findUnique), ein Index ist in
--                                           beide Richtungen lesbar
--   document_version_document_id_idx        document_version_document_id_version_no_key
--   form_field_template_id_idx              form_field_template_id_position_key
--   form_template_tenant_id_idx             form_template_tenant_id_name_key
--   gwg_id_document_gwg_check_id_idx        gwg_id_document_gwg_check_id_document_id_key
--   staff_skill_tenant_id_idx               staff_skill_tenant_id_slug_key
--   staff_skill_assignment_staff_id_idx     staff_skill_assignment_staff_id_skill_id_key
--   staff_user_tenant_id_idx                staff_user_tenant_id_id_key
--   tax_filing_tenant_client_idx            tax_filing_tenant_client_kind_period_key
--   tax_notice_tenant_id_client_id_idx      tax_notice_tenant_id_client_id_kind_period_idx
--   tax_schedule_config_tenant_id_client_id_idx
--                                           tax_schedule_config_tenant_id_client_id_kind_key
--   workflow_step_template_id_idx           workflow_step_template_id_position_key
--   workflow_template_tenant_id_idx         workflow_template_tenant_id_name_key
--
-- Bewusst NICHT entfernt, obwohl ebenso gedeckt (gwg_representative_gwg_check_id_position_key):
-- gwg_representative_gwg_check_id_idx. Die versionierte GwG-Invariante
-- packages/db/invariants/gwg/043-identity-subjects-and-document-sets.sql
-- verlangt ihn; ohne ihn startet ein Kunden-Deploy die schreibenden Dienste nicht.
--
-- DROP INDEX sperrt die Tabelle nur kurz (keine Datenbewegung).
BEGIN;

DROP INDEX "audit_seal_tenant_id_seal_date_idx";
DROP INDEX "bwa_position_period_id_idx";
DROP INDEX "client_tenant_id_idx";
DROP INDEX "client_contact_tenant_id_client_id_idx";
DROP INDEX "client_tax_registration_tenant_id_client_id_idx";
DROP INDEX "deadline_daily_review_tenant_date_idx";
DROP INDEX "document_version_document_id_idx";
DROP INDEX "form_field_template_id_idx";
DROP INDEX "form_template_tenant_id_idx";
DROP INDEX "gwg_id_document_gwg_check_id_idx";
DROP INDEX "staff_skill_tenant_id_idx";
DROP INDEX "staff_skill_assignment_staff_id_idx";
DROP INDEX "staff_user_tenant_id_idx";
DROP INDEX "tax_filing_tenant_client_idx";
DROP INDEX "tax_notice_tenant_id_client_id_idx";
DROP INDEX "tax_schedule_config_tenant_id_client_id_idx";
DROP INDEX "workflow_step_template_id_idx";
DROP INDEX "workflow_template_tenant_id_idx";

COMMIT;
