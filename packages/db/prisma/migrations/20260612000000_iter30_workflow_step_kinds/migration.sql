-- =============================================================================
-- Iter. 30 — Workflow-Schritt-Typen + Verknüpfungen zu Requests/FormSubmissions
--
-- Bisher: WorkflowItem = reine Checkliste (Häkchen).
-- Jetzt: jeder Schritt hat einen `kind` — eine konkrete Aktion, die beim
--        "Anstoßen" ausgeführt wird (Anforderung erzeugen, Mail senden, etc.).
-- =============================================================================

CREATE TYPE "WorkflowStepKind" AS ENUM (
  'TASK',
  'DOCUMENT_UPLOAD',
  'CLIENT_REQUEST',
  'CLIENT_FORM',
  'CLIENT_EMAIL',
  'N8N_TRIGGER'
);

-- WorkflowStep: kind + config + n8n_event
ALTER TABLE "workflow_step"
  ADD COLUMN "kind" "WorkflowStepKind" NOT NULL DEFAULT 'TASK',
  ADD COLUMN "config" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "n8n_event" TEXT;

-- WorkflowItem: kind + config + n8n_event + started_at
ALTER TABLE "workflow_item"
  ADD COLUMN "kind" "WorkflowStepKind" NOT NULL DEFAULT 'TASK',
  ADD COLUMN "config" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "n8n_event" TEXT,
  ADD COLUMN "started_at" TIMESTAMPTZ;

-- Request: Rückreferenz auf WorkflowItem (für Auto-Resolution beim Closen).
ALTER TABLE "request"
  ADD COLUMN "workflow_item_id" UUID,
  ADD CONSTRAINT "request_workflow_item_fk"
    FOREIGN KEY ("workflow_item_id") REFERENCES "workflow_item"("id")
    ON DELETE SET NULL;
CREATE INDEX "request_workflow_item_idx" ON "request"("workflow_item_id");

-- FormSubmission: Rückreferenz auf WorkflowItem.
ALTER TABLE "form_submission"
  ADD COLUMN "workflow_item_id" UUID,
  ADD CONSTRAINT "form_submission_workflow_item_fk"
    FOREIGN KEY ("workflow_item_id") REFERENCES "workflow_item"("id")
    ON DELETE SET NULL;
CREATE INDEX "form_submission_workflow_item_idx" ON "form_submission"("workflow_item_id");

-- =============================================================================
-- Auto-Resolution-Trigger: wenn ein Request mit workflow_item_id geschlossen
-- wird, setze das zugehörige WorkflowItem auf done. Spiegelbild für
-- FormSubmission: wenn `submitted_at` gesetzt wird.
-- =============================================================================

CREATE OR REPLACE FUNCTION trg_request_closed_complete_workflow_item()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workflow_item_id IS NOT NULL
     AND NEW.closed_at IS NOT NULL
     AND (OLD.closed_at IS NULL OR OLD.workflow_item_id IS NULL) THEN
    UPDATE "workflow_item"
       SET done_at = COALESCE(done_at, NEW.closed_at),
           done_by_staff = COALESCE(done_by_staff, NEW.closed_by_staff)
     WHERE id = NEW.workflow_item_id
       AND done_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER request_workflow_item_auto_close
AFTER UPDATE OF closed_at, workflow_item_id ON "request"
FOR EACH ROW
EXECUTE FUNCTION trg_request_closed_complete_workflow_item();

CREATE OR REPLACE FUNCTION trg_submission_submitted_complete_workflow_item()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workflow_item_id IS NOT NULL
     AND NEW.submitted_at IS NOT NULL
     AND OLD.submitted_at IS NULL THEN
    UPDATE "workflow_item"
       SET done_at = COALESCE(done_at, NEW.submitted_at)
     WHERE id = NEW.workflow_item_id
       AND done_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER form_submission_workflow_item_auto_close
AFTER UPDATE OF submitted_at, workflow_item_id ON "form_submission"
FOR EACH ROW
EXECUTE FUNCTION trg_submission_submitted_complete_workflow_item();
