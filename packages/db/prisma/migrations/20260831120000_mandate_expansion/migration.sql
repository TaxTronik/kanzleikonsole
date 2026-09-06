BEGIN;
CREATE TABLE public.mandate_structure_version (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE ON UPDATE CASCADE,
 client_id UUID NOT NULL REFERENCES public.client(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 revision INTEGER NOT NULL CHECK(revision>0), content_hash TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
 created_by UUID NOT NULL REFERENCES public.staff_user(id) ON DELETE NO ACTION ON UPDATE CASCADE, created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX mandate_structure_version_tenant_id_client_id_revision_key ON public.mandate_structure_version(tenant_id,client_id,revision);
CREATE TABLE public.mandate_structure_node (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE ON UPDATE CASCADE,
 version_id UUID NOT NULL REFERENCES public.mandate_structure_version(id) ON DELETE CASCADE ON UPDATE CASCADE,
 node_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('CLIENT','PERSON','ORGANIZATION')), label TEXT NOT NULL,
 linked_client_id UUID REFERENCES public.client(id) ON DELETE NO ACTION ON UPDATE CASCADE, x DOUBLE PRECISION NOT NULL, y DOUBLE PRECISION NOT NULL,
 CHECK((kind='CLIENT')=(linked_client_id IS NOT NULL))
);
CREATE UNIQUE INDEX mandate_structure_node_version_id_node_key_key ON public.mandate_structure_node(version_id,node_key);
CREATE TABLE public.mandate_structure_edge (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE ON UPDATE CASCADE,
 version_id UUID NOT NULL REFERENCES public.mandate_structure_version(id) ON DELETE CASCADE ON UPDATE CASCADE,
 from_node_id UUID NOT NULL REFERENCES public.mandate_structure_node(id) ON DELETE CASCADE ON UPDATE CASCADE,
 to_node_id UUID NOT NULL REFERENCES public.mandate_structure_node(id) ON DELETE CASCADE ON UPDATE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN('CAPITAL','VOTING','CONTROL')), percentage DECIMAL(5,2) CHECK(percentage BETWEEN 0 AND 100), note TEXT NOT NULL DEFAULT '',
 CHECK(from_node_id<>to_node_id)
);
CREATE UNIQUE INDEX mandate_structure_edge_version_id_from_node_id_to_node_id_kind_key ON public.mandate_structure_edge(version_id,from_node_id,to_node_id,kind);
CREATE TABLE public.workflow_dependency (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE ON UPDATE CASCADE,
 predecessor_item_id UUID NOT NULL REFERENCES public.workflow_item(id) ON DELETE CASCADE ON UPDATE CASCADE,
 successor_item_id UUID NOT NULL REFERENCES public.workflow_item(id) ON DELETE CASCADE ON UPDATE CASCADE,
 created_by UUID NOT NULL REFERENCES public.staff_user(id) ON DELETE NO ACTION ON UPDATE CASCADE, created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(predecessor_item_id<>successor_item_id)
);
CREATE UNIQUE INDEX workflow_dependency_predecessor_item_id_successor_item_id_key ON public.workflow_dependency(predecessor_item_id,successor_item_id);
CREATE TABLE public.mandate_offboarding (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE ON UPDATE CASCADE,
 client_id UUID NOT NULL REFERENCES public.client(id) ON DELETE NO ACTION ON UPDATE CASCADE, end_date DATE NOT NULL,
 source_hash TEXT NOT NULL, source_snapshot JSONB NOT NULL, handover_note TEXT NOT NULL, retention_note TEXT NOT NULL,
 created_by UUID NOT NULL REFERENCES public.staff_user(id) ON DELETE NO ACTION ON UPDATE CASCADE, created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TIMESTAMPTZ(6)
);
CREATE INDEX mandate_offboarding_tenant_id_client_id_created_at_idx ON public.mandate_offboarding(tenant_id,client_id,created_at);
CREATE UNIQUE INDEX mandate_offboarding_one_open ON public.mandate_offboarding(client_id) WHERE completed_at IS NULL;
CREATE TABLE public.mandate_offboarding_document (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE ON UPDATE CASCADE,
 offboarding_id UUID NOT NULL REFERENCES public.mandate_offboarding(id) ON DELETE CASCADE ON UPDATE CASCADE,
 document_version_id UUID NOT NULL REFERENCES public.document_version(id) ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX mandate_offboarding_document_offboarding_id_document_version_id_key ON public.mandate_offboarding_document(offboarding_id,document_version_id);
CREATE TABLE public.vdb_record (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE ON UPDATE CASCADE,
 client_id UUID NOT NULL REFERENCES public.client(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 poa_id UUID NOT NULL REFERENCES public.power_of_attorney(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 status TEXT NOT NULL CHECK(status IN('PREPARED','REPORTED','CONFIRMED','REJECTED','WITHDRAWN')), revision INTEGER NOT NULL CHECK(revision>0),
 external_reference TEXT NOT NULL DEFAULT '', evidence_version_id UUID REFERENCES public.document_version(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 note TEXT NOT NULL, recorded_at TIMESTAMPTZ(6) NOT NULL, created_by UUID NOT NULL REFERENCES public.staff_user(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX vdb_record_tenant_id_poa_id_created_at_idx ON public.vdb_record(tenant_id,poa_id,created_at);
CREATE UNIQUE INDEX vdb_record_poa_id_revision_key ON public.vdb_record(poa_id,revision);

-- Scope checks supplement actual foreign keys, including privileged worker paths.
CREATE FUNCTION app.mandate_expansion_scope() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE scope_client UUID; scope_tenant UUID;
BEGIN
 IF TG_TABLE_NAME IN('mandate_structure_version','mandate_offboarding','vdb_record') THEN
  IF NOT EXISTS(SELECT 1 FROM public.client WHERE id=NEW.client_id AND tenant_id=NEW.tenant_id AND anonymized_at IS NULL) THEN RAISE EXCEPTION 'Invalid mandate scope'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.staff_user WHERE id=NEW.created_by AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Invalid actor scope'; END IF;
 ELSIF TG_TABLE_NAME='mandate_structure_node' THEN
  IF NOT EXISTS(SELECT 1 FROM public.mandate_structure_version WHERE id=NEW.version_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Invalid structure scope'; END IF;
  IF NEW.linked_client_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.client WHERE id=NEW.linked_client_id AND tenant_id=NEW.tenant_id AND anonymized_at IS NULL) THEN RAISE EXCEPTION 'Invalid linked mandate'; END IF;
 ELSIF TG_TABLE_NAME='mandate_structure_edge' THEN
  IF NOT EXISTS(SELECT 1 FROM public.mandate_structure_node a JOIN public.mandate_structure_node b ON b.id=NEW.to_node_id WHERE a.id=NEW.from_node_id AND a.version_id=NEW.version_id AND b.version_id=NEW.version_id AND a.tenant_id=NEW.tenant_id AND b.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Invalid structure endpoints'; END IF;
 ELSIF TG_TABLE_NAME='mandate_offboarding_document' THEN
  SELECT client_id,tenant_id INTO scope_client,scope_tenant FROM public.mandate_offboarding WHERE id=NEW.offboarding_id;
  IF scope_tenant IS DISTINCT FROM NEW.tenant_id OR NOT EXISTS(SELECT 1 FROM public.document_version v JOIN public.document d ON d.id=v.document_id WHERE v.id=NEW.document_version_id AND d.client_id=scope_client AND d.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Invalid handover evidence'; END IF;
 END IF;
 IF TG_TABLE_NAME='vdb_record' THEN
  IF NOT EXISTS(SELECT 1 FROM public.power_of_attorney WHERE id=NEW.poa_id AND tenant_id=NEW.tenant_id AND client_id=NEW.client_id) THEN RAISE EXCEPTION 'Invalid power of attorney'; END IF;
  IF NEW.evidence_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.document_version v JOIN public.document d ON d.id=v.document_id WHERE v.id=NEW.evidence_version_id AND d.client_id=NEW.client_id AND d.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Invalid VDB evidence'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION app.workflow_dependency_scope() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('workflow-dependencies:'||NEW.tenant_id::text,0));
 IF NOT EXISTS(SELECT 1 FROM public.workflow_item a JOIN public.workflow_instance ai ON ai.id=a.instance_id JOIN public.workflow_item b ON b.id=NEW.successor_item_id JOIN public.workflow_instance bi ON bi.id=b.instance_id WHERE a.id=NEW.predecessor_item_id AND ai.tenant_id=NEW.tenant_id AND bi.tenant_id=NEW.tenant_id AND ai.client_id<>bi.client_id) THEN RAISE EXCEPTION 'Invalid dependency scope'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.staff_user WHERE id=NEW.created_by AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Invalid dependency actor'; END IF;
 IF EXISTS(WITH RECURSIVE reachable(id) AS (SELECT successor_item_id FROM public.workflow_dependency WHERE predecessor_item_id=NEW.successor_item_id AND tenant_id=NEW.tenant_id UNION SELECT d.successor_item_id FROM public.workflow_dependency d JOIN reachable r ON d.predecessor_item_id=r.id WHERE d.tenant_id=NEW.tenant_id) SELECT 1 FROM reachable WHERE id=NEW.predecessor_item_id) THEN RAISE EXCEPTION 'Dependency cycle'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_dependency_scope BEFORE INSERT OR UPDATE ON public.workflow_dependency FOR EACH ROW EXECUTE FUNCTION app.workflow_dependency_scope();

DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['mandate_structure_version','mandate_structure_node','mandate_structure_edge','mandate_offboarding','mandate_offboarding_document','vdb_record'] LOOP
  EXECUTE format('CREATE TRIGGER mandate_expansion_scope BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.mandate_expansion_scope()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['mandate_structure_version','mandate_structure_node','mandate_structure_edge','workflow_dependency','mandate_offboarding','mandate_offboarding_document','vdb_record'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY %I ON public.%I USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id())',t||'_isolation',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON public.mandate_structure_version,public.mandate_structure_node,public.mandate_structure_edge,public.vdb_record TO taxtronik_app;
GRANT SELECT,INSERT,DELETE ON public.workflow_dependency TO taxtronik_app;
GRANT SELECT,INSERT,UPDATE ON public.mandate_offboarding TO taxtronik_app;
GRANT SELECT,INSERT,DELETE ON public.mandate_offboarding_document TO taxtronik_app;
COMMIT;
