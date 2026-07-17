-- Ein Rechercheergebnis darf nur einmal als Dokument im Aktenregal abgelegt
-- werden. Der Zeitstempel bleibt auch bestehen, falls das Dokument später
-- physisch entfernt wird; die eindeutige Dokumentverknüpfung dient der Anzeige.
ALTER TABLE "risk_research_result"
  ADD COLUMN "shelf_document_id" UUID,
  ADD COLUMN "saved_to_shelf_at" TIMESTAMPTZ(6);

-- Bereits vor dieser Migration abgelegte Ergebnisse aus der unveränderlichen
-- Evidenzkette übernehmen. Falls mehrfach geklickt wurde, ist bewusst nur die
-- erste Ablage maßgeblich.
WITH shelf_events AS (
  SELECT
    audit."tenant_id",
    CASE
      WHEN audit."after" ->> 'resultId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN (audit."after" ->> 'resultId')::UUID
    END AS result_id,
    CASE
      WHEN audit."resource_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN audit."resource_id"::UUID
    END AS document_id,
    audit."occurred_at",
    audit."id"
  FROM "audit_log" audit
  WHERE audit."action" = 'risk.research.saved_to_shelf'
), first_shelf_event AS (
  SELECT DISTINCT ON (shelf_event."tenant_id", shelf_event.result_id)
    shelf_event."tenant_id",
    shelf_event.result_id,
    shelf_event.document_id,
    shelf_event."occurred_at"
  FROM shelf_events shelf_event
  JOIN "risk_research_result" research_result
    ON research_result."id" = shelf_event.result_id
   AND research_result."tenant_id" = shelf_event."tenant_id"
  JOIN "document" shelf_document
    ON shelf_document."id" = shelf_event.document_id
   AND shelf_document."tenant_id" = shelf_event."tenant_id"
  WHERE shelf_event.result_id IS NOT NULL
    AND shelf_event.document_id IS NOT NULL
  ORDER BY
    shelf_event."tenant_id",
    shelf_event.result_id,
    shelf_event."occurred_at",
    shelf_event."id"
)
UPDATE "risk_research_result" research_result
SET
  "shelf_document_id" = first_event.document_id,
  "saved_to_shelf_at" = first_event."occurred_at"
FROM first_shelf_event first_event
WHERE research_result."id" = first_event.result_id
  AND research_result."tenant_id" = first_event."tenant_id";

CREATE UNIQUE INDEX "risk_research_result_shelf_document_id_key"
  ON "risk_research_result"("shelf_document_id");

ALTER TABLE "risk_research_result"
  ADD CONSTRAINT "risk_research_result_shelf_document_fk"
  FOREIGN KEY ("shelf_document_id") REFERENCES "document"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
