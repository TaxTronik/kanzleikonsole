-- Ein ablaufendes GwG-Ausweisdokument darf auch bei parallelen Worker-Läufen
-- höchstens eine AKTIVE automatisch verknüpfte Anforderung erzeugen.
-- Geschlossene/abgebrochene Anforderungen bleiben vollstaendig als Historie
-- verknuepft und duerfen eine spaetere Erneuerungsrunde nicht blockieren.
BEGIN;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY linked_gwg_id_document_id
      ORDER BY created_at ASC, id ASC
    ) AS duplicate_no
  FROM request
  WHERE linked_gwg_id_document_id IS NOT NULL
    AND status IN ('OPEN', 'IN_PROGRESS', 'RESPONDED')
)
UPDATE request AS r
SET linked_gwg_id_document_id = NULL
FROM ranked
WHERE r.id = ranked.id
  AND ranked.duplicate_no > 1;

DROP INDEX IF EXISTS request_gwg_id_doc_idx;

CREATE UNIQUE INDEX request_gwg_id_doc_open_unique
  ON request (linked_gwg_id_document_id)
  WHERE linked_gwg_id_document_id IS NOT NULL
    AND status IN ('OPEN', 'IN_PROGRESS', 'RESPONDED');

COMMIT;
