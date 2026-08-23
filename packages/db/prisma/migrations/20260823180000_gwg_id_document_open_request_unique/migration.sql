-- Ein Ausweisdokument darf gleichzeitig nur eine aktive Erneuerungsanforderung
-- besitzen. Abgeschlossene Anforderungen bleiben dagegen als Historie
-- verknuepft und blockieren eine spaetere Erneuerungsrunde nicht.
--
-- Dieser additive Backstop haelt auch Upgrade-Staende konsistent, auf denen
-- die erste Reparatur eventuell nur teilweise oder manuell nachvollzogen
-- wurde, und ergaenzt den regulaeren Lookup-Index fuer die Prisma-Abfragen.
BEGIN;

DROP INDEX IF EXISTS request_gwg_id_doc_unique;

-- Defensive Upgrade-Reparatur: Sollte zwischenzeitlich ein Stand ohne den
-- partiellen Backstop aktive Dubletten zugelassen haben, bleibt deterministisch
-- die aelteste aktive Verknuepfung erhalten. CLOSED/CANCELLED werden absichtlich
-- nicht angefasst und verlieren niemals ihren historischen Herkunftslink.
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

-- Prisma kann partielle Indizes nicht im Schema ausdruecken. Der regulaere
-- Index bildet deshalb das Schema und beschleunigt historische Lookups; der
-- partielle Unique-Index ist der DB-seitige Race-Backstop fuer aktive Status.
CREATE INDEX IF NOT EXISTS request_gwg_id_doc_idx
  ON request (linked_gwg_id_document_id);

CREATE UNIQUE INDEX IF NOT EXISTS request_gwg_id_doc_open_unique
  ON request (linked_gwg_id_document_id)
  WHERE linked_gwg_id_document_id IS NOT NULL
    AND status IN ('OPEN', 'IN_PROGRESS', 'RESPONDED');

COMMIT;
