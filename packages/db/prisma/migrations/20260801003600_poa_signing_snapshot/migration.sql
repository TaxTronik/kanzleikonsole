-- Bind every signing token to the exact content shown when it was issued.
-- Existing SENT rows intentionally stay NULL and must be re-sent before they
-- can be signed; silently deriving a snapshot later would defeat the binding.
ALTER TABLE "client"
  ADD COLUMN "poa_signer_data_redacted_at" TIMESTAMPTZ(6);

ALTER TABLE "power_of_attorney"
  ADD COLUMN "sent_at" TIMESTAMPTZ(6),
  ADD COLUMN "signing_content_snapshot" TEXT,
  ADD COLUMN "signing_content_sha256" BYTEA,
  ADD COLUMN "signing_document_version_id" UUID;

ALTER TABLE "power_of_attorney"
  ADD CONSTRAINT "poa_sent_at_after_created_check"
    CHECK ("sent_at" IS NULL OR "sent_at" >= "created_at") NOT VALID,
  ADD CONSTRAINT "poa_signing_snapshot_hash_pair_check"
    CHECK (("signing_content_snapshot" IS NULL) = ("signing_content_sha256" IS NULL)),
  ADD CONSTRAINT "poa_signing_document_requires_snapshot_check"
    CHECK ("signing_document_version_id" IS NULL OR "signing_content_snapshot" IS NOT NULL),
  ADD CONSTRAINT "poa_signing_sha256_length_check"
    CHECK ("signing_content_sha256" IS NULL OR octet_length("signing_content_sha256") = 32),
  ADD CONSTRAINT "poa_signed_sha256_length_check"
    CHECK ("signed_content_sha256" IS NULL OR octet_length("signed_content_sha256") = 32);

-- Transition-aware instead of a blanket CHECK on SENT/SIGNED: historical rows
-- may legitimately have reached those states before snapshots existed. They
-- remain revocable/expirable/anonymizable, but cannot newly become SIGNED until
-- a valid snapshot was established by a separate resend.
CREATE OR REPLACE FUNCTION app.poa_protect_integrity()
RETURNS TRIGGER AS $$
DECLARE
  snapshot_json JSONB;
  version_sha256 BYTEA;
  validate_snapshot BOOLEAN := FALSE;
  entering_signed BOOLEAN := FALSE;
  retention_anonymization BOOLEAN := FALSE;
  retention_closed BOOLEAN := FALSE;
  validate_client_scope BOOLEAN := FALSE;
BEGIN
  -- Lock and validate the concrete client row before any INSERT can reach the
  -- later FK trigger. This serializes PoA creation with final retention and
  -- also enforces the tenant/client pair missing from the legacy FK layout.
  validate_client_scope := TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    validate_client_scope :=
      NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
      OR NEW."client_id" IS DISTINCT FROM OLD."client_id";
  END IF;

  IF validate_client_scope THEN
    SELECT (
      c."mandate_ended_at" IS NOT NULL
      AND make_date(
            EXTRACT(YEAR FROM c."mandate_ended_at")::INTEGER + 11,
            1,
            1
          ) <= CURRENT_DATE
      AND (
        (c."kind" = 'NATPERS' AND c."anonymized_at" IS NOT NULL) OR
        (
          c."kind" IN ('JURPERS', 'PERSGES')
          AND c."poa_signer_data_redacted_at" IS NOT NULL
        )
      )
    )
      INTO retention_closed
      FROM public."client" c
     WHERE c."id" = NEW."client_id"
       AND c."tenant_id" = NEW."tenant_id"
     FOR UPDATE OF c;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PoA-Mandant gehört nicht zum angegebenen Tenant.'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF retention_closed THEN
      RAISE EXCEPTION 'PoA-Neuanlage/-zuordnung ist nach abgeschlossener Signer-Retention nicht zulässig.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id" OR
    NEW."created_by_staff" IS DISTINCT FROM OLD."created_by_staff" OR
    NEW."created_at" IS DISTINCT FROM OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'PoA-Erstellungsprovenienz ist unveränderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- SENT/SIGNED are evidence-bearing workflow states and may only arise via
    -- the controlled transitions below.
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Neue PoA muss im Status DRAFT angelegt werden.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."sent_at" IS NOT NULL
       OR NEW."signed_by_ip" IS NOT NULL
       OR NEW."signed_by_user_agent" IS NOT NULL
       OR NEW."revoked_at" IS NOT NULL
       OR NEW."revoked_reason" IS NOT NULL THEN
      RAISE EXCEPTION 'Neue PoA im Status DRAFT darf noch keine Versand-, Signatur- oder Widerrufsprovenienz tragen.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."signing_content_sha256" IS NOT NULL
       AND octet_length(NEW."signing_content_sha256") <> 32 THEN
      RAISE EXCEPTION 'PoA-Versandhash muss genau 32 Byte (SHA-256) lang sein.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."signed_content_sha256" IS NOT NULL
       AND octet_length(NEW."signed_content_sha256") <> 32 THEN
      RAISE EXCEPTION 'PoA-Signaturhash muss genau 32 Byte (SHA-256) lang sein.'
        USING ERRCODE = 'check_violation';
    END IF;
    validate_snapshot := NEW."signing_content_snapshot" IS NOT NULL;
    entering_signed := FALSE;
  ELSE
    -- Vollständige Vorwärtsmatrix; insbesondere REVOKED und EXPIRED sind
    -- terminal. Statusgleiche Updates bleiben für OTP, Revoke-Metadaten und
    -- DSGVO-Anonymisierung möglich.
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
      (OLD."status" = 'DRAFT'  AND NEW."status" IN ('SENT', 'REVOKED', 'EXPIRED')) OR
      (OLD."status" = 'SENT'   AND NEW."status" IN ('SIGNED', 'REVOKED', 'EXPIRED')) OR
      (OLD."status" = 'SIGNED' AND NEW."status" IN ('REVOKED', 'EXPIRED'))
    ) THEN
      RAISE EXCEPTION 'PoA-Statuswechsel % -> % ist nicht zulässig.', OLD."status", NEW."status"
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Der erste belastbare Versandzeitpunkt stammt ausschließlich von der DB.
    -- Das gilt auch für einen Legacy-SENT-Datensatz, der durch einen separaten
    -- Resend erstmals einen Inhalts-Snapshot erhält. Danach ist der Zeitpunkt
    -- unveränderlich und kann nicht für eine Rückdatierung missbraucht werden.
    IF OLD."sent_at" IS NULL AND (
      (OLD."status" = 'DRAFT' AND NEW."status" = 'SENT') OR
      (
        OLD."status" = 'SENT' AND NEW."status" = 'SENT'
        AND OLD."signing_content_snapshot" IS NULL
        AND NEW."signing_content_snapshot" IS NOT NULL
      )
    ) THEN
      -- created_at is legacy TIMESTAMP(3). Round the later statement timestamp
      -- to the same precision so a fast transition cannot appear earlier due
      -- solely to different rounding. Do not clamp to created_at: an invalid,
      -- future creation time must still fail poa_sent_at_after_created_check.
      NEW."sent_at" := statement_timestamp()::TIMESTAMPTZ(3);
    ELSIF NEW."sent_at" IS DISTINCT FROM OLD."sent_at" THEN
      RAISE EXCEPTION 'PoA-Versandzeitpunkt ist unveränderlich.'
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Einziger zulässiger Redaktionspfad für die sonst immutable Beweiskopie:
    -- NATPERS wurde nachweislich anonymisiert bzw. für JURPERS/PERSGES wurde
    -- der eigene PoA-Signer-Retentionlauf markiert UND die 10-Jahres-Frist ab
    -- Mandatsende-Jahresende ist abgelaufen.
    -- Das exakte Zielmuster verhindert, dass dieser Pfad als allgemeines
    -- Immutability-Bypass missbraucht wird.
    SELECT (
      EXISTS (
        SELECT 1
          FROM public."client" c
         WHERE c."id" = NEW."client_id"
           AND c."tenant_id" = NEW."tenant_id"
           AND c."mandate_ended_at" IS NOT NULL
           AND make_date(
                 EXTRACT(YEAR FROM c."mandate_ended_at")::INTEGER + 11,
                 1,
                 1
               ) <= CURRENT_DATE
           AND (
             (c."kind" = 'NATPERS' AND c."anonymized_at" IS NOT NULL) OR
             (
               c."kind" IN ('JURPERS', 'PERSGES')
               AND c."poa_signer_data_redacted_at" IS NOT NULL
             )
           )
      )
      -- Nur die fest definierte Redaktion darf von der Beweis-Immutability
      -- abweichen. Alle Identitäts-, Status-, Frist- und Auditfelder bleiben
      -- dabei unverändert; updated_at darf Prisma erwartungsgemäß fortschreiben.
      AND NEW."id" IS NOT DISTINCT FROM OLD."id"
      AND NEW."tenant_id" IS NOT DISTINCT FROM OLD."tenant_id"
      AND NEW."client_id" IS NOT DISTINCT FROM OLD."client_id"
      AND NEW."valid_from" IS NOT DISTINCT FROM OLD."valid_from"
      AND NEW."valid_until" IS NOT DISTINCT FROM OLD."valid_until"
      AND NEW."status" IS NOT DISTINCT FROM OLD."status"
      AND NEW."created_by_staff" IS NOT DISTINCT FROM OLD."created_by_staff"
      AND NEW."sent_at" IS NOT DISTINCT FROM OLD."sent_at"
      AND NEW."revoked_at" IS NOT DISTINCT FROM OLD."revoked_at"
      AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
      AND NEW."signer_contact_id" IS NULL
      AND NEW."signer_name" = 'Anonymisiert'
      AND NEW."signer_email"::TEXT = 'anonymisiert@taxtronik.local'
      AND NEW."subject" = 'Anonymisiert'
      AND NEW."scope" = 'Anonymisiert'
      AND NEW."signing_token_hash" IS NULL
      AND NEW."signing_token_expires_at" IS NULL
      AND NEW."signing_otp_hash" IS NULL
      AND NEW."signing_otp_expires_at" IS NULL
      AND NEW."signing_otp_attempts" = 0
      AND NEW."signing_otp_attempts_total" = 0
      AND NEW."signing_content_snapshot" IS NULL
      AND NEW."signing_content_sha256" IS NULL
      AND NEW."signing_document_version_id" IS NULL
      AND NEW."signed_at" IS NULL
      AND NEW."signed_content_sha256" IS NULL
      AND NEW."signed_document_version_id" IS NULL
      AND NEW."signed_by_ip" IS NULL
      AND NEW."signed_by_user_agent" IS NULL
      AND NEW."document_id" IS NULL
      AND NEW."revoked_reason" IS NULL
    ) INTO retention_anonymization;

    -- Die fachlichen Inhalts- und Unterzeichnerfelder sind ab dem ersten
    -- Verlassen von DRAFT festgeschrieben. Nur die oben exakt eingegrenzte
    -- DSGVO-Retention darf sie nach Fristablauf redigieren.
    IF NOT retention_anonymization AND OLD."status" <> 'DRAFT' AND (
      NEW."signer_contact_id" IS DISTINCT FROM OLD."signer_contact_id" OR
      NEW."signer_name" IS DISTINCT FROM OLD."signer_name" OR
      NEW."signer_email" IS DISTINCT FROM OLD."signer_email" OR
      NEW."subject" IS DISTINCT FROM OLD."subject" OR
      NEW."scope" IS DISTINCT FROM OLD."scope" OR
      NEW."valid_from" IS DISTINCT FROM OLD."valid_from" OR
      NEW."valid_until" IS DISTINCT FROM OLD."valid_until" OR
      NEW."document_id" IS DISTINCT FROM OLD."document_id" OR
      NEW."client_id" IS DISTINCT FROM OLD."client_id" OR
      NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    ) THEN
      RAISE EXCEPTION 'PoA-Inhaltsfelder sind nach dem ersten Versand unveränderlich.'
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Ein vorhandener Versand-Snapshot ist append-only. Ein Resend schreibt
    -- dieselben Werte erneut und bleibt damit erlaubt.
    IF NOT retention_anonymization AND OLD."signing_content_snapshot" IS NOT NULL AND (
      NEW."signing_content_snapshot" IS DISTINCT FROM OLD."signing_content_snapshot" OR
      NEW."signing_content_sha256" IS DISTINCT FROM OLD."signing_content_sha256" OR
      NEW."signing_document_version_id" IS DISTINCT FROM OLD."signing_document_version_id"
    ) THEN
      RAISE EXCEPTION 'PoA-Versand-Snapshot ist nach dem ersten Versand unveränderlich.'
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Legacy-SENT darf durch einen statusgleichen Resend einmalig einen
    -- Snapshot erhalten. Retroaktive Bindung einer bereits SIGNED/terminalen
    -- Zeile oder Bindung erst im selben SENT->SIGNED-Statement ist unzulässig.
    IF NOT retention_anonymization
       AND OLD."signing_content_snapshot" IS NULL
       AND NEW."signing_content_snapshot" IS NOT NULL
       AND NOT (
         (OLD."status" = 'DRAFT' AND NEW."status" = 'SENT') OR
         (OLD."status" = 'SENT' AND NEW."status" = 'SENT')
       ) THEN
      RAISE EXCEPTION 'PoA-Legacy-Datensatz muss vor der Signatur separat neu versendet werden.'
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Nach dem Signaturakt bleiben Hash, Version, Zeitpunkt und die technisch
    -- erhobenen Herkunftsindizien auch bei REVOKED/EXPIRED unveränderlich.
    -- Legacy-SIGNED ohne diese Felder bleibt migrationsfähig, darf sie aber
    -- nicht nachträglich setzen.
    IF NOT retention_anonymization AND (
      OLD."status" = 'SIGNED' OR
      OLD."signed_at" IS NOT NULL OR
      OLD."signed_content_sha256" IS NOT NULL OR
      OLD."signed_document_version_id" IS NOT NULL OR
      OLD."signed_by_ip" IS NOT NULL OR
      OLD."signed_by_user_agent" IS NOT NULL
    ) AND (
      NEW."signed_at" IS DISTINCT FROM OLD."signed_at" OR
      NEW."signed_content_sha256" IS DISTINCT FROM OLD."signed_content_sha256" OR
      NEW."signed_document_version_id" IS DISTINCT FROM OLD."signed_document_version_id" OR
      NEW."signed_by_ip" IS DISTINCT FROM OLD."signed_by_ip" OR
      NEW."signed_by_user_agent" IS DISTINCT FROM OLD."signed_by_user_agent"
    ) THEN
      RAISE EXCEPTION 'PoA-Signaturnachweis ist unveränderlich.'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW."signing_content_sha256" IS DISTINCT FROM OLD."signing_content_sha256"
       AND NEW."signing_content_sha256" IS NOT NULL
       AND octet_length(NEW."signing_content_sha256") <> 32 THEN
      RAISE EXCEPTION 'PoA-Versandhash muss genau 32 Byte (SHA-256) lang sein.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."signed_content_sha256" IS DISTINCT FROM OLD."signed_content_sha256"
       AND NEW."signed_content_sha256" IS NOT NULL
       AND octet_length(NEW."signed_content_sha256") <> 32 THEN
      RAISE EXCEPTION 'PoA-Signaturhash muss genau 32 Byte (SHA-256) lang sein.'
        USING ERRCODE = 'check_violation';
    END IF;

    validate_snapshot :=
      NEW."signing_content_snapshot" IS DISTINCT FROM OLD."signing_content_snapshot" OR
      NEW."signing_content_sha256" IS DISTINCT FROM OLD."signing_content_sha256" OR
      NEW."signing_document_version_id" IS DISTINCT FROM OLD."signing_document_version_id" OR
      (OLD."status" = 'DRAFT' AND NEW."status" = 'SENT') OR
      (OLD."status" = 'SENT' AND NEW."status" = 'SIGNED');
    entering_signed := OLD."status" = 'SENT' AND NEW."status" = 'SIGNED';

    -- Signed-Evidence darf bei UPDATE ausschließlich atomar im echten
    -- SENT->SIGNED-Übergang entstehen. Statusgleiche bzw. terminale Zeilen
    -- dürfen es weder vorbefüllen noch nachtragen; die kontrollierte
    -- Retention darf es nach Fristablauf ausschließlich löschen.
    IF NOT retention_anonymization
       AND (
         NEW."signed_at" IS DISTINCT FROM OLD."signed_at" OR
         NEW."signed_content_sha256" IS DISTINCT FROM OLD."signed_content_sha256" OR
         NEW."signed_document_version_id" IS DISTINCT FROM OLD."signed_document_version_id" OR
         NEW."signed_by_ip" IS DISTINCT FROM OLD."signed_by_ip" OR
         NEW."signed_by_user_agent" IS DISTINCT FROM OLD."signed_by_user_agent"
       )
       AND NOT (
         OLD."status" = 'SENT'
         AND NEW."status" = 'SIGNED'
         AND OLD."signed_at" IS NULL
         AND OLD."signed_content_sha256" IS NULL
         AND OLD."signed_document_version_id" IS NULL
         AND OLD."signed_by_ip" IS NULL
         AND OLD."signed_by_user_agent" IS NULL
       ) THEN
      RAISE EXCEPTION 'PoA-Signaturnachweis darf nur atomar beim Übergang zu SIGNED entstehen.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Signed-Evidence darf niemals auf DRAFT/SENT vorbefüllt werden. Für einen
  -- migrationssicheren Legacy-Datensatz greift das Verbot nur bei INSERT,
  -- Statuswechsel oder tatsächlicher Änderung eines Signed-Feldes.
  IF TG_OP = 'INSERT' AND NEW."status" <> 'SIGNED' AND (
    NEW."signed_at" IS NOT NULL OR
    NEW."signed_content_sha256" IS NOT NULL OR
    NEW."signed_document_version_id" IS NOT NULL OR
    NEW."signed_by_ip" IS NOT NULL OR
    NEW."signed_by_user_agent" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PoA-Signaturnachweis darf nur mit Status SIGNED angelegt werden.'
      USING ERRCODE = 'check_violation';
  ELSIF NEW."status" IN ('DRAFT', 'SENT') AND (
    NEW."signed_at" IS NOT NULL OR
    NEW."signed_content_sha256" IS NOT NULL OR
    NEW."signed_document_version_id" IS NOT NULL OR
    NEW."signed_by_ip" IS NOT NULL OR
    NEW."signed_by_user_agent" IS NOT NULL
  ) THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'PoA-Signaturnachweis darf vor SIGNED nicht gesetzt werden.'
        USING ERRCODE = 'check_violation';
    ELSIF NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."signed_at" IS DISTINCT FROM OLD."signed_at"
       OR NEW."signed_content_sha256" IS DISTINCT FROM OLD."signed_content_sha256"
       OR NEW."signed_document_version_id" IS DISTINCT FROM OLD."signed_document_version_id"
       OR NEW."signed_by_ip" IS DISTINCT FROM OLD."signed_by_ip"
       OR NEW."signed_by_user_agent" IS DISTINCT FROM OLD."signed_by_user_agent" THEN
      RAISE EXCEPTION 'PoA-Signaturnachweis darf vor SIGNED nicht gesetzt werden.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF retention_anonymization THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'REVOKED' AND (
      NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" OR
      NEW."revoked_reason" IS DISTINCT FROM OLD."revoked_reason"
    ) THEN
      RAISE EXCEPTION 'PoA-Widerrufsnachweis ist unveränderlich.'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW."status" = 'REVOKED' AND OLD."status" <> 'REVOKED' THEN
      IF OLD."revoked_at" IS NOT NULL OR OLD."revoked_reason" IS NOT NULL
         OR NEW."revoked_at" IS NULL
         OR NULLIF(BTRIM(NEW."revoked_reason"), '') IS NULL THEN
        RAISE EXCEPTION 'PoA-Widerruf erfordert atomar Zeitpunkt und Begründung.'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."revoked_at" < NEW."created_at"
         OR (NEW."sent_at" IS NOT NULL AND NEW."revoked_at" < NEW."sent_at")
         OR (NEW."signed_at" IS NOT NULL AND NEW."revoked_at" < NEW."signed_at")
         OR NEW."revoked_at" < statement_timestamp() - INTERVAL '5 minutes'
         OR NEW."revoked_at" > statement_timestamp() + INTERVAL '5 minutes' THEN
        RAISE EXCEPTION 'PoA-Widerrufszeitpunkt ist unplausibel.'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."status" <> 'REVOKED' AND (
      NEW."revoked_at" IS NOT NULL OR NEW."revoked_reason" IS NOT NULL
    ) AND (
      NEW."status" IS DISTINCT FROM OLD."status" OR
      NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" OR
      NEW."revoked_reason" IS DISTINCT FROM OLD."revoked_reason"
    ) THEN
      RAISE EXCEPTION 'PoA-Widerrufsnachweis darf nur beim Übergang zu REVOKED entstehen.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status" = 'DRAFT' AND (
    NEW."signing_content_snapshot" IS NOT NULL OR
    NEW."signing_content_sha256" IS NOT NULL OR
    NEW."signing_document_version_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PoA-DRAFT darf noch keinen Versand-Snapshot tragen.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF validate_snapshot THEN
    IF NEW."signing_content_snapshot" IS NULL OR NEW."signing_content_sha256" IS NULL THEN
      RAISE EXCEPTION 'PoA-Versand erfordert Snapshot und SHA-256.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF octet_length(NEW."signing_content_sha256") <> 32 THEN
      RAISE EXCEPTION 'PoA-Versandhash muss genau 32 Byte (SHA-256) lang sein.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF digest(convert_to(NEW."signing_content_snapshot", 'UTF8'), 'sha256')
       <> NEW."signing_content_sha256" THEN
      RAISE EXCEPTION 'PoA-Versandhash stimmt nicht mit dem Snapshot überein.'
        USING ERRCODE = 'check_violation';
    END IF;

    BEGIN
      snapshot_json := NEW."signing_content_snapshot"::JSONB;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'PoA-Versand-Snapshot ist kein gültiges JSON.'
        USING ERRCODE = 'check_violation';
    END;

    IF jsonb_typeof(snapshot_json) <> 'object' THEN
      RAISE EXCEPTION 'PoA-Versand-Snapshot ist unvollständig oder passt nicht zu den Inhaltsfeldern.'
        USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT COUNT(*) FROM jsonb_object_keys(snapshot_json)) <> 8
       OR NOT snapshot_json ?& ARRAY[
         'schemaVersion', 'subject', 'signerName', 'signerEmail',
         'validFrom', 'validUntil', 'scope', 'document'
       ]
       OR COALESCE(jsonb_typeof(snapshot_json->'schemaVersion'), 'missing') <> 'number'
       OR snapshot_json->'schemaVersion' <> '1'::JSONB
       OR COALESCE(jsonb_typeof(snapshot_json->'subject'), 'missing') <> 'string'
       OR COALESCE(jsonb_typeof(snapshot_json->'signerName'), 'missing') <> 'string'
       OR COALESCE(jsonb_typeof(snapshot_json->'signerEmail'), 'missing') <> 'string'
       OR COALESCE(jsonb_typeof(snapshot_json->'validFrom'), 'missing') <> 'string'
       OR NOT (snapshot_json ? 'validUntil')
       OR COALESCE(jsonb_typeof(snapshot_json->'validUntil'), 'missing') NOT IN ('string', 'null')
       OR snapshot_json->>'subject' <> NEW."subject"
       OR snapshot_json->>'signerName' <> NEW."signer_name"
       OR snapshot_json->>'signerEmail' <> NEW."signer_email"::TEXT
       OR snapshot_json->>'validFrom' <> to_char(NEW."valid_from", 'YYYY-MM-DD')
       OR (
         NEW."valid_until" IS NULL
         AND jsonb_typeof(snapshot_json->'validUntil') <> 'null'
       )
       OR (
         NEW."valid_until" IS NOT NULL
         AND (
           jsonb_typeof(snapshot_json->'validUntil') <> 'string'
           OR snapshot_json->>'validUntil' <> to_char(NEW."valid_until", 'YYYY-MM-DD')
         )
       ) THEN
      RAISE EXCEPTION 'PoA-Versand-Snapshot ist unvollständig oder passt nicht zu den Inhaltsfeldern.'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."document_id" IS NULL THEN
      IF NEW."signing_document_version_id" IS NOT NULL
         OR COALESCE(jsonb_typeof(snapshot_json->'document'), 'missing') <> 'null'
         OR COALESCE(jsonb_typeof(snapshot_json->'scope'), 'missing') <> 'string'
         OR snapshot_json->>'scope' <> NEW."scope" THEN
        RAISE EXCEPTION 'PoA-Text-Snapshot muss exakt den Vollmachtstext enthalten.'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF NEW."signing_document_version_id" IS NULL
         OR COALESCE(jsonb_typeof(snapshot_json->'document'), 'missing') <> 'object'
         OR (CASE
              WHEN jsonb_typeof(snapshot_json->'document') = 'object'
              THEN (SELECT COUNT(*) FROM jsonb_object_keys(snapshot_json->'document'))
              ELSE -1
            END) <> 3
         OR NOT ((snapshot_json->'document') ?& ARRAY['documentId', 'versionId', 'sha256'])
         OR COALESCE(jsonb_typeof(snapshot_json->'scope'), 'missing') <> 'null'
         OR snapshot_json#>>'{document,documentId}' <> NEW."document_id"::TEXT
         OR snapshot_json#>>'{document,versionId}' <> NEW."signing_document_version_id"::TEXT
         OR COALESCE(snapshot_json#>>'{document,sha256}', '') !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'PoA-Dokument-Snapshot ist unvollständig oder verweist auf eine andere Version.'
          USING ERRCODE = 'check_violation';
      END IF;

      SELECT dv."sha256" INTO version_sha256
        FROM public."document_version" dv
       WHERE dv."id" = NEW."signing_document_version_id"
         AND dv."document_id" = NEW."document_id";
      IF NOT FOUND
         OR encode(version_sha256, 'hex') <> snapshot_json#>>'{document,sha256}' THEN
        RAISE EXCEPTION 'PoA-Dokumentversion oder Dokumenthash stimmt nicht mit dem Snapshot überein.'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF entering_signed THEN
    -- Legacy-SENT ohne Snapshot darf nicht Snapshot und Signatur in einem
    -- Schritt nachholen; zuerst ist ein separater Resend erforderlich.
    IF TG_OP = 'UPDATE' AND OLD."signing_content_snapshot" IS NULL THEN
      RAISE EXCEPTION 'PoA-Legacy-SENT muss vor der Signatur neu versendet werden.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND (
      OLD."signed_at" IS NOT NULL OR
      OLD."signed_content_sha256" IS NOT NULL OR
      OLD."signed_document_version_id" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'PoA-Signaturnachweis muss atomar beim Übergang zu SIGNED entstehen.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."signed_at" IS NULL OR NEW."signed_content_sha256" IS NULL THEN
      RAISE EXCEPTION 'PoA-SIGNED erfordert Zeitpunkt und signierten SHA-256.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."sent_at" IS NULL
       OR NEW."signed_at" < NEW."sent_at"
       OR NEW."signed_at" < NEW."created_at"
       OR NEW."signed_at" < statement_timestamp() - INTERVAL '5 minutes'
       OR NEW."signed_at" > statement_timestamp() + INTERVAL '5 minutes' THEN
      RAISE EXCEPTION 'PoA-Signaturzeitpunkt liegt nicht plausibel nach dem Versand.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF octet_length(NEW."signed_content_sha256") <> 32
       OR NEW."signed_content_sha256" <> NEW."signing_content_sha256" THEN
      RAISE EXCEPTION 'PoA-Signaturhash muss dem Versandhash entsprechen.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."signed_document_version_id"
       IS DISTINCT FROM NEW."signing_document_version_id" THEN
      RAISE EXCEPTION 'PoA-signierte Dokumentversion muss der Versandversion entsprechen.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.poa_protect_integrity()
  SET search_path = pg_catalog, public, app, pg_temp;

CREATE TRIGGER poa_protect_integrity
  BEFORE INSERT OR UPDATE ON public."power_of_attorney"
  FOR EACH ROW EXECUTE FUNCTION app.poa_protect_integrity();
