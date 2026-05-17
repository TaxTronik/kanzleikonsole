-- =============================================================================
-- Iter 42 — FORCE ROW LEVEL SECURITY auf allen mandantenbezogenen Tabellen
--
-- Hintergrund (Security-Review S14):
-- Bisher haben Migrationen nur ENABLE ROW LEVEL SECURITY gesetzt. RLS gilt
-- dann für Roles, die NICHT Owner der Tabelle sind — solange die App-Role
-- (`taxtronik_app`) kein Tabellen-Owner ist, ist das ausreichend.
--
-- ABER: ohne FORCE schützt nichts davor, dass eine spätere Migration oder
-- ein Restore versehentlich Eigentumsverhältnisse ändert und damit die
-- RLS-Policies stillschweigend aushebelt. FORCE macht das fail-closed,
-- auch für den Tabellen-Owner gelten die Policies.
--
-- Owner-Verbindung (Superuser `taxtronik`) hat BYPASSRLS und ist davon
-- unberührt — Migrationen, Worker-Jobs und Verification-CLI laufen weiter.
-- =============================================================================

ALTER TABLE "appointment" FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointment_request" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_archive" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_seal" FORCE ROW LEVEL SECURITY;
ALTER TABLE "backup_record" FORCE ROW LEVEL SECURITY;
ALTER TABLE "bwa_period" FORCE ROW LEVEL SECURITY;
ALTER TABLE "bwa_plan" FORCE ROW LEVEL SECURITY;
ALTER TABLE "bwa_position" FORCE ROW LEVEL SECURITY;
ALTER TABLE "client" FORCE ROW LEVEL SECURITY;
ALTER TABLE "client_contact" FORCE ROW LEVEL SECURITY;
ALTER TABLE "client_custom_field_def" FORCE ROW LEVEL SECURITY;
ALTER TABLE "client_custom_field_value" FORCE ROW LEVEL SECURITY;
ALTER TABLE "client_handover" FORCE ROW LEVEL SECURITY;
ALTER TABLE "client_master_change_request" FORCE ROW LEVEL SECURITY;
ALTER TABLE "client_reminder" FORCE ROW LEVEL SECURITY;
ALTER TABLE "client_responsibility" FORCE ROW LEVEL SECURITY;
ALTER TABLE "document" FORCE ROW LEVEL SECURITY;
ALTER TABLE "document_version" FORCE ROW LEVEL SECURITY;
ALTER TABLE "dsgvo_request" FORCE ROW LEVEL SECURITY;
ALTER TABLE "email_template" FORCE ROW LEVEL SECURITY;
ALTER TABLE "form_field" FORCE ROW LEVEL SECURITY;
ALTER TABLE "form_submission" FORCE ROW LEVEL SECURITY;
ALTER TABLE "form_template" FORCE ROW LEVEL SECURITY;
ALTER TABLE "gwg_beneficial_owner" FORCE ROW LEVEL SECURITY;
ALTER TABLE "gwg_check" FORCE ROW LEVEL SECURITY;
ALTER TABLE "gwg_id_document" FORCE ROW LEVEL SECURITY;
ALTER TABLE "gwg_onboarding_invite" FORCE ROW LEVEL SECURITY;
ALTER TABLE "invoice" FORCE ROW LEVEL SECURITY;
ALTER TABLE "invoice_category" FORCE ROW LEVEL SECURITY;
ALTER TABLE "invoice_position" FORCE ROW LEVEL SECURITY;
ALTER TABLE "kb_article" FORCE ROW LEVEL SECURITY;
ALTER TABLE "kb_category" FORCE ROW LEVEL SECURITY;
ALTER TABLE "magic_link" FORCE ROW LEVEL SECURITY;
ALTER TABLE "notification" FORCE ROW LEVEL SECURITY;
ALTER TABLE "pending_binder" FORCE ROW LEVEL SECURITY;
ALTER TABLE "phone_note" FORCE ROW LEVEL SECURITY;
ALTER TABLE "power_of_attorney" FORCE ROW LEVEL SECURITY;
ALTER TABLE "request" FORCE ROW LEVEL SECURITY;
ALTER TABLE "request_response" FORCE ROW LEVEL SECURITY;
ALTER TABLE "request_template" FORCE ROW LEVEL SECURITY;
ALTER TABLE "rss_feed" FORCE ROW LEVEL SECURITY;
ALTER TABLE "service_provider" FORCE ROW LEVEL SECURITY;
ALTER TABLE "sick_leave" FORCE ROW LEVEL SECURITY;
ALTER TABLE "staff_bookmark" FORCE ROW LEVEL SECURITY;
ALTER TABLE "staff_note" FORCE ROW LEVEL SECURITY;
ALTER TABLE "staff_role" FORCE ROW LEVEL SECURITY;
ALTER TABLE "staff_skill" FORCE ROW LEVEL SECURITY;
ALTER TABLE "staff_skill_assignment" FORCE ROW LEVEL SECURITY;
ALTER TABLE "staff_user" FORCE ROW LEVEL SECURITY;
ALTER TABLE "state_machine" FORCE ROW LEVEL SECURITY;
ALTER TABLE "state_machine_state" FORCE ROW LEVEL SECURITY;
ALTER TABLE "state_machine_transition" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tax_deadline" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tax_filing" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tax_notice" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tax_schedule_config" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_setting" FORCE ROW LEVEL SECURITY;
ALTER TABLE "time_entry" FORCE ROW LEVEL SECURITY;
ALTER TABLE "vacation_request" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workflow_instance" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workflow_instance_member" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workflow_item" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workflow_item_comment" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workflow_step" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workflow_template" FORCE ROW LEVEL SECURITY;
