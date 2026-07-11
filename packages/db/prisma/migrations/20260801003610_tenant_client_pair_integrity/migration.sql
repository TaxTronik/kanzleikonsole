-- =============================================================================
-- Systemische Tenant-/Mandanten-Paarinvariante.
--
-- Die historischen Einzel-FKs auf tenant_id und client_id beweisen nicht, dass
-- beide IDs zu demselben Mandanten-Scope gehören. RLS prüft regelmäßig nur die
-- tenant_id der Kindzeile. Deshalb wird die Paarung für jede aktuelle
-- public-Tabelle mit beiden Spalten zentral und race-sicher erzwungen, ohne die
-- je Tabelle unterschiedliche ON DELETE SET NULL/CASCADE/NO ACTION-Semantik der
-- bestehenden FKs zu verändern.
-- =============================================================================

-- Altbestand niemals automatisch umhängen oder löschen. Eine bestehende
-- Abweichung ist bereits eine aktive Mandantentrennungsstörung; das Deployment
-- bricht mit einer tabellenweisen Zählung ab und verlangt eine fachlich
-- kontrollierte Bereinigung.
DO $audit_tenant_client_pairs$
DECLARE
  pair_table RECORD;
  mismatch_count BIGINT;
  mismatch_details TEXT[] := ARRAY[]::TEXT[];
BEGIN
  FOR pair_table IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
       AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public'
       AND c.column_name IN ('tenant_id', 'client_id')
     GROUP BY c.table_name
    HAVING COUNT(DISTINCT c.column_name) = 2
     ORDER BY c.table_name
  LOOP
    EXECUTE format(
      'SELECT COUNT(*)
         FROM public.%I child
         LEFT JOIN public.client parent ON parent.id = child.client_id
        WHERE child.client_id IS NOT NULL
          AND (parent.id IS NULL OR parent.tenant_id IS DISTINCT FROM child.tenant_id)',
      pair_table.table_name
    ) INTO mismatch_count;

    IF mismatch_count > 0 THEN
      mismatch_details := array_append(
        mismatch_details,
        format('%I=%s', pair_table.table_name, mismatch_count)
      );
    END IF;
  END LOOP;

  IF cardinality(mismatch_details) > 0 THEN
    RAISE EXCEPTION 'Tenant-/Mandanten-Paarprüfung im Altbestand fehlgeschlagen.'
      USING ERRCODE = 'check_violation',
            DETAIL = array_to_string(mismatch_details, ', '),
            HINT = 'Betroffene Zeilen fachlich prüfen und kontrolliert bereinigen; Migration danach erneut ausführen.';
  END IF;
END;
$audit_tenant_client_pairs$;

CREATE OR REPLACE FUNCTION app.enforce_tenant_client_pair_integrity()
RETURNS TRIGGER AS $$
DECLARE
  parent_tenant_id UUID;
BEGIN
  -- Nullable client_id (z. B. Kanzlei-Dokumente oder SET-NULL-FKs) ist ein
  -- ausdrücklicher Zustand und benötigt keine Parent-Paarprüfung.
  IF NEW."client_id" IS NULL THEN
    RETURN NEW;
  END IF;

  -- BEFORE-Trigger laufen vor der FK-Prüfung. Der explizite Parent-Lock
  -- serialisiert deshalb INSERT/Reparenting mit Client-Löschung und schützt die
  -- Prüfung davor, einen Zustand zu lesen, der vor dem eigenen Commit kippt.
  SELECT c."tenant_id"
    INTO parent_tenant_id
    FROM public."client" c
   WHERE c."id" = NEW."client_id"
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mandant der referenzierten client_id ist im aktuellen DB-Scope nicht vorhanden (%).', TG_TABLE_NAME
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW."tenant_id" IS DISTINCT FROM parent_tenant_id THEN
    RAISE EXCEPTION 'tenant_id und client_id gehören nicht zum selben Mandanten-Scope (%).', TG_TABLE_NAME
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.enforce_tenant_client_pair_integrity()
  SET search_path = pg_catalog, public, app, pg_temp;

-- Die Parent-Paarung selbst ist eine Identitätsinvariante. Ohne diese Sperre
-- könnte ein nachträgliches Reparenting des Client-Datensatzes sämtliche
-- bereits gültigen Kindpaare auf einmal brechen. IDs und Tenant-Zuordnung sind
-- keine editierbaren Stammdaten; ein fachlicher Umzug muss als kontrollierte
-- Neuanlage/Migration erfolgen.
CREATE OR REPLACE FUNCTION app.protect_client_identity_scope()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
  THEN
    RAISE EXCEPTION 'client.id und client.tenant_id sind unveränderliche Scope-Identität.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.protect_client_identity_scope()
  SET search_path = pg_catalog, public, app, pg_temp;

CREATE TRIGGER "00_client_identity_scope_immutable"
BEFORE UPDATE OF "id", "tenant_id" ON public."client"
FOR EACH ROW EXECUTE FUNCTION app.protect_client_identity_scope();

-- Der Katalog ist absichtlich die Quelle der Abdeckung: Jede beim Deployment
-- vorhandene Basistabelle mit tenant_id + client_id erhält denselben Guard.
-- Ein Katalog-Regressionstest erzwingt, dass auch künftig neu hinzukommende
-- Paar-Tabellen durch eine Folgemigration geschützt werden.
DO $install_tenant_client_pair_triggers$
DECLARE
  pair_table RECORD;
BEGIN
  FOR pair_table IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
       AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public'
       AND c.column_name IN ('tenant_id', 'client_id')
     GROUP BY c.table_name
    HAVING COUNT(DISTINCT c.column_name) = 2
     ORDER BY c.table_name
  LOOP
    EXECUTE format(
      'CREATE TRIGGER "00_tenant_client_pair_integrity"
         BEFORE INSERT OR UPDATE OF tenant_id, client_id ON public.%I
         FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_client_pair_integrity()',
      pair_table.table_name
    );
  END LOOP;
END;
$install_tenant_client_pair_triggers$;
