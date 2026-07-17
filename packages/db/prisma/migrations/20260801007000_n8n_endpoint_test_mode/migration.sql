-- Debug-Schalter pro n8n-Route: echte Event-Zustellungen an die Test-URL
-- (/webhook-test) statt an die Produktions-URL leiten.
ALTER TABLE "n8n_webhook_endpoint"
  ADD COLUMN "test_mode" BOOLEAN NOT NULL DEFAULT false;
