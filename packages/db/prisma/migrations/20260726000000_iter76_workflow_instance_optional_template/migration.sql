-- iter76: WorkflowInstance.template_id nullable — ermöglicht den „eigenen Workflow
-- (einmalig)" ohne Vorlage (freier Name, Schritte ad-hoc via AddStepForm). Der
-- bestehende FK + ON-UPDATE bleiben unverändert; nur die NOT-NULL-Pflicht entfällt.

ALTER TABLE "workflow_instance" ALTER COLUMN "template_id" DROP NOT NULL;
