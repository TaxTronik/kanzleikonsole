-- Fachkatalog: MANDATE-STRUCTURE-001.
-- A version and all its nodes/edges are created atomically by saveStructureTx.
-- Existing UPDATE/DELETE guards alone do not forbid later child INSERTs.
CREATE FUNCTION app.guard_structure_version_children() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM mandate_structure_version v WHERE v.id=NEW.version_id AND v.tenant_id=NEW.tenant_id AND v.xmin=pg_current_xact_id()::xid) THEN
  RAISE EXCEPTION 'structure version is sealed; save a new version';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER structure_node_version_seal BEFORE INSERT ON mandate_structure_node FOR EACH ROW EXECUTE FUNCTION app.guard_structure_version_children();
CREATE TRIGGER structure_edge_version_seal BEFORE INSERT ON mandate_structure_edge FOR EACH ROW EXECUTE FUNCTION app.guard_structure_version_children();
