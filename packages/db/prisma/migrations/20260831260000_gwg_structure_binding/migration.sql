-- Fachkatalog: MANDATE-STRUCTURE-001 / GWG-BENEFICIAL-OWNERS-001 / GWG-RISK-REVIEW-001 / GWG-RETENTION-DESTRUCTION-001.
CREATE TABLE gwg_structure_binding (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 client_id UUID NOT NULL REFERENCES client(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 gwg_check_id UUID NOT NULL REFERENCES gwg_check(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 structure_version_id UUID REFERENCES mandate_structure_version(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 structure_hash TEXT, revision INTEGER NOT NULL CHECK(revision>0), note TEXT,
 created_by UUID NOT NULL REFERENCES staff_user(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, destroyed_at TIMESTAMPTZ(6),
 CHECK((destroyed_at IS NULL AND structure_version_id IS NOT NULL AND structure_hash~'^[a-f0-9]{64}$' AND length(note)>=10)
 OR (destroyed_at IS NOT NULL AND structure_version_id IS NULL AND structure_hash IS NULL AND note IS NULL))
);
CREATE UNIQUE INDEX gwg_structure_binding_gwg_check_id_revision_key ON gwg_structure_binding(gwg_check_id,revision);
CREATE INDEX gwg_structure_binding_tenant_id_client_id_created_at_idx ON gwg_structure_binding(tenant_id,client_id,created_at);
CREATE FUNCTION app.gwg_structure_binding_allowed(tid UUID,cid UUID,checkid UUID,svid UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT tid=app.current_tenant_id() AND EXISTS(SELECT 1 FROM gwg_check g JOIN client c ON c.id=g.client_id WHERE g.id=checkid AND g.tenant_id=tid AND g.client_id=cid AND c.anonymized_at IS NULL AND
 (app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND g.destroyed_at IS NULL
 AND app.notification_staff_can_access_client(tid,app.current_actor_id(),cid)
 AND EXISTS(SELECT 1 FROM mandate_structure_version v WHERE v.id=svid AND v.tenant_id=tid AND v.client_id=cid)
 AND NOT EXISTS(SELECT 1 FROM mandate_structure_node n LEFT JOIN client linked ON linked.id=n.linked_client_id WHERE n.version_id=svid AND n.linked_client_id IS NOT NULL AND (linked.anonymized_at IS NOT NULL OR NOT app.notification_staff_can_access_client(tid,app.current_actor_id(),n.linked_client_id))))))
$$;
REVOKE ALL ON FUNCTION app.gwg_structure_binding_allowed(UUID,UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.gwg_structure_binding_allowed(UUID,UUID,UUID,UUID) TO taxtronik_app;
ALTER TABLE gwg_structure_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE gwg_structure_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY gwg_structure_binding_read ON gwg_structure_binding FOR SELECT USING(app.gwg_structure_binding_allowed(tenant_id,client_id,gwg_check_id,structure_version_id));
CREATE POLICY gwg_structure_binding_create ON gwg_structure_binding FOR INSERT WITH CHECK(created_by=app.current_actor_id() AND app.current_actor_type()='STAFF' AND app.gwg_structure_binding_allowed(tenant_id,client_id,gwg_check_id,structure_version_id));
REVOKE UPDATE,DELETE ON gwg_structure_binding FROM taxtronik_app;
GRANT SELECT,INSERT ON gwg_structure_binding TO taxtronik_app;
CREATE FUNCTION app.guard_gwg_structure_binding() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE g RECORD; latest_revision INTEGER;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF pg_trigger_depth()>1 AND OLD.destroyed_at IS NULL AND NEW.destroyed_at IS NOT NULL AND NEW.structure_version_id IS NULL AND NEW.structure_hash IS NULL AND NEW.note IS NULL
   AND (to_jsonb(NEW)-'structure_version_id'-'structure_hash'-'note'-'destroyed_at')=(to_jsonb(OLD)-'structure_version_id'-'structure_hash'-'note'-'destroyed_at')
   AND EXISTS(SELECT 1 FROM gwg_check WHERE id=NEW.gwg_check_id AND destroyed_at=NEW.destroyed_at) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'GwG structure bindings are immutable';
 ELSIF TG_OP='DELETE' THEN RAISE EXCEPTION 'GwG structure bindings are immutable'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('gwg-check-lifecycle:'||NEW.tenant_id::text||':'||NEW.client_id::text,0));
 SELECT * INTO g FROM gwg_check WHERE id=NEW.gwg_check_id FOR UPDATE;
 IF g.id IS NULL OR g.tenant_id<>NEW.tenant_id OR g.client_id<>NEW.client_id OR g.status<>'DRAFT' OR g.destroyed_at IS NOT NULL
 OR EXISTS(SELECT 1 FROM gwg_check newer WHERE newer.client_id=g.client_id AND newer.tenant_id=g.tenant_id AND (newer.created_at,newer.id)>(g.created_at,g.id)) THEN RAISE EXCEPTION 'latest open draft check required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM mandate_structure_version WHERE id=NEW.structure_version_id AND tenant_id=NEW.tenant_id AND client_id=NEW.client_id AND content_hash=NEW.structure_hash)
 OR NOT EXISTS(SELECT 1 FROM staff_user WHERE id=NEW.created_by AND tenant_id=NEW.tenant_id AND active) OR NEW.destroyed_at IS NOT NULL OR NEW.note IS NULL OR length(trim(NEW.note))<10 THEN RAISE EXCEPTION 'invalid bound structure version'; END IF;
 SELECT coalesce(max(revision),0) INTO latest_revision FROM gwg_structure_binding WHERE gwg_check_id=NEW.gwg_check_id;
 IF NEW.revision<>latest_revision+1 THEN RAISE EXCEPTION 'stale structure binding revision'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gwg_structure_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON gwg_structure_binding FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_structure_binding();

-- Extend the existing controlled check-destruction transition, without a new deletion scheduler.
CREATE FUNCTION app.purge_gwg_structure_bindings() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF OLD.destroyed_at IS NULL AND NEW.destroyed_at IS NOT NULL THEN
  UPDATE gwg_structure_binding SET structure_version_id=NULL,structure_hash=NULL,note=NULL,destroyed_at=NEW.destroyed_at WHERE gwg_check_id=NEW.id AND destroyed_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.purge_gwg_structure_bindings() FROM PUBLIC;
CREATE TRIGGER purge_gwg_structure_bindings AFTER UPDATE OF destroyed_at ON gwg_check FOR EACH ROW EXECUTE FUNCTION app.purge_gwg_structure_bindings();
