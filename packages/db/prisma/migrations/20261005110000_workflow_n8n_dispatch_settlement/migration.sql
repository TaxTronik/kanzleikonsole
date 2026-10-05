-- WORKFLOW-LIFECYCLE-001 (E-Mail-/n8n-Handoffs der Workflow-Schritte,
-- workflow_n8n_dispatch aus 20260823120000_workflow_consistency_backstops).
--
-- Review-Finding F-11. Der minütliche Reconciler holte die 100 ältesten
-- offenen Dispatch-Zeilen und setzte bei jedem nicht erfolgreichen Handoff nur
-- claimed_at zurück. SKIPPED (Event nicht abonniert, n8n aus oder nicht
-- konfiguriert) und UNROUTED (Route vorhanden, aber inaktiv) liefert der
-- Enqueue-Kern für denselben Dedupe-Schlüssel dauerhaft erneut; ab 100 solcher
-- Zeilen bearbeitete der Lauf nur noch diese, echte Schreibfehler wurden nie
-- mehr nachgezogen.
--
--  * settled_status/settled_at: endgültiger Handoff-Ausgang ohne Zustellung
--    (SKIPPED, UNROUTED, INVALID_EVENT). Solche Zeilen versucht der Worker
--    nicht mehr automatisch; outbox_id zeigt auf das gespeicherte Ereignis.
--    UNROUTED nimmt er nur wieder auf, wenn das Outbox-Ereignis UNROUTED
--    verlassen hat (Admin-Replay), damit ein n8n-Schritt danach wie bisher
--    abgeschlossen wird.
--  * next_attempt_at: frühester nächster Versuch nach einem technischen
--    Fehler (WRITE_FAILED), mit begrenztem exponentiellem Abstand.
--
-- Der bisherige Index (enqueued_at, claimed_at, created_at) diente nur diesem
-- Reconciler; er wird durch Teilindizes ersetzt, die abgeschlossene und
-- endgültig verworfene Zeilen nicht mehr enthalten. Bestandszeilen bleiben
-- unverändert offen und werden beim nächsten Lauf eingeordnet.
BEGIN;

ALTER TABLE "workflow_n8n_dispatch"
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ(6),
  ADD COLUMN "settled_status" TEXT,
  ADD COLUMN "settled_at" TIMESTAMPTZ(6),
  ADD CONSTRAINT "wf_n8n_dispatch_settled_status_check"
    CHECK ("settled_status" IN ('SKIPPED', 'UNROUTED', 'INVALID_EVENT')),
  ADD CONSTRAINT "wf_n8n_dispatch_settled_pair_check"
    CHECK (("settled_status" IS NULL) = ("settled_at" IS NULL));

DROP INDEX "wf_n8n_dispatch_pending_idx";

-- Fällige Zeilen des Reconcilers (offen, nicht endgültig verworfen).
CREATE INDEX "wf_n8n_dispatch_due_idx"
  ON "workflow_n8n_dispatch" ("created_at", "id")
  WHERE "enqueued_at" IS NULL AND "settled_at" IS NULL;

-- UNROUTED-Zeilen, deren Outbox-Ereignis ein Admin-Replay erhalten kann.
CREATE INDEX "wf_n8n_dispatch_unrouted_idx"
  ON "workflow_n8n_dispatch" ("created_at", "id")
  WHERE "enqueued_at" IS NULL AND "settled_status" = 'UNROUTED';

COMMIT;
