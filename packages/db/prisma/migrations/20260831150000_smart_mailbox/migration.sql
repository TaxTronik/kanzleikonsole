-- MAIL-INBOX-001: untrusted messages never constitute authenticated portal replies.
CREATE TABLE inbound_mailbox (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 claimed_until TIMESTAMP(3), name TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'IMAP' CHECK(provider IN ('IMAP','MICROSOFT365')),
 host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 993, username TEXT NOT NULL, folder TEXT NOT NULL DEFAULT 'INBOX',
 secret_enc TEXT, entra_tenant_id TEXT, entra_client_id TEXT, oauth_cache_enc TEXT, uid_validity TEXT,
 last_uid INTEGER NOT NULL DEFAULT 0, enabled BOOLEAN NOT NULL DEFAULT FALSE, last_success_at TIMESTAMP(3), last_error TEXT,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL
);
CREATE INDEX inbound_mailbox_tenant_id_idx ON inbound_mailbox(tenant_id);
CREATE TABLE inbound_message (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), mailbox_id UUID NOT NULL REFERENCES inbound_mailbox(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 uid_validity TEXT NOT NULL, uid INTEGER NOT NULL, subject TEXT NOT NULL DEFAULT '', sender TEXT NOT NULL DEFAULT '', recipients TEXT NOT NULL DEFAULT '',
 body_text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'PENDING', received_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX inbound_message_mailbox_id_uid_validity_uid_key ON inbound_message(mailbox_id,uid_validity,uid);
CREATE TABLE inbound_attachment (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), message_id UUID NOT NULL REFERENCES inbound_message(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 part INTEGER NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING', storage_key TEXT, document_id UUID, client_id UUID, error TEXT,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX inbound_attachment_message_id_part_key ON inbound_attachment(message_id,part);
CREATE FUNCTION app.expansion_staff_permission(tid UUID, sid UUID, wanted TEXT) RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT tid=app.current_tenant_id() AND sid=app.current_actor_id() AND app.current_actor_type()='STAFF'
 AND EXISTS(SELECT 1 FROM public.staff_user s WHERE s.id=sid AND s.tenant_id=tid AND s.active AND (
 EXISTS(SELECT 1 FROM public.staff_role r WHERE r.staff_user_id=sid AND r.role::text IN ('ADMIN','PARTNER'))
 OR EXISTS(SELECT 1 FROM public.staff_permission p WHERE p.staff_user_id=sid AND p.permission::text=wanted)))
$$;
REVOKE ALL ON FUNCTION app.expansion_staff_permission(UUID,UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expansion_staff_permission(UUID,UUID,TEXT) TO taxtronik_app;
ALTER TABLE inbound_mailbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_mailbox FORCE ROW LEVEL SECURITY;
CREATE POLICY inbound_mailbox_access ON inbound_mailbox USING(tenant_id=app.current_tenant_id() AND (app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND app.expansion_staff_permission(tenant_id,app.current_actor_id(),'INBOUND_MAIL_MANAGE')))) WITH CHECK(tenant_id=app.current_tenant_id() AND (app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND app.expansion_staff_permission(tenant_id,app.current_actor_id(),'INBOUND_MAIL_MANAGE'))));
ALTER TABLE inbound_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_message FORCE ROW LEVEL SECURITY;
CREATE POLICY inbound_message_access ON inbound_message USING(EXISTS(SELECT 1 FROM inbound_mailbox m WHERE m.id=mailbox_id)) WITH CHECK(EXISTS(SELECT 1 FROM inbound_mailbox m WHERE m.id=mailbox_id));
ALTER TABLE inbound_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY inbound_attachment_access ON inbound_attachment USING(EXISTS(SELECT 1 FROM inbound_message m WHERE m.id=message_id)) WITH CHECK(EXISTS(SELECT 1 FROM inbound_message m WHERE m.id=message_id));
GRANT SELECT,INSERT,UPDATE ON inbound_mailbox,inbound_message,inbound_attachment TO taxtronik_app;
-- MAIL-INBOX-001: immutable transport identity; only the scanner worker may
-- mark staged files clean. Staff may bind a clean file once to an archive.
CREATE FUNCTION app.guard_inbound_attachment() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.message_id,NEW.part,NEW.sha256,NEW.size_bytes,NEW.mime_type,NEW.filename) IS DISTINCT FROM (OLD.message_id,OLD.part,OLD.sha256,OLD.size_bytes,OLD.mime_type,OLD.filename) THEN RAISE EXCEPTION 'immutable inbound bytes'; END IF;
 IF app.current_actor_type()='STAFF' THEN
  IF TG_OP='INSERT' OR OLD.status NOT IN ('CLEAN','IMPORTING','IMPORTED') OR NEW.status NOT IN ('IMPORTING','IMPORTED') THEN RAISE EXCEPTION 'scanner release required'; END IF;
  IF NEW.storage_key IS DISTINCT FROM OLD.storage_key THEN RAISE EXCEPTION 'immutable staging source'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.document_id IS NOT NULL AND (NEW.document_id,NEW.client_id) IS DISTINCT FROM (OLD.document_id,OLD.client_id) THEN RAISE EXCEPTION 'archive assignment already bound'; END IF;
 IF NEW.document_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.document d JOIN public.inbound_message m ON m.id=NEW.message_id JOIN public.inbound_mailbox b ON b.id=m.mailbox_id WHERE d.id=NEW.document_id AND d.client_id=NEW.client_id AND d.tenant_id=b.tenant_id) THEN RAISE EXCEPTION 'archive tenant/client mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inbound_attachment_guard BEFORE INSERT OR UPDATE ON inbound_attachment FOR EACH ROW EXECUTE FUNCTION app.guard_inbound_attachment();
CREATE FUNCTION app.inbound_message_staff_visible(tid UUID,sid UUID,mid UUID) RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT app.expansion_staff_permission(tid,sid,'INBOUND_MAIL_MANAGE')
 AND EXISTS(SELECT 1 FROM public.inbound_message m JOIN public.inbound_mailbox b ON b.id=m.mailbox_id WHERE m.id=mid AND b.tenant_id=tid)
 AND NOT EXISTS(SELECT 1 FROM public.inbound_attachment a WHERE a.message_id=mid AND a.client_id IS NOT NULL AND NOT app.notification_staff_can_access_client(tid,sid,a.client_id))
$$;
REVOKE ALL ON FUNCTION app.inbound_message_staff_visible(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.inbound_message_staff_visible(UUID,UUID,UUID) TO taxtronik_app;
DROP POLICY inbound_message_access ON inbound_message;
CREATE POLICY inbound_message_access ON inbound_message USING(EXISTS(SELECT 1 FROM inbound_mailbox b WHERE b.id=mailbox_id) AND (app.current_actor_type()='SYSTEM' OR app.inbound_message_staff_visible(app.current_tenant_id(),app.current_actor_id(),id))) WITH CHECK(app.current_actor_type()='SYSTEM' AND EXISTS(SELECT 1 FROM inbound_mailbox b WHERE b.id=mailbox_id));
CREATE FUNCTION app.guard_inbound_mailbox() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF app.current_actor_type()='STAFF' AND NOT EXISTS(SELECT 1 FROM public.staff_role r JOIN public.staff_user s ON s.id=r.staff_user_id WHERE s.id=app.current_actor_id() AND s.tenant_id=NEW.tenant_id AND s.active AND r.role IN ('ADMIN','PARTNER')) THEN RAISE EXCEPTION 'mailbox administration required'; END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.provider,NEW.host,NEW.port,NEW.username,NEW.folder,NEW.entra_tenant_id,NEW.entra_client_id) IS DISTINCT FROM (OLD.tenant_id,OLD.provider,OLD.host,OLD.port,OLD.username,OLD.folder,OLD.entra_tenant_id,OLD.entra_client_id) THEN RAISE EXCEPTION 'mailbox identity is immutable; create a new profile'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inbound_mailbox_guard BEFORE INSERT OR UPDATE ON inbound_mailbox FOR EACH ROW EXECUTE FUNCTION app.guard_inbound_mailbox();
