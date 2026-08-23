-- Formular-Uploads werden ihrer Submission und ihrem FILE-Feld explizit
-- zugeordnet. Ohne diese Bindung konnte eine Dokument-UUID eines anderen
-- Formulars desselben Mandanten als Antwort eingesetzt werden; außerdem war
-- ein echtes, autorisiertes Verwerfen vor dem Submit nicht möglich.

ALTER TABLE "document"
  ADD COLUMN "form_submission_id" UUID,
  ADD COLUMN "form_field_key" TEXT;

ALTER TABLE "document"
  ADD CONSTRAINT "document_form_upload_pair_check"
  CHECK (
    ("form_submission_id" IS NULL AND "form_field_key" IS NULL)
    OR
    ("form_submission_id" IS NOT NULL AND "form_field_key" IS NOT NULL AND btrim("form_field_key") <> '')
  );

ALTER TABLE "document"
  ADD CONSTRAINT "document_form_submission_fkey"
  FOREIGN KEY ("form_submission_id") REFERENCES "form_submission"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX "document_form_submission_idx"
  ON "document" ("tenant_id", "form_submission_id", "form_field_key");

-- Das allgemeine Storage-Orphan-Journal bleibt fuer Portal-Akteure per RLS
-- unsichtbar. Fuer das Verwerfen eines eigenen, noch offenen Formular-Uploads
-- gibt es deshalb genau diesen eng gebundenen SECURITY-DEFINER-Einstieg. Alle
-- Journaldaten werden aus der bereits persistierten DocumentVersion gelesen;
-- der Mandant kann weder Bucket/Key noch Hash oder Tenant frei vorgeben.
CREATE OR REPLACE FUNCTION app.journal_open_form_upload_discard(
  p_submission_id UUID,
  p_field_key TEXT,
  p_document_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  v_tenant_id UUID := app.current_tenant_id();
  v_actor_id UUID := app.current_actor_id();
  v_client_id UUID;
  v_request_id UUID;
  v_storage_bucket TEXT;
  v_storage_key TEXT;
  v_storage_version_id TEXT;
  v_sha256 BYTEA;
  v_size_bytes BIGINT;
  v_orphan_id UUID;
  v_version_count INTEGER;
BEGIN
  IF v_tenant_id IS NULL
     OR v_actor_id IS NULL
     OR app.current_actor_type() IS DISTINCT FROM 'CLIENT_CONTACT' THEN
    RAISE EXCEPTION 'Formular-Uploads duerfen nur im gebundenen Mandantenkontext verworfen werden.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT cc."client_id"
    INTO v_client_id
    FROM public."client_contact" cc
   WHERE cc."id" = v_actor_id
     AND cc."tenant_id" = v_tenant_id
     AND cc."active" = TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mandantenkontakt ist nicht aktiv oder gehoert nicht zum aktuellen Tenant.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Submission, Feld und Dokument bilden gemeinsam die Autorisierungsgrenze.
  -- Ein geschlossener Request sperrt den Pfad auch dann, wenn eine alte
  -- Submission noch DRAFT/PENDING ist. FOR UPDATE serialisiert mit Submit,
  -- Upload und Kanzlei-Close.
  SELECT fs."request_id"
    INTO v_request_id
    FROM public."form_submission" fs
    JOIN public."form_field" ff
      ON ff."template_id" = fs."template_id"
     AND ff."key" = p_field_key
     AND ff."type" = 'FILE'
    JOIN public."document" d
      ON d."id" = p_document_id
     AND d."tenant_id" = fs."tenant_id"
     AND d."client_id" = fs."client_id"
     AND d."form_submission_id" = fs."id"
     AND d."form_field_key" = ff."key"
   WHERE fs."id" = p_submission_id
     AND fs."tenant_id" = v_tenant_id
     AND fs."client_id" = v_client_id
     AND fs."status" IN ('PENDING', 'DRAFT')
     AND d."classification" = 'GENERAL'
     AND d."deleted_at" IS NULL
   FOR UPDATE OF fs, d;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Formular-Upload ist nicht mehr verwerfbar.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Request-Zeilen erst nach Submission/Dokument und in stabiler Reihenfolge
  -- sperren. closeRequestAction nimmt beim Status-UPDATE denselben Row-Lock.
  -- Nach einem eventuellen Warten wird der Status in einem neuen READ-COMMITTED-
  -- Snapshot erneut geprueft; ein bereits gewonnener Close kann damit nie von
  -- einem nachlaufenden Portal-Discard ueberholt werden.
  PERFORM r."id"
    FROM public."request" r
   WHERE r."tenant_id" = v_tenant_id
     AND r."client_id" = v_client_id
     AND (
       (v_request_id IS NOT NULL AND r."id" = v_request_id)
       OR
       (v_request_id IS NULL AND r."form_submission_id" = p_submission_id)
     )
   ORDER BY r."id"
   FOR UPDATE;

  IF v_request_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public."request" r
       WHERE r."id" = v_request_id
         AND r."tenant_id" = v_tenant_id
         AND r."client_id" = v_client_id
         AND r."status" IN ('OPEN', 'IN_PROGRESS')
    ) THEN
      RAISE EXCEPTION 'Formular-Upload ist nicht mehr verwerfbar.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF EXISTS (
    SELECT 1
      FROM public."request" r
     WHERE r."form_submission_id" = p_submission_id
       AND r."tenant_id" = v_tenant_id
       AND r."client_id" = v_client_id
       AND r."status" NOT IN ('OPEN', 'IN_PROGRESS')
  ) THEN
    RAISE EXCEPTION 'Formular-Upload ist nicht mehr verwerfbar.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT count(*)::INTEGER
    INTO v_version_count
    FROM public."document_version" dv
   WHERE dv."document_id" = p_document_id;
  IF v_version_count <> 1 THEN
    RAISE EXCEPTION 'Formular-Upload besitzt keinen eindeutig loeschbaren Speicherstand.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT dv."storage_bucket",
         dv."storage_key",
         COALESCE(btrim(dv."storage_version_id"), ''),
         dv."sha256",
         dv."size_bytes"
    INTO v_storage_bucket,
         v_storage_key,
         v_storage_version_id,
         v_sha256,
         v_size_bytes
    FROM public."document_version" dv
   WHERE dv."document_id" = p_document_id
     AND dv."immutable" = FALSE
     AND dv."scan_status" = 'CLEAN'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Formular-Upload ist nicht als verwerfbarer Speicherstand abgelegt.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_storage_key NOT LIKE ('tenants/' || v_tenant_id::TEXT || '/none/%') THEN
    RAISE EXCEPTION 'Storage-Pfad des Formular-Uploads verletzt die Tenant-Grenze.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  INSERT INTO public."storage_orphan" AS orphan (
    "tenant_id",
    "source",
    "storage_bucket",
    "storage_key",
    "storage_version_id",
    "sha256",
    "size_bytes",
    "immutable",
    "retention_until",
    "failure",
    "cleanup_claimed_at",
    "cleanup_error",
    "cleaned_at",
    "resolution"
  ) VALUES (
    v_tenant_id,
    'portal.form.file.discard',
    v_storage_bucket,
    v_storage_key,
    v_storage_version_id,
    v_sha256,
    v_size_bytes,
    FALSE,
    NULL,
    'FORM_UPLOAD_DISCARD_INTENT',
    NULL,
    NULL,
    NULL,
    NULL
  )
  ON CONFLICT ("storage_bucket", "storage_key", "storage_version_id")
  DO UPDATE SET
    "source" = EXCLUDED."source",
    "failure" = EXCLUDED."failure",
    "cleanup_claimed_at" = NULL,
    "cleanup_error" = NULL,
    "immutable" = FALSE,
    "retention_until" = NULL,
    "cleaned_at" = NULL,
    "resolution" = NULL
  WHERE orphan."tenant_id" = v_tenant_id
  RETURNING orphan."id" INTO v_orphan_id;

  -- Ein global kollidierender Storage-Identifier eines anderen Tenants darf
  -- selbst fuer den Function-Owner niemals umgehangen werden.
  IF v_orphan_id IS NULL THEN
    RAISE EXCEPTION 'Storage-Identifier kollidiert tenantuebergreifend.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN v_orphan_id;
END;
$$;

REVOKE ALL ON FUNCTION app.journal_open_form_upload_discard(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.journal_open_form_upload_discard(UUID, TEXT, UUID) TO taxtronik_app;

-- Bereits gespeicherte Draft-Antworten nur dann zurückverknüpfen, wenn der
-- unveränderliche Audit-Trail die Datei tatsächlich als Upload genau dieser
-- Submission und dieses Feldes belegt. `answers` allein ist untrusted input:
-- ältere Validatoren akzeptierten dort auch IDs normaler Mandantendokumente.
-- Eine Bindung allein aus JSON würde deren physisches Löschen ermöglichen.
WITH answer_refs AS (
  SELECT CASE
           WHEN jsonb_typeof(entry.value) = 'object'
            AND entry.value ->> 'documentId' ~*
                '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           THEN (entry.value ->> 'documentId')::UUID
           ELSE NULL
         END AS document_id,
         submission.id AS submission_id,
         entry.key AS field_key
    FROM "form_submission" submission
   CROSS JOIN LATERAL jsonb_each(
     CASE
       WHEN jsonb_typeof(submission."answers") = 'object' THEN submission."answers"
       ELSE '{}'::JSONB
     END
   ) AS entry(key, value)
    JOIN "audit_log" audit
      ON audit."tenant_id" = submission."tenant_id"
     AND audit."action" = 'form.submission.upload'
     AND audit."resource_type" = 'document'
     AND audit."resource_id" = (entry.value ->> 'documentId')
     AND audit."after" ->> 'submissionId' = submission."id"::TEXT
     AND audit."after" ->> 'fieldKey' = entry.key
   WHERE jsonb_typeof(entry.value) = 'object'
     AND entry.value ->> 'documentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
), unique_refs AS (
  SELECT document_id,
         min(submission_id::TEXT)::UUID AS submission_id,
         min(field_key) AS field_key
    FROM answer_refs
   GROUP BY document_id
  HAVING count(*) = 1
)
UPDATE "document" document
   SET "form_submission_id" = refs.submission_id,
       "form_field_key" = refs.field_key
  FROM unique_refs refs
 WHERE document."id" = refs.document_id
   AND document."form_submission_id" IS NULL
   AND document."classification" = 'GENERAL';

-- Pro Submission/Feld darf es genau einen lebenden Upload geben. Der
-- Submission-Row-Lock im App-Pfad liefert die fachliche Fehlermeldung; dieser
-- partielle Index bleibt der DB-seitige Backstop gegen vergessene oder neue
-- Aufrufer. Geloeschte historische Dokumente blockieren einen Neu-Upload nicht.
CREATE UNIQUE INDEX "document_open_form_field_upload_unique"
  ON "document" ("form_submission_id", "form_field_key")
  WHERE "form_submission_id" IS NOT NULL
    AND "deleted_at" IS NULL;
