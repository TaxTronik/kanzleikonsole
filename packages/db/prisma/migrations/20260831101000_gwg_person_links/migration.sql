-- GWG-PERSON-LINKS-001: technische Verbindungen, niemals gemeinsame Fachdaten.
BEGIN;
CREATE TABLE public.gwg_person_anchor (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE ON UPDATE CASCADE,
  client_id UUID NOT NULL REFERENCES public.client(id) ON DELETE CASCADE ON UPDATE CASCADE,
  natural_client_id UUID UNIQUE REFERENCES public.client(id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT gwg_person_anchor_natural_scope CHECK (natural_client_id IS NULL OR natural_client_id = client_id)
);
CREATE INDEX gwg_person_anchor_tenant_id_client_id_idx ON public.gwg_person_anchor(tenant_id, client_id);
CREATE TABLE public.gwg_person_link (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE ON UPDATE CASCADE,
  from_anchor_id UUID NOT NULL REFERENCES public.gwg_person_anchor(id) ON DELETE CASCADE,
  to_anchor_id UUID NOT NULL REFERENCES public.gwg_person_anchor(id) ON DELETE CASCADE,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT gwg_person_link_order CHECK (from_anchor_id < to_anchor_id),
  CONSTRAINT gwg_person_link_from_anchor_id_to_anchor_id_key UNIQUE(from_anchor_id, to_anchor_id)
);
CREATE INDEX gwg_person_link_tenant_id_idx ON public.gwg_person_link(tenant_id);
CREATE INDEX gwg_person_link_to_anchor_id_idx ON public.gwg_person_link(to_anchor_id);
ALTER TABLE public.gwg_beneficial_owner ADD COLUMN person_anchor_id UUID REFERENCES public.gwg_person_anchor(id) ON DELETE SET NULL;
ALTER TABLE public.gwg_representative ADD COLUMN person_anchor_id UUID REFERENCES public.gwg_person_anchor(id) ON DELETE SET NULL;
CREATE INDEX gwg_beneficial_owner_person_anchor_id_idx ON public.gwg_beneficial_owner(person_anchor_id);
CREATE INDEX gwg_representative_person_anchor_id_idx ON public.gwg_representative(person_anchor_id);

-- Keine Namensheuristik: nur bestehende ausdrückliche Doppelrollen zusammenführen.
-- Ausschließlich neue technische Spalten initialisieren. Die fachlichen
-- Snapshot-Spalten bleiben unverändert; beide Schutztrigger werden innerhalb
-- derselben exklusiven DDL-Transaktion sofort wieder aktiviert.
ALTER TABLE public.gwg_beneficial_owner DISABLE TRIGGER gwg_beneficial_owner_verified_snapshot_immutable;
ALTER TABLE public.gwg_representative DISABLE TRIGGER gwg_representative_verified_snapshot_immutable;
INSERT INTO public.gwg_person_anchor(id, tenant_id, client_id)
SELECT o.id, c.tenant_id, c.client_id FROM public.gwg_beneficial_owner o
JOIN public.gwg_check c ON c.id=o.gwg_check_id WHERE c.destroyed_at IS NULL;
UPDATE public.gwg_beneficial_owner o SET person_anchor_id=a.id FROM public.gwg_person_anchor a WHERE a.id=o.id;
INSERT INTO public.gwg_person_anchor(id, tenant_id, client_id)
SELECT r.id,c.tenant_id,c.client_id FROM public.gwg_representative r
JOIN public.gwg_check c ON c.id=r.gwg_check_id WHERE c.destroyed_at IS NULL AND r.linked_beneficial_owner_id IS NULL;
UPDATE public.gwg_representative r SET person_anchor_id=COALESCE(o.person_anchor_id,a.id)
FROM public.gwg_person_anchor a LEFT JOIN public.gwg_beneficial_owner o ON o.id=a.id
WHERE a.id=COALESCE(r.linked_beneficial_owner_id,r.id);
ALTER TABLE public.gwg_beneficial_owner ENABLE TRIGGER gwg_beneficial_owner_verified_snapshot_immutable;
ALTER TABLE public.gwg_representative ENABLE TRIGGER gwg_representative_verified_snapshot_immutable;
INSERT INTO public.gwg_person_anchor(tenant_id,client_id,natural_client_id)
SELECT c.tenant_id,c.id,c.id FROM public.client c WHERE c.kind='NATPERS' AND c.anonymized_at IS NULL
AND EXISTS(SELECT 1 FROM public.gwg_check g WHERE g.client_id=c.id AND g.destroyed_at IS NULL);

CREATE FUNCTION app.validate_gwg_person_anchor() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.tenant_id,NEW.client_id,NEW.natural_client_id) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.client_id,OLD.natural_client_id) THEN
   RAISE EXCEPTION 'Person anchor scope is immutable';
  END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.client c WHERE c.id=NEW.client_id AND c.tenant_id=NEW.tenant_id AND c.anonymized_at IS NULL) THEN
   RAISE EXCEPTION 'Invalid person anchor scope';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gwg_person_anchor_scope BEFORE INSERT OR UPDATE ON public.gwg_person_anchor
FOR EACH ROW EXECUTE FUNCTION app.validate_gwg_person_anchor();
CREATE TRIGGER "00_tenant_client_pair_integrity"
BEFORE INSERT OR UPDATE OF tenant_id,client_id ON public.gwg_person_anchor
FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_client_pair_integrity();

CREATE FUNCTION app.assign_gwg_person_anchor() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE scope_tenant UUID; scope_client UUID; linked_anchor UUID;
BEGIN
 SELECT tenant_id,client_id INTO scope_tenant,scope_client FROM public.gwg_check WHERE id=NEW.gwg_check_id;
 IF TG_OP='UPDATE' THEN
  IF NEW.person_anchor_id IS NULL AND OLD.person_anchor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.gwg_person_anchor WHERE id=OLD.person_anchor_id) THEN
   RETURN NEW;
  END IF;
 END IF;
 IF TG_TABLE_NAME='gwg_representative' THEN
  IF NEW.linked_beneficial_owner_id IS NOT NULL THEN
    SELECT person_anchor_id INTO linked_anchor FROM public.gwg_beneficial_owner
    WHERE id=NEW.linked_beneficial_owner_id AND gwg_check_id=NEW.gwg_check_id;
    NEW.person_anchor_id:=linked_anchor;
  END IF;
 END IF;
 IF NEW.person_anchor_id IS NULL THEN
   INSERT INTO public.gwg_person_anchor(tenant_id,client_id) VALUES(scope_tenant,scope_client) RETURNING id INTO NEW.person_anchor_id;
 ELSIF NOT EXISTS(SELECT 1 FROM public.gwg_person_anchor WHERE id=NEW.person_anchor_id AND tenant_id=scope_tenant AND client_id=scope_client) THEN
   RAISE EXCEPTION 'Invalid person anchor scope';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gwg_owner_person_anchor BEFORE INSERT OR UPDATE OF person_anchor_id ON public.gwg_beneficial_owner
FOR EACH ROW EXECUTE FUNCTION app.assign_gwg_person_anchor();
CREATE TRIGGER gwg_representative_person_anchor BEFORE INSERT OR UPDATE OF person_anchor_id,linked_beneficial_owner_id ON public.gwg_representative
FOR EACH ROW EXECUTE FUNCTION app.assign_gwg_person_anchor();

CREATE FUNCTION app.ensure_gwg_natural_person_anchor() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 INSERT INTO public.gwg_person_anchor(tenant_id,client_id,natural_client_id)
 SELECT c.tenant_id,c.id,c.id FROM public.client c WHERE c.id=NEW.client_id AND c.kind='NATPERS' AND c.anonymized_at IS NULL
 ON CONFLICT(natural_client_id) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER gwg_check_natural_person_anchor AFTER INSERT ON public.gwg_check
FOR EACH ROW EXECUTE FUNCTION app.ensure_gwg_natural_person_anchor();

CREATE FUNCTION app.validate_gwg_person_link() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.gwg_person_anchor a JOIN public.gwg_person_anchor b ON b.id=NEW.to_anchor_id
 WHERE a.id=NEW.from_anchor_id AND a.tenant_id=NEW.tenant_id AND b.tenant_id=NEW.tenant_id AND a.client_id<>b.client_id) THEN
   RAISE EXCEPTION 'Invalid person link scope';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.staff_user s WHERE s.id=NEW.created_by AND s.tenant_id=NEW.tenant_id) THEN
   RAISE EXCEPTION 'Invalid person link actor';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gwg_person_link_scope BEFORE INSERT OR UPDATE ON public.gwg_person_link
FOR EACH ROW EXECUTE FUNCTION app.validate_gwg_person_link();

-- Läuft nach den bestehenden Purge-Triggern; Verbindungen verschwinden mit
-- dem letzten noch lebenden lokalen Snapshot, nicht bei transientem Re-Submit.
CREATE FUNCTION app.purge_gwg_person_anchors() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE target_client UUID;
BEGIN
 IF TG_TABLE_NAME='client' THEN target_client:=NEW.id; ELSE target_client:=NEW.client_id; END IF;
 DELETE FROM public.gwg_person_link l WHERE EXISTS (
 SELECT 1 FROM public.gwg_person_anchor a WHERE a.client_id=target_client AND a.id IN(l.from_anchor_id,l.to_anchor_id) AND (
  (TG_TABLE_NAME='client') OR (
   NOT EXISTS(SELECT 1 FROM public.gwg_beneficial_owner o JOIN public.gwg_check g ON g.id=o.gwg_check_id WHERE o.person_anchor_id=a.id AND g.destroyed_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM public.gwg_representative r JOIN public.gwg_check g ON g.id=r.gwg_check_id WHERE r.person_anchor_id=a.id AND g.destroyed_at IS NULL)
   AND (a.natural_client_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.gwg_check g WHERE g.client_id=target_client AND g.destroyed_at IS NULL))
  )));
 DELETE FROM public.gwg_person_anchor a WHERE a.client_id=target_client
 AND NOT EXISTS(SELECT 1 FROM public.gwg_beneficial_owner o WHERE o.person_anchor_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM public.gwg_representative r WHERE r.person_anchor_id=a.id)
 AND (a.natural_client_id IS NULL OR TG_TABLE_NAME='client' OR NOT EXISTS(SELECT 1 FROM public.gwg_check g WHERE g.client_id=target_client AND g.destroyed_at IS NULL));
 RETURN NEW;
END $$;
CREATE TRIGGER zz_gwg_check_person_anchors_purge AFTER UPDATE OF destroyed_at ON public.gwg_check
FOR EACH ROW WHEN(OLD.destroyed_at IS NULL AND NEW.destroyed_at IS NOT NULL) EXECUTE FUNCTION app.purge_gwg_person_anchors();
CREATE TRIGGER zz_client_person_anchors_purge AFTER UPDATE OF anonymized_at ON public.client
FOR EACH ROW WHEN(OLD.anonymized_at IS NULL AND NEW.anonymized_at IS NOT NULL) EXECUTE FUNCTION app.purge_gwg_person_anchors();

ALTER TABLE public.gwg_person_anchor ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gwg_person_anchor FORCE ROW LEVEL SECURITY;
CREATE POLICY gwg_person_anchor_isolation ON public.gwg_person_anchor USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
ALTER TABLE public.gwg_person_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gwg_person_link FORCE ROW LEVEL SECURITY;
CREATE POLICY gwg_person_link_isolation ON public.gwg_person_link USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON public.gwg_person_anchor,public.gwg_person_link TO taxtronik_app;
COMMIT;
