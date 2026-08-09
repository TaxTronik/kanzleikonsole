-- Semantic reproduction of the protection-schema deltas observed on the
-- affected pre-release database. The exact historical ledger hashes below are
-- the attestation; these deliberately weak definitions ensure the forward
-- repair restores behavior, not merely checksum text.

CREATE OR REPLACE FUNCTION app.block_version_during_gwg_destruction()
RETURNS TRIGGER LANGUAGE plpgsql AS $fixture$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$fixture$;

CREATE OR REPLACE FUNCTION app.guard_gwg_document_invite_and_claim()
RETURNS TRIGGER LANGUAGE plpgsql AS $fixture$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$fixture$;

CREATE OR REPLACE FUNCTION app.guard_gwg_id_document_scope_and_claim()
RETURNS TRIGGER LANGUAGE plpgsql AS $fixture$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$fixture$;

CREATE OR REPLACE FUNCTION app.guard_gwg_id_document_subject_and_set()
RETURNS TRIGGER LANGUAGE plpgsql AS $fixture$
BEGIN
  RETURN NEW;
END;
$fixture$;

CREATE OR REPLACE FUNCTION app.gwg_check_has_confirmed_identity(p_check_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $fixture$
  SELECT TRUE;
$fixture$;

CREATE OR REPLACE FUNCTION app.poa_protect_integrity()
RETURNS TRIGGER LANGUAGE plpgsql AS $fixture$
BEGIN
  RETURN NEW;
END;
$fixture$;

CREATE OR REPLACE FUNCTION app.tax_notice_set_appeal_deadline()
RETURNS TRIGGER LANGUAGE plpgsql AS $fixture$
BEGIN
  RETURN NEW;
END;
$fixture$;

DROP TRIGGER IF EXISTS dsgvo_request_terminal_evidence_immutable
  ON public.dsgvo_request;
DROP FUNCTION IF EXISTS app.protect_dsgvo_terminal_evidence();

DROP TRIGGER IF EXISTS tax_notice_progress_evidence_trigger
  ON public.tax_notice;
DROP FUNCTION IF EXISTS app.tax_notice_require_progress_evidence();

DROP TRIGGER IF EXISTS gwg_beneficial_owner_identity_assignment_invalidate
  ON public.gwg_beneficial_owner;

ALTER TABLE public.dsgvo_request
  DROP CONSTRAINT IF EXISTS dsgvo_request_result_evidence_pairs_check;

ALTER TABLE public.gwg_id_document
  DROP CONSTRAINT IF EXISTS gwg_id_document_beneficial_owner_subject_id_fkey,
  DROP CONSTRAINT IF EXISTS gwg_id_document_natural_client_subject_id_fkey,
  DROP CONSTRAINT IF EXISTS gwg_id_document_representative_subject_id_fkey;

ALTER TABLE public.gwg_id_document
  ADD CONSTRAINT gwg_id_document_beneficial_owner_subject_id_fkey
    FOREIGN KEY (beneficial_owner_subject_id)
    REFERENCES public.gwg_beneficial_owner(id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT gwg_id_document_natural_client_subject_id_fkey
    FOREIGN KEY (natural_client_subject_id)
    REFERENCES public.client(id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT gwg_id_document_representative_subject_id_fkey
    FOREIGN KEY (representative_subject_id)
    REFERENCES public.gwg_representative(id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.tax_notice
  DROP CONSTRAINT IF EXISTS tax_notice_appeal_filing_evidence_check,
  DROP CONSTRAINT IF EXISTS tax_notice_court_filing_evidence_check,
  DROP CONSTRAINT IF EXISTS tax_notice_event_sequence_check,
  DROP CONSTRAINT IF EXISTS tax_notice_legal_final_evidence_check;

WITH legacy(migration_name, checksum) AS (
  VALUES
    ('20260801003400_gwg_fail_closed_and_destruction', '20e0ac5a2c1d6d47c7c606cd3915b6297418c25ece1695e345152ebc20296152'),
    ('20260801003500_tax_notice_event_dates', 'aca1080fb6a838263c178ffc9ee6966168df08338a82d5c8c2f2cf5133404d05'),
    ('20260801003510_dsgvo_request_evidence', '85f37286af75f978f46e80f026768f1bfa36243f8717f6152ac3118574501966'),
    ('20260801003600_poa_signing_snapshot', '6a180f40b3d7e57f3bee1623b1e05d8759ae773a90b2ae3e882e1b847c43bab6'),
    ('20260801003700_n8n_workflow_routes', 'a7ab046abe92205f430202af01e0a0f955ad074eeb696a08842864102bf83387'),
    ('20260801003800_n8n_callback_receipts', '9ea34ff62642812abd7141b85b3f48df5973b25db0f1e69d390b85f50a2a611a'),
    ('20260801003900_n8n_delivery_ops_index', 'f7af0aef8e6d3a15344651c13869e7eebf8ea7a40e36b12e27257a29fdbf79d1'),
    ('20260801004000_poa_created_at_db_clock', '5b7441b7eb0d3148a6e4418fbdc61df8a7730cf856fa5f2cf27e3276228a89d1'),
    ('20260801004200_gwg_destruction_lifecycle_lock', '90efb4b93035dbb4b685b8b2f36395badaabe3cb0e36389031a21155e90479ed'),
    ('20260801004300_gwg_identity_subjects_and_document_sets', 'a7c91cb2cefdff27708b8f725a2c5bcee24578fdce8899f09b25bf8c124154d1'),
    ('20260801004400_legacy_gwg_guard_recovery', 'b84f3eff33972398cfde95521cc44671639fc0f34bbfb0f872afbc2e19951b6f')
)
UPDATE public._prisma_migrations AS ledger
   SET checksum = legacy.checksum
  FROM legacy
 WHERE ledger.migration_name = legacy.migration_name
   AND ledger.finished_at IS NOT NULL
   AND ledger.rolled_back_at IS NULL;
