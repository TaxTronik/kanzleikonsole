-- =============================================================================
-- Iter 46 — GwG-Invite trackt hochgeladene Documents (H-1)
--
-- Bisher: submitOnboardingAction akzeptiert beliebige document.id-UUIDs in
-- idFrontDocumentId/idBackDocumentId/extraDocumentIds. FK prüft Existenz,
-- nicht aber Owner — Cross-Tenant-Referenzen wären möglich.
--
-- Fix: bei jedem upload tragen wir die doc.id in eine JSONB-Liste pro
-- Invite ein. Beim submit prüfen wir, dass alle referenzierten Doc-IDs
-- in dieser Liste enthalten sind.
-- =============================================================================

ALTER TABLE "gwg_onboarding_invite"
  ADD COLUMN "uploaded_document_ids" JSONB NOT NULL DEFAULT '[]'::jsonb;
