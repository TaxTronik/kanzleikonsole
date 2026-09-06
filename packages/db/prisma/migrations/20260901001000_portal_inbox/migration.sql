-- PORTAL-INBOX-SUBMISSION-001 / ACCESS-SEARCH-SCOPE-001
-- Kontaktprivate Upload-Entwürfe, mandantenweite abgesendete Nachrichten und
-- eine ausdrücklich staffseitige Archivannahme bleiben getrennte Zustände.
BEGIN;

CREATE TYPE public.portal_inbox_topic AS ENUM (
  'GENERAL', 'DOCUMENTS', 'BILLING', 'APPOINTMENT', 'OTHER'
);
CREATE TYPE public.portal_inbox_thread_status AS ENUM ('OPEN', 'RESOLVED');
CREATE TYPE public.portal_inbox_attention AS ENUM ('STAFF', 'CLIENT', 'NONE');
CREATE TYPE public.portal_inbox_author_type AS ENUM ('STAFF', 'CLIENT_CONTACT');
CREATE TYPE public.portal_inbox_upload_purpose AS ENUM ('NEW_THREAD', 'REPLY');
CREATE TYPE public.portal_inbox_upload_batch_status AS ENUM (
  'OPEN', 'CONSUMED', 'DISCARDED', 'EXPIRED'
);
CREATE TYPE public.portal_inbox_attachment_scan_status AS ENUM (
  'PENDING', 'CLEAN', 'BLOCKED'
);
CREATE TYPE public.portal_inbox_attachment_decision AS ENUM (
  'PENDING_REVIEW', 'ACCEPTED', 'REJECTED', 'BLOCKED'
);

CREATE TABLE public.portal_inbox_thread (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  client_id UUID NOT NULL,
  subject VARCHAR(200) NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 200),
  topic public.portal_inbox_topic NOT NULL DEFAULT 'GENERAL',
  status public.portal_inbox_thread_status NOT NULL DEFAULT 'OPEN',
  attention public.portal_inbox_attention NOT NULL DEFAULT 'STAFF',
  created_by_contact_id UUID NOT NULL REFERENCES public.client_contact(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  assigned_staff_id UUID REFERENCES public.staff_user(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  last_message_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMPTZ(6),
  resolved_by_staff_id UUID REFERENCES public.staff_user(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT portal_inbox_thread_client_fk
    FOREIGN KEY (tenant_id, client_id)
    REFERENCES public.client(tenant_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT portal_inbox_thread_scope_key UNIQUE (tenant_id, client_id, id),
  CONSTRAINT portal_inbox_thread_resolution_check CHECK (
    (status = 'OPEN' AND resolved_at IS NULL AND resolved_by_staff_id IS NULL AND attention <> 'NONE')
    OR
    (status = 'RESOLVED' AND resolved_at IS NOT NULL AND resolved_by_staff_id IS NOT NULL AND attention = 'NONE')
  ),
  CONSTRAINT portal_inbox_thread_time_check CHECK (last_message_at >= created_at)
);
CREATE INDEX portal_inbox_thread_client_filter_idx
  ON public.portal_inbox_thread
    (tenant_id, client_id, status, topic, last_message_at DESC, id DESC);
CREATE INDEX portal_inbox_thread_assignee_idx
  ON public.portal_inbox_thread
    (tenant_id, assigned_staff_id, status, last_message_at DESC);
CREATE INDEX portal_inbox_thread_subject_trgm_idx
  ON public.portal_inbox_thread USING GIN (subject gin_trgm_ops);

CREATE TABLE public.portal_inbox_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  client_id UUID NOT NULL,
  thread_id UUID NOT NULL,
  author_type public.portal_inbox_author_type NOT NULL,
  author_id UUID NOT NULL,
  body TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 10000),
  client_mutation_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT portal_inbox_message_client_fk
    FOREIGN KEY (tenant_id, client_id)
    REFERENCES public.client(tenant_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT portal_inbox_message_thread_fk
    FOREIGN KEY (tenant_id, client_id, thread_id)
    REFERENCES public.portal_inbox_thread(tenant_id, client_id, id)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT portal_inbox_message_scope_key UNIQUE (tenant_id, client_id, id),
  CONSTRAINT portal_inbox_message_mutation_key UNIQUE (thread_id, client_mutation_id),
  CONSTRAINT portal_inbox_message_author_mutation_key
    UNIQUE (tenant_id, client_id, author_type, author_id, client_mutation_id)
);
CREATE INDEX portal_inbox_message_thread_idx
  ON public.portal_inbox_message(thread_id, created_at, id);

CREATE TABLE public.portal_inbox_upload_batch (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  client_id UUID NOT NULL,
  created_by_contact_id UUID NOT NULL REFERENCES public.client_contact(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  purpose public.portal_inbox_upload_purpose NOT NULL,
  target_thread_id UUID,
  status public.portal_inbox_upload_batch_status NOT NULL DEFAULT 'OPEN',
  expires_at TIMESTAMPTZ(6) NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours'),
  manifest_sha256 BYTEA,
  consumed_at TIMESTAMPTZ(6),
  discarded_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT portal_inbox_upload_batch_client_fk
    FOREIGN KEY (tenant_id, client_id)
    REFERENCES public.client(tenant_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT portal_inbox_upload_batch_target_thread_fk
    FOREIGN KEY (tenant_id, client_id, target_thread_id)
    REFERENCES public.portal_inbox_thread(tenant_id, client_id, id)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT portal_inbox_upload_batch_scope_key UNIQUE (tenant_id, client_id, id),
  CONSTRAINT portal_inbox_upload_batch_purpose_check CHECK (
    (purpose = 'NEW_THREAD' AND target_thread_id IS NULL)
    OR (purpose = 'REPLY' AND target_thread_id IS NOT NULL)
  ),
  CONSTRAINT portal_inbox_upload_batch_manifest_check CHECK (
    manifest_sha256 IS NULL OR octet_length(manifest_sha256) = 32
  ),
  CONSTRAINT portal_inbox_upload_batch_state_check CHECK (
    (status = 'OPEN' AND manifest_sha256 IS NULL AND consumed_at IS NULL AND discarded_at IS NULL)
    OR
    (status = 'CONSUMED' AND octet_length(manifest_sha256) = 32 AND consumed_at IS NOT NULL AND discarded_at IS NULL)
    OR
    (status = 'DISCARDED' AND manifest_sha256 IS NULL AND consumed_at IS NULL AND discarded_at IS NOT NULL)
    OR
    (status = 'EXPIRED' AND manifest_sha256 IS NULL AND consumed_at IS NULL AND discarded_at IS NULL)
  ),
  CONSTRAINT portal_inbox_upload_batch_expiry_check CHECK (expires_at > created_at)
);
CREATE INDEX portal_inbox_upload_batch_contact_idx
  ON public.portal_inbox_upload_batch
    (tenant_id, created_by_contact_id, status, expires_at);
CREATE INDEX portal_inbox_upload_batch_expiry_idx
  ON public.portal_inbox_upload_batch(tenant_id, status, expires_at);

CREATE TABLE public.portal_inbox_attachment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  client_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  message_id UUID,
  original_name VARCHAR(255) NOT NULL CHECK (length(btrim(original_name)) BETWEEN 1 AND 255),
  mime_type VARCHAR(200) NOT NULL CHECK (length(btrim(mime_type)) BETWEEN 1 AND 200),
  storage_bucket TEXT NOT NULL CHECK (length(storage_bucket) > 0),
  storage_key TEXT NOT NULL CHECK (length(storage_key) > 0),
  storage_version_id TEXT,
  sha256 BYTEA NOT NULL CHECK (octet_length(sha256) = 32),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  scan_status public.portal_inbox_attachment_scan_status NOT NULL DEFAULT 'PENDING',
  decision public.portal_inbox_attachment_decision NOT NULL DEFAULT 'PENDING_REVIEW',
  accepted_document_id UUID UNIQUE REFERENCES public.document(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  decided_by_staff_id UUID REFERENCES public.staff_user(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  decided_at TIMESTAMPTZ(6),
  rejection_reason VARCHAR(500),
  position INTEGER NOT NULL CHECK (position >= 0 AND position < 10),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT portal_inbox_attachment_client_fk
    FOREIGN KEY (tenant_id, client_id)
    REFERENCES public.client(tenant_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT portal_inbox_attachment_batch_fk
    FOREIGN KEY (tenant_id, client_id, batch_id)
    REFERENCES public.portal_inbox_upload_batch(tenant_id, client_id, id)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT portal_inbox_attachment_message_fk
    FOREIGN KEY (tenant_id, client_id, message_id)
    REFERENCES public.portal_inbox_message(tenant_id, client_id, id)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT portal_inbox_attachment_storage_key UNIQUE (storage_bucket, storage_key),
  CONSTRAINT portal_inbox_attachment_batch_position_key UNIQUE (batch_id, position),
  CONSTRAINT portal_inbox_attachment_scan_check CHECK (
    scan_status = 'PENDING' OR storage_version_id IS NOT NULL
  ),
  CONSTRAINT portal_inbox_attachment_decision_check CHECK (
    (
      decision = 'PENDING_REVIEW'
      AND scan_status <> 'BLOCKED'
      AND accepted_document_id IS NULL
      AND decided_by_staff_id IS NULL
      AND decided_at IS NULL
      AND rejection_reason IS NULL
    )
    OR
    (
      decision = 'ACCEPTED'
      AND scan_status = 'CLEAN'
      AND accepted_document_id IS NOT NULL
      AND decided_by_staff_id IS NOT NULL
      AND decided_at IS NOT NULL
      AND rejection_reason IS NULL
    )
    OR
    (
      decision = 'REJECTED'
      AND scan_status = 'CLEAN'
      AND accepted_document_id IS NULL
      AND decided_by_staff_id IS NOT NULL
      AND decided_at IS NOT NULL
      AND length(btrim(rejection_reason)) > 0
    )
    OR
    (
      decision = 'BLOCKED'
      AND scan_status = 'BLOCKED'
      AND accepted_document_id IS NULL
      AND decided_by_staff_id IS NULL
      AND decided_at IS NULL
    )
  )
);
CREATE INDEX portal_inbox_attachment_message_idx
  ON public.portal_inbox_attachment(tenant_id, client_id, message_id, position);
CREATE INDEX portal_inbox_attachment_decision_idx
  ON public.portal_inbox_attachment(tenant_id, decision, created_at);

CREATE TABLE public.portal_inbox_read (
  tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  client_id UUID NOT NULL,
  thread_id UUID NOT NULL,
  contact_id UUID NOT NULL REFERENCES public.client_contact(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  last_read_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (thread_id, contact_id),
  CONSTRAINT portal_inbox_read_client_fk
    FOREIGN KEY (tenant_id, client_id)
    REFERENCES public.client(tenant_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT portal_inbox_read_thread_fk
    FOREIGN KEY (tenant_id, client_id, thread_id)
    REFERENCES public.portal_inbox_thread(tenant_id, client_id, id)
    ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX portal_inbox_read_contact_idx
  ON public.portal_inbox_read(tenant_id, client_id, contact_id, last_read_at);

-- Aktiver Portalzugriff einschließlich opt-in Featureflag und aktuellem
-- Mandatsstatus. Ein fehlender JSON-Key bleibt fail-closed.
CREATE FUNCTION app.portal_inbox_contact_access(p_tenant_id UUID, p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
  SELECT p_tenant_id = app.current_tenant_id()
    AND app.current_actor_type() = 'CLIENT_CONTACT'
    AND EXISTS (
      SELECT 1
      FROM public.client_contact contact
      JOIN public.client client
        ON client.id = contact.client_id
       AND client.tenant_id = contact.tenant_id
      JOIN public.tenant_setting setting
        ON setting.tenant_id = contact.tenant_id
       AND setting.key = 'portal.features'
      WHERE contact.id = app.current_actor_id()
        AND contact.tenant_id = p_tenant_id
        AND contact.client_id = p_client_id
        AND contact.active
        AND client.allow_active
        AND client.mandate_ended_at IS NULL
        AND client.anonymized_at IS NULL
        AND setting.value ->> 'clientInbox' = 'true'
    )
$$;

-- Staffzugriff ist kumulativ: neues Einzelrecht plus der aktuelle Zugriff auf
-- den konkreten Mandanten. ADMIN/PARTNER erfüllen das Einzelrecht implizit.
CREATE FUNCTION app.portal_inbox_staff_access(p_tenant_id UUID, p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
  SELECT p_tenant_id = app.current_tenant_id()
    AND app.current_actor_type() = 'STAFF'
    AND app.expansion_staff_permission(
      p_tenant_id,
      app.current_actor_id(),
      'PORTAL_INBOX_MANAGE'
    )
    AND app.notification_staff_can_access_client(
      p_tenant_id,
      app.current_actor_id(),
      p_client_id
    )
$$;

-- Empfängerprüfung ohne Actor-Gleichheit; ausschließlich intern von Triggern
-- und der write-only Portal-Notification-Funktion verwendet.
CREATE FUNCTION app.portal_inbox_staff_recipient_access(
  p_tenant_id UUID,
  p_staff_id UUID,
  p_client_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
  SELECT p_tenant_id = app.current_tenant_id()
    AND EXISTS (
      SELECT 1
      FROM public.staff_user staff
      JOIN public.client client
        ON client.id = p_client_id
       AND client.tenant_id = p_tenant_id
      WHERE staff.id = p_staff_id
        AND staff.tenant_id = p_tenant_id
        AND staff.active
        AND (
          EXISTS (
            SELECT 1 FROM public.staff_role role
            WHERE role.staff_user_id = staff.id
              AND role.role IN ('ADMIN', 'PARTNER')
          )
          OR EXISTS (
            SELECT 1 FROM public.staff_permission permission
            WHERE permission.staff_user_id = staff.id
              AND permission.permission = 'PORTAL_INBOX_MANAGE'
          )
        )
        AND (
          EXISTS (
            SELECT 1 FROM public.staff_role role
            WHERE role.staff_user_id = staff.id
              AND role.role IN ('ADMIN', 'PARTNER')
          )
          OR (
            client.vertraulich = FALSE
            AND NOT EXISTS (
              SELECT 1 FROM public.tenant_setting setting
              WHERE setting.tenant_id = p_tenant_id
                AND setting.key = 'access'
                AND setting.value ->> 'clientAccessMode' = 'RESTRICTED'
            )
          )
          OR EXISTS (
            SELECT 1 FROM public.client_responsibility responsibility
            WHERE responsibility.tenant_id = p_tenant_id
              AND responsibility.client_id = p_client_id
              AND responsibility.staff_id = staff.id
              AND responsibility.role IN ('BERUFSTRAEGER', 'HAUPTBEARBEITER')
          )
        )
    )
$$;

CREATE FUNCTION app.portal_inbox_owned_open_batch(p_batch_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.portal_inbox_upload_batch batch
    WHERE batch.id = p_batch_id
      AND batch.created_by_contact_id = app.current_actor_id()
      AND batch.status = 'OPEN'
      AND batch.expires_at > CURRENT_TIMESTAMP
      AND app.portal_inbox_contact_access(batch.tenant_id, batch.client_id)
  )
$$;

CREATE FUNCTION app.portal_inbox_attachment_contact_access(p_attachment_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.portal_inbox_attachment attachment
    JOIN public.portal_inbox_upload_batch batch ON batch.id = attachment.batch_id
    WHERE attachment.id = p_attachment_id
      AND batch.tenant_id = attachment.tenant_id
      AND batch.client_id = attachment.client_id
      AND app.portal_inbox_contact_access(attachment.tenant_id, attachment.client_id)
      AND (
        (
          batch.status = 'OPEN'
          AND batch.created_by_contact_id = app.current_actor_id()
        )
        OR (
          batch.status = 'CONSUMED'
          AND attachment.message_id IS NOT NULL
          AND attachment.scan_status = 'CLEAN'
          AND attachment.decision IN ('PENDING_REVIEW', 'ACCEPTED')
        )
      )
  )
$$;

REVOKE ALL ON FUNCTION app.portal_inbox_contact_access(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.portal_inbox_staff_access(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.portal_inbox_staff_recipient_access(UUID, UUID, UUID) FROM PUBLIC, taxtronik_app;
REVOKE ALL ON FUNCTION app.portal_inbox_owned_open_batch(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.portal_inbox_attachment_contact_access(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.portal_inbox_contact_access(UUID, UUID) TO taxtronik_app;
GRANT EXECUTE ON FUNCTION app.portal_inbox_staff_access(UUID, UUID) TO taxtronik_app;
GRANT EXECUTE ON FUNCTION app.portal_inbox_owned_open_batch(UUID) TO taxtronik_app;
GRANT EXECUTE ON FUNCTION app.portal_inbox_attachment_contact_access(UUID) TO taxtronik_app;

-- Parent-/Akteur-/Storage-/Statusinvarianten gelten auch für Ownerpfade und
-- werden deshalb zusätzlich zur RLS durch Trigger erzwungen.
CREATE FUNCTION app.portal_inbox_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
DECLARE
  batch_row public.portal_inbox_upload_batch;
  message_row public.portal_inbox_message;
  attachment_count INTEGER;
  attachment_size BIGINT;
  message_count INTEGER;
  calculated_manifest BYTEA;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.client client
    WHERE client.id = NEW.client_id AND client.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Portal-Inbox-Mandant gehört nicht zum Tenant-Scope'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_TABLE_NAME = 'portal_inbox_thread' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.client_contact contact
      WHERE contact.id = NEW.created_by_contact_id
        AND contact.tenant_id = NEW.tenant_id
        AND contact.client_id = NEW.client_id
    ) THEN
      RAISE EXCEPTION 'Thread-Ersteller gehört nicht zum Mandanten';
    END IF;
    IF NEW.assigned_staff_id IS NOT NULL
       AND NOT app.portal_inbox_staff_recipient_access(
         NEW.tenant_id, NEW.assigned_staff_id, NEW.client_id
       ) THEN
      RAISE EXCEPTION 'Thread-Zuweisung vermittelt keinen Inbox-/Mandantenzugriff';
    END IF;
    IF NEW.resolved_by_staff_id IS NOT NULL
       AND NOT app.portal_inbox_staff_recipient_access(
         NEW.tenant_id, NEW.resolved_by_staff_id, NEW.client_id
       ) THEN
      RAISE EXCEPTION 'Thread-Abschluss gehört nicht zu berechtigtem Staff';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF app.current_actor_type() = 'CLIENT_CONTACT' AND (
        NEW.created_by_contact_id IS DISTINCT FROM app.current_actor_id()
        OR NEW.status <> 'OPEN'
        OR NEW.attention <> 'STAFF'
        OR NEW.assigned_staff_id IS NOT NULL
        OR NEW.resolved_at IS NOT NULL
        OR NEW.resolved_by_staff_id IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'Portal-Kontakt darf nur einen eigenen offenen Thread erzeugen';
      ELSIF app.current_actor_type() = 'STAFF' THEN
        RAISE EXCEPTION 'Neue Portal-Inbox-Threads werden mandantenseitig initiiert';
      END IF;
    ELSE
      IF ROW(NEW.id, NEW.tenant_id, NEW.client_id, NEW.created_by_contact_id, NEW.created_at)
         IS DISTINCT FROM
         ROW(OLD.id, OLD.tenant_id, OLD.client_id, OLD.created_by_contact_id, OLD.created_at) THEN
        RAISE EXCEPTION 'Portal-Inbox-Thread-Scope ist unveränderlich';
      END IF;
      IF NEW.last_message_at < OLD.last_message_at THEN
        RAISE EXCEPTION 'Thread-Zeit darf nicht zurückgesetzt werden';
      END IF;
      IF app.current_actor_type() = 'CLIENT_CONTACT' AND (
        ROW(NEW.subject, NEW.topic, NEW.status, NEW.assigned_staff_id,
            NEW.resolved_at, NEW.resolved_by_staff_id)
        IS DISTINCT FROM
        ROW(OLD.subject, OLD.topic, OLD.status, OLD.assigned_staff_id,
            OLD.resolved_at, OLD.resolved_by_staff_id)
        OR NEW.attention <> 'STAFF'
      ) THEN
        RAISE EXCEPTION 'Portal-Kontakt darf Thread-Metadaten nicht umdeuten';
      END IF;
      IF app.current_actor_type() = 'STAFF'
         AND NOT app.portal_inbox_staff_access(NEW.tenant_id, NEW.client_id) THEN
        RAISE EXCEPTION 'Portal-Inbox-Recht und Mandantenzugriff erforderlich';
      END IF;
      IF app.current_actor_type() = 'STAFF'
         AND NEW.status = 'RESOLVED'
         AND OLD.status <> 'RESOLVED'
         AND NEW.resolved_by_staff_id IS DISTINCT FROM app.current_actor_id() THEN
        RAISE EXCEPTION 'Thread-Abschluss muss dem handelnden Staff zugeordnet sein';
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'portal_inbox_message' THEN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION 'Abgesendete Portal-Inbox-Nachrichten sind unveränderlich';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.portal_inbox_thread thread
      WHERE thread.id = NEW.thread_id
        AND thread.tenant_id = NEW.tenant_id
        AND thread.client_id = NEW.client_id
        AND thread.status = 'OPEN'
    ) THEN
      RAISE EXCEPTION 'Nachricht benötigt einen offenen Thread desselben Scope';
    END IF;
    IF NEW.author_type = 'CLIENT_CONTACT' THEN
      IF app.current_actor_type() <> 'CLIENT_CONTACT'
         OR NEW.author_id IS DISTINCT FROM app.current_actor_id()
         OR NOT app.portal_inbox_contact_access(NEW.tenant_id, NEW.client_id) THEN
        RAISE EXCEPTION 'Portal-Nachrichtenautor stimmt nicht mit der aktiven Session überein';
      END IF;
    ELSIF NEW.author_type = 'STAFF' THEN
      IF app.current_actor_type() <> 'STAFF'
         OR NEW.author_id IS DISTINCT FROM app.current_actor_id()
         OR NOT app.portal_inbox_staff_access(NEW.tenant_id, NEW.client_id) THEN
        RAISE EXCEPTION 'Staff-Nachricht benötigt aktuelles Inbox-Recht und Mandantenzugriff';
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'portal_inbox_upload_batch' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.client_contact contact
      WHERE contact.id = NEW.created_by_contact_id
        AND contact.tenant_id = NEW.tenant_id
        AND contact.client_id = NEW.client_id
    ) THEN
      RAISE EXCEPTION 'Upload-Batch-Ersteller gehört nicht zum Mandanten';
    END IF;
    IF NEW.target_thread_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.portal_inbox_thread thread
      WHERE thread.id = NEW.target_thread_id
        AND thread.tenant_id = NEW.tenant_id
        AND thread.client_id = NEW.client_id
        AND thread.status = 'OPEN'
    ) THEN
      RAISE EXCEPTION 'Antwort-Batch benötigt einen offenen Zielthread';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF app.current_actor_type() <> 'CLIENT_CONTACT'
         OR NEW.created_by_contact_id IS DISTINCT FROM app.current_actor_id()
         OR NOT app.portal_inbox_contact_access(NEW.tenant_id, NEW.client_id)
         OR NEW.status <> 'OPEN'
         OR NEW.expires_at > CURRENT_TIMESTAMP + INTERVAL '24 hours' THEN
        RAISE EXCEPTION 'Nur ein aktiver Portal-Kontakt darf einen eigenen 24h-Batch erzeugen';
      END IF;
    ELSE
      IF ROW(NEW.id, NEW.tenant_id, NEW.client_id, NEW.created_by_contact_id,
             NEW.purpose, NEW.target_thread_id, NEW.expires_at, NEW.created_at)
         IS DISTINCT FROM
         ROW(OLD.id, OLD.tenant_id, OLD.client_id, OLD.created_by_contact_id,
             OLD.purpose, OLD.target_thread_id, OLD.expires_at, OLD.created_at) THEN
        RAISE EXCEPTION 'Upload-Batch-Scope und Frist sind unveränderlich';
      END IF;
      IF OLD.status <> 'OPEN' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Terminaler Upload-Batch ist unveränderlich';
      END IF;
      IF app.current_actor_type() = 'CLIENT_CONTACT' THEN
        IF NEW.created_by_contact_id IS DISTINCT FROM app.current_actor_id()
           OR NOT app.portal_inbox_contact_access(NEW.tenant_id, NEW.client_id)
           OR NEW.status NOT IN ('OPEN', 'CONSUMED', 'DISCARDED') THEN
          RAISE EXCEPTION 'Portal-Kontakt darf nur eigenen offenen Batch finalisieren oder verwerfen';
        END IF;
      ELSIF app.current_actor_type() = 'SYSTEM' THEN
        IF NEW.status NOT IN ('OPEN', 'EXPIRED') THEN
          RAISE EXCEPTION 'Systempfad darf nur offene Batches ablaufen lassen';
        END IF;
      ELSE
        RAISE EXCEPTION 'Upload-Batch-Status ist nicht staffseitig änderbar';
      END IF;

      IF NEW.status = 'CONSUMED' AND OLD.status = 'OPEN' THEN
        SELECT count(*), COALESCE(sum(attachment.size_bytes), 0),
               count(DISTINCT attachment.message_id),
               public.digest(
                 string_agg(
                   attachment.position::TEXT || ':' || encode(attachment.sha256, 'hex') || ':'
                   || attachment.size_bytes::TEXT || ':'
                   || replace(encode(convert_to(attachment.mime_type, 'UTF8'), 'base64'), E'\n', '') || ':'
                   || replace(encode(convert_to(attachment.original_name, 'UTF8'), 'base64'), E'\n', ''),
                   E'\n' ORDER BY attachment.position
                 ),
                 'sha256'
               )
          INTO attachment_count, attachment_size, message_count, calculated_manifest
          FROM public.portal_inbox_attachment attachment
         WHERE attachment.batch_id = NEW.id;
        IF attachment_count < 1 OR attachment_count > 10
           OR attachment_size > 104857600
           OR message_count <> 1
           OR EXISTS (
             SELECT 1 FROM public.portal_inbox_attachment attachment
             WHERE attachment.batch_id = NEW.id
               AND (
                 attachment.message_id IS NULL
                 OR attachment.storage_version_id IS NULL
                 OR attachment.scan_status <> 'CLEAN'
                 OR attachment.decision <> 'PENDING_REVIEW'
               )
           )
           OR NEW.manifest_sha256 IS DISTINCT FROM calculated_manifest THEN
          RAISE EXCEPTION 'Batch-Manifest ist unvollständig, ungeprüft oder nicht hashgebunden';
        END IF;
        IF NEW.purpose = 'REPLY' AND EXISTS (
          SELECT 1 FROM public.portal_inbox_attachment attachment
          JOIN public.portal_inbox_message message ON message.id = attachment.message_id
          WHERE attachment.batch_id = NEW.id
            AND message.thread_id IS DISTINCT FROM NEW.target_thread_id
        ) THEN
          RAISE EXCEPTION 'Antwort-Batch wurde an einen anderen Thread gebunden';
        END IF;
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'portal_inbox_attachment' THEN
    SELECT * INTO batch_row
      FROM public.portal_inbox_upload_batch batch
     WHERE batch.id = NEW.batch_id
       AND batch.tenant_id = NEW.tenant_id
       AND batch.client_id = NEW.client_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Anhang benötigt einen Batch desselben Scope';
    END IF;
    IF NEW.storage_key NOT LIKE 'tenants/' || NEW.tenant_id::TEXT || '/%' THEN
      RAISE EXCEPTION 'Staging-Key liegt nicht im Tenant-Präfix';
    END IF;

    IF TG_OP = 'INSERT' THEN
      IF batch_row.status <> 'OPEN' OR batch_row.expires_at <= CURRENT_TIMESTAMP THEN
        RAISE EXCEPTION 'Anhang benötigt einen aktiven offenen Batch';
      END IF;
      IF app.current_actor_type() <> 'CLIENT_CONTACT'
         OR batch_row.created_by_contact_id IS DISTINCT FROM app.current_actor_id()
         OR NOT app.portal_inbox_contact_access(NEW.tenant_id, NEW.client_id)
         OR NEW.scan_status <> 'PENDING'
         OR NEW.storage_version_id IS NOT NULL
         OR NEW.decision <> 'PENDING_REVIEW'
         OR NEW.message_id IS NOT NULL
         OR NEW.accepted_document_id IS NOT NULL THEN
        RAISE EXCEPTION 'Anhang muss als eigener PENDING-Staging-Intent beginnen';
      END IF;
      SELECT count(*), COALESCE(sum(attachment.size_bytes), 0)
        INTO attachment_count, attachment_size
        FROM public.portal_inbox_attachment attachment
       WHERE attachment.batch_id = NEW.batch_id;
      IF attachment_count >= 10 OR attachment_size + NEW.size_bytes > 104857600 THEN
        RAISE EXCEPTION 'Upload-Batch überschreitet Datei- oder Größenlimit';
      END IF;
    ELSE
      IF ROW(NEW.id, NEW.tenant_id, NEW.client_id, NEW.batch_id,
             NEW.original_name, NEW.mime_type, NEW.storage_bucket,
             NEW.storage_key, NEW.sha256, NEW.size_bytes, NEW.position,
             NEW.created_at)
         IS DISTINCT FROM
         ROW(OLD.id, OLD.tenant_id, OLD.client_id, OLD.batch_id,
             OLD.original_name, OLD.mime_type, OLD.storage_bucket,
             OLD.storage_key, OLD.sha256, OLD.size_bytes, OLD.position,
             OLD.created_at) THEN
        RAISE EXCEPTION 'Staging- und Byteidentität des Anhangs ist unveränderlich';
      END IF;
      IF OLD.message_id IS NOT NULL AND NEW.message_id IS DISTINCT FROM OLD.message_id THEN
        RAISE EXCEPTION 'Nachrichtenbindung des Anhangs ist unveränderlich';
      END IF;
      IF OLD.decision <> 'PENDING_REVIEW' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Getroffene Anhangsentscheidung ist unveränderlich';
      END IF;

      IF app.current_actor_type() = 'CLIENT_CONTACT' THEN
        IF batch_row.status <> 'OPEN'
           OR batch_row.expires_at <= CURRENT_TIMESTAMP
           OR batch_row.created_by_contact_id IS DISTINCT FROM app.current_actor_id()
           OR NOT app.portal_inbox_contact_access(NEW.tenant_id, NEW.client_id)
           OR NEW.accepted_document_id IS DISTINCT FROM OLD.accepted_document_id
           OR NEW.decided_by_staff_id IS DISTINCT FROM OLD.decided_by_staff_id
           OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
           OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason THEN
          RAISE EXCEPTION 'Portal-Kontakt darf nur seinen offenen Staging-Anhang finalisieren oder binden';
        END IF;
        IF OLD.scan_status <> 'PENDING'
           AND ROW(NEW.scan_status, NEW.storage_version_id, NEW.decision)
             IS DISTINCT FROM ROW(OLD.scan_status, OLD.storage_version_id, OLD.decision) THEN
          RAISE EXCEPTION 'Scannergebnis ist terminal';
        END IF;
        IF OLD.scan_status = 'PENDING'
           AND NEW.scan_status NOT IN ('PENDING', 'CLEAN', 'BLOCKED') THEN
          RAISE EXCEPTION 'Unzulässiger Scanübergang';
        END IF;
        IF NEW.scan_status = 'BLOCKED' THEN
          NEW.decision := 'BLOCKED';
        ELSIF NEW.decision <> 'PENDING_REVIEW' THEN
          RAISE EXCEPTION 'Portal-Kontakt trifft keine Kanzleientscheidung';
        END IF;
        IF NEW.message_id IS NOT NULL AND OLD.message_id IS NULL THEN
          IF NEW.scan_status <> 'CLEAN' OR NEW.storage_version_id IS NULL THEN
            RAISE EXCEPTION 'Nur sauber abgeschlossene Anhänge dürfen abgesendet werden';
          END IF;
          SELECT * INTO message_row
            FROM public.portal_inbox_message message
           WHERE message.id = NEW.message_id
             AND message.tenant_id = NEW.tenant_id
             AND message.client_id = NEW.client_id;
          IF NOT FOUND OR message_row.author_type <> 'CLIENT_CONTACT'
             OR message_row.author_id IS DISTINCT FROM app.current_actor_id()
             OR (batch_row.purpose = 'REPLY'
                 AND message_row.thread_id IS DISTINCT FROM batch_row.target_thread_id) THEN
            RAISE EXCEPTION 'Anhang darf nur an die eigene passende Nachricht gebunden werden';
          END IF;
        END IF;
      ELSIF app.current_actor_type() = 'STAFF' THEN
        IF NOT app.portal_inbox_staff_access(NEW.tenant_id, NEW.client_id)
           OR batch_row.status <> 'CONSUMED'
           OR NEW.message_id IS NULL
           OR NEW.scan_status IS DISTINCT FROM OLD.scan_status
           OR NEW.storage_version_id IS DISTINCT FROM OLD.storage_version_id
           OR NEW.message_id IS DISTINCT FROM OLD.message_id
           OR NEW.decision NOT IN ('ACCEPTED', 'REJECTED')
           OR NEW.decided_by_staff_id IS DISTINCT FROM app.current_actor_id()
           OR NEW.decided_at IS NULL THEN
          RAISE EXCEPTION 'Staff-Entscheidung benötigt aktuellen Scope und vollständige Provenienz';
        END IF;
      ELSIF app.current_actor_type() = 'SYSTEM' THEN
        IF OLD.scan_status <> 'PENDING'
           OR NEW.scan_status NOT IN ('CLEAN', 'BLOCKED')
           OR NEW.message_id IS DISTINCT FROM OLD.message_id
           OR NEW.accepted_document_id IS DISTINCT FROM OLD.accepted_document_id
           OR NEW.decided_by_staff_id IS DISTINCT FROM OLD.decided_by_staff_id
           OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
          RAISE EXCEPTION 'Systempfad darf nur ein offenes Scannergebnis abschließen';
        END IF;
        IF NEW.scan_status = 'BLOCKED' THEN NEW.decision := 'BLOCKED'; END IF;
      ELSE
        RAISE EXCEPTION 'Unzulässiger Akteur für Portal-Inbox-Anhang';
      END IF;

      IF NEW.decision = 'ACCEPTED' AND NOT EXISTS (
        SELECT 1
        FROM public.document document
        JOIN public.document_version version ON version.document_id = document.id
        WHERE document.id = NEW.accepted_document_id
          AND document.tenant_id = NEW.tenant_id
          AND document.client_id = NEW.client_id
          AND document.deleted_at IS NULL
          AND document.shared_with_client_at IS NULL
          AND version.sha256 = NEW.sha256
          AND version.scan_status = 'CLEAN'
      ) THEN
        RAISE EXCEPTION 'Angenommenes Archivdokument stimmt nicht mit sauberem Staging-Original überein';
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'portal_inbox_read' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.client_contact contact
      WHERE contact.id = NEW.contact_id
        AND contact.tenant_id = NEW.tenant_id
        AND contact.client_id = NEW.client_id
    ) OR NOT EXISTS (
      SELECT 1 FROM public.portal_inbox_thread thread
      WHERE thread.id = NEW.thread_id
        AND thread.tenant_id = NEW.tenant_id
        AND thread.client_id = NEW.client_id
    ) THEN
      RAISE EXCEPTION 'Lesestand gehört nicht zu Kontakt und Thread desselben Scope';
    END IF;
    IF app.current_actor_type() = 'CLIENT_CONTACT'
       AND (NEW.contact_id IS DISTINCT FROM app.current_actor_id()
            OR NOT app.portal_inbox_contact_access(NEW.tenant_id, NEW.client_id)) THEN
      RAISE EXCEPTION 'Portal-Kontakt darf nur eigenen Lesestand schreiben';
    END IF;
    IF TG_OP = 'UPDATE' AND (
      ROW(NEW.tenant_id, NEW.client_id, NEW.thread_id, NEW.contact_id)
        IS DISTINCT FROM ROW(OLD.tenant_id, OLD.client_id, OLD.thread_id, OLD.contact_id)
      OR NEW.last_read_at < OLD.last_read_at
    ) THEN
      RAISE EXCEPTION 'Lesestand-Scope ist unveränderlich und monoton';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER portal_inbox_thread_guard
  BEFORE INSERT OR UPDATE ON public.portal_inbox_thread
  FOR EACH ROW EXECUTE FUNCTION app.portal_inbox_guard();
CREATE TRIGGER portal_inbox_message_guard
  BEFORE INSERT OR UPDATE ON public.portal_inbox_message
  FOR EACH ROW EXECUTE FUNCTION app.portal_inbox_guard();
CREATE TRIGGER portal_inbox_upload_batch_guard
  BEFORE INSERT OR UPDATE ON public.portal_inbox_upload_batch
  FOR EACH ROW EXECUTE FUNCTION app.portal_inbox_guard();
CREATE TRIGGER portal_inbox_attachment_guard
  BEFORE INSERT OR UPDATE ON public.portal_inbox_attachment
  FOR EACH ROW EXECUTE FUNCTION app.portal_inbox_guard();
CREATE TRIGGER portal_inbox_read_guard
  BEFORE INSERT OR UPDATE ON public.portal_inbox_read
  FOR EACH ROW EXECUTE FUNCTION app.portal_inbox_guard();

CREATE TRIGGER "00_tenant_client_pair_integrity"
  BEFORE INSERT OR UPDATE OF tenant_id, client_id ON public.portal_inbox_thread
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_client_pair_integrity();
CREATE TRIGGER "00_tenant_client_pair_integrity"
  BEFORE INSERT OR UPDATE OF tenant_id, client_id ON public.portal_inbox_message
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_client_pair_integrity();
CREATE TRIGGER "00_tenant_client_pair_integrity"
  BEFORE INSERT OR UPDATE OF tenant_id, client_id ON public.portal_inbox_upload_batch
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_client_pair_integrity();
CREATE TRIGGER "00_tenant_client_pair_integrity"
  BEFORE INSERT OR UPDATE OF tenant_id, client_id ON public.portal_inbox_attachment
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_client_pair_integrity();
CREATE TRIGGER "00_tenant_client_pair_integrity"
  BEFORE INSERT OR UPDATE OF tenant_id, client_id ON public.portal_inbox_read
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_client_pair_integrity();

-- Nachrichteneingang aktualisiert die Threadprojektion; der Nachrichtentext
-- wird weder in einen Suchindex noch in eine Notification kopiert.
CREATE FUNCTION app.portal_inbox_touch_thread()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
BEGIN
  UPDATE public.portal_inbox_thread
     SET last_message_at = NEW.created_at,
         attention = CASE
           WHEN NEW.author_type = 'CLIENT_CONTACT' THEN 'STAFF'::public.portal_inbox_attention
           ELSE 'CLIENT'::public.portal_inbox_attention
         END,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = NEW.thread_id
     AND tenant_id = NEW.tenant_id
     AND client_id = NEW.client_id
     AND status = 'OPEN';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Offener Thread für Nachricht nicht mehr vorhanden';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portal_inbox_message_touch_thread
  AFTER INSERT ON public.portal_inbox_message
  FOR EACH ROW EXECUTE FUNCTION app.portal_inbox_touch_thread();

REVOKE ALL ON FUNCTION app.portal_inbox_guard() FROM PUBLIC, taxtronik_app;
REVOKE ALL ON FUNCTION app.portal_inbox_touch_thread() FROM PUBLIC, taxtronik_app;

-- RLS: SYSTEM bleibt tenantgebunden. Staff benötigt immer Einzelrecht plus
-- aktuellen Mandantenzugriff. Portal-Entwürfe sind kontaktprivat; abgesendete
-- Threads und saubere, nicht abgelehnte Anhänge sind mandantenweit sichtbar.
ALTER TABLE public.portal_inbox_thread ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_inbox_thread FORCE ROW LEVEL SECURITY;
ALTER TABLE public.portal_inbox_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_inbox_message FORCE ROW LEVEL SECURITY;
ALTER TABLE public.portal_inbox_upload_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_inbox_upload_batch FORCE ROW LEVEL SECURITY;
ALTER TABLE public.portal_inbox_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_inbox_attachment FORCE ROW LEVEL SECURITY;
ALTER TABLE public.portal_inbox_read ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_inbox_read FORCE ROW LEVEL SECURITY;

CREATE POLICY portal_inbox_thread_system ON public.portal_inbox_thread
  FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.current_actor_type() = 'SYSTEM')
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.current_actor_type() = 'SYSTEM');
CREATE POLICY portal_inbox_thread_staff_select ON public.portal_inbox_thread
  FOR SELECT USING (app.portal_inbox_staff_access(tenant_id, client_id));
CREATE POLICY portal_inbox_thread_staff_update ON public.portal_inbox_thread
  FOR UPDATE
  USING (app.portal_inbox_staff_access(tenant_id, client_id))
  WITH CHECK (app.portal_inbox_staff_access(tenant_id, client_id));
CREATE POLICY portal_inbox_thread_contact_select ON public.portal_inbox_thread
  FOR SELECT USING (app.portal_inbox_contact_access(tenant_id, client_id));
CREATE POLICY portal_inbox_thread_contact_insert ON public.portal_inbox_thread
  FOR INSERT WITH CHECK (
    created_by_contact_id = app.current_actor_id()
    AND app.portal_inbox_contact_access(tenant_id, client_id)
  );

CREATE POLICY portal_inbox_message_system ON public.portal_inbox_message
  FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.current_actor_type() = 'SYSTEM')
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.current_actor_type() = 'SYSTEM');
CREATE POLICY portal_inbox_message_staff_select ON public.portal_inbox_message
  FOR SELECT USING (app.portal_inbox_staff_access(tenant_id, client_id));
CREATE POLICY portal_inbox_message_staff_insert ON public.portal_inbox_message
  FOR INSERT WITH CHECK (
    author_type = 'STAFF' AND author_id = app.current_actor_id()
    AND app.portal_inbox_staff_access(tenant_id, client_id)
  );
CREATE POLICY portal_inbox_message_contact_select ON public.portal_inbox_message
  FOR SELECT USING (app.portal_inbox_contact_access(tenant_id, client_id));
CREATE POLICY portal_inbox_message_contact_insert ON public.portal_inbox_message
  FOR INSERT WITH CHECK (
    author_type = 'CLIENT_CONTACT' AND author_id = app.current_actor_id()
    AND app.portal_inbox_contact_access(tenant_id, client_id)
  );

CREATE POLICY portal_inbox_batch_system ON public.portal_inbox_upload_batch
  FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.current_actor_type() = 'SYSTEM')
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.current_actor_type() = 'SYSTEM');
CREATE POLICY portal_inbox_batch_staff_select ON public.portal_inbox_upload_batch
  FOR SELECT USING (app.portal_inbox_staff_access(tenant_id, client_id));
CREATE POLICY portal_inbox_batch_contact_select ON public.portal_inbox_upload_batch
  FOR SELECT USING (
    created_by_contact_id = app.current_actor_id()
    AND app.portal_inbox_contact_access(tenant_id, client_id)
  );
CREATE POLICY portal_inbox_batch_contact_insert ON public.portal_inbox_upload_batch
  FOR INSERT WITH CHECK (
    created_by_contact_id = app.current_actor_id()
    AND status = 'OPEN'
    AND app.portal_inbox_contact_access(tenant_id, client_id)
  );
CREATE POLICY portal_inbox_batch_contact_update ON public.portal_inbox_upload_batch
  FOR UPDATE
  USING (
    created_by_contact_id = app.current_actor_id()
    AND status = 'OPEN'
    AND app.portal_inbox_contact_access(tenant_id, client_id)
  )
  WITH CHECK (
    created_by_contact_id = app.current_actor_id()
    AND app.portal_inbox_contact_access(tenant_id, client_id)
  );

CREATE POLICY portal_inbox_attachment_system ON public.portal_inbox_attachment
  FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.current_actor_type() = 'SYSTEM')
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.current_actor_type() = 'SYSTEM');
CREATE POLICY portal_inbox_attachment_staff_select ON public.portal_inbox_attachment
  FOR SELECT USING (app.portal_inbox_staff_access(tenant_id, client_id));
CREATE POLICY portal_inbox_attachment_staff_update ON public.portal_inbox_attachment
  FOR UPDATE
  USING (app.portal_inbox_staff_access(tenant_id, client_id))
  WITH CHECK (app.portal_inbox_staff_access(tenant_id, client_id));
CREATE POLICY portal_inbox_attachment_contact_select ON public.portal_inbox_attachment
  FOR SELECT USING (app.portal_inbox_attachment_contact_access(id));
CREATE POLICY portal_inbox_attachment_contact_insert ON public.portal_inbox_attachment
  FOR INSERT WITH CHECK (app.portal_inbox_owned_open_batch(batch_id));
CREATE POLICY portal_inbox_attachment_contact_update ON public.portal_inbox_attachment
  FOR UPDATE
  USING (app.portal_inbox_owned_open_batch(batch_id))
  WITH CHECK (app.portal_inbox_owned_open_batch(batch_id));

CREATE POLICY portal_inbox_read_system ON public.portal_inbox_read
  FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.current_actor_type() = 'SYSTEM')
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.current_actor_type() = 'SYSTEM');
CREATE POLICY portal_inbox_read_staff_select ON public.portal_inbox_read
  FOR SELECT USING (app.portal_inbox_staff_access(tenant_id, client_id));
CREATE POLICY portal_inbox_read_contact_select ON public.portal_inbox_read
  FOR SELECT USING (
    contact_id = app.current_actor_id()
    AND app.portal_inbox_contact_access(tenant_id, client_id)
  );
CREATE POLICY portal_inbox_read_contact_insert ON public.portal_inbox_read
  FOR INSERT WITH CHECK (
    contact_id = app.current_actor_id()
    AND app.portal_inbox_contact_access(tenant_id, client_id)
  );
CREATE POLICY portal_inbox_read_contact_update ON public.portal_inbox_read
  FOR UPDATE
  USING (
    contact_id = app.current_actor_id()
    AND app.portal_inbox_contact_access(tenant_id, client_id)
  )
  WITH CHECK (
    contact_id = app.current_actor_id()
    AND app.portal_inbox_contact_access(tenant_id, client_id)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.portal_inbox_thread TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portal_inbox_message TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portal_inbox_upload_batch TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portal_inbox_attachment TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portal_inbox_read TO taxtronik_app;

COMMIT;
