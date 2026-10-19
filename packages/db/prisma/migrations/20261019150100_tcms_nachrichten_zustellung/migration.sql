-- Fachkatalog: MAIL-OUTBOX-001, ACCESS-TENANT-RLS-001
--
-- TCMS Stufe 4: Das Tax-CMS stellt seine Mitteilungen (Freigabe angefordert,
-- Bestätigungscode, Neuadressierung an Mandantenkontakte; gemeldetes Ereignis
-- an Kanzleipersonen) nicht selbst zu. Der Worker tcms-nachrichten-zustellen
-- holt sie mit dem Systemakteur des Tenants ab, prüft die Empfänger gegen die
-- kanzleikonsole und plant sie über die Mail-Outbox bzw. als In-App-Hinweis ein.
--
-- tcms_systemakteur: je Tenant eine feste, zufällige UUID (gen_random_uuid,
-- nicht aus der Tenant-ID ableitbar), einmal erzeugt und unveränderlich
-- (Trigger), eindeutig über alle Tenants. Dieselbe Zeile trägt den Lease des
-- Zustelllaufs (lauf_halter, lauf_bis): ein Lauf je Tenant gleichzeitig, wie
-- audit_anchor_lease; ein abgestürzter Halter blockiert höchstens bis lauf_bis.
--
-- tcms_nachricht_zustellung: je Mitteilung des Tax-CMS (Tenant + Nachrichten-ID)
-- genau eine Zeile. Der eindeutige Schlüssel und die Zeilensperre schließen
-- eine doppelte Einplanung aus, auch bei zwei gleichzeitigen Läufen, weil das
-- Tax-CMS beim Abruf nichts reserviert. Status EINGEPLANT (Outbox-Auftrag bzw.
-- Hinweis angelegt), ZURUECKGESTELLT (Empfängerprüfung gescheitert, Grund als
-- fester Code, nächster Lauf prüft erneut) oder UNZUSTELLBAR (abgeschlossen
-- ohne Zustellung). gemeldet_am: Zustellung beim Tax-CMS bestätigt (oder 404).
-- Keine Inhalte, keine Namen, keine Adressen, kein Code.
--
-- Beide Tabellen gehören allein dem Worker (Owner): Die App-Rolle erhält
-- keinerlei Rechte; die Web-App kennt den Systemakteur nicht.
--
-- mail_outbox: Aufträge zu einer Mitteilung (resource_type tcms_nachricht,
-- resource_id = tcms_nachricht_zustellung.id) sind je Tenant eindeutig
-- (partieller eindeutiger Index) und verlieren mit jedem Endstatus Inhalt und
-- geheime Variablen (CHECK, auch FAILED/UNKNOWN): Ein Bestätigungscode liegt
-- nur Secret-Box-verschlüsselt und nur bis zum Versand in der Datenbank;
-- „Erneut senden“ gibt es für diese Aufträge nicht.
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md), Tabellen, Indizes, CHECKs und
-- Grants ergänzt:
--   neu:      functions/app.guard_tcms_systemakteur().sql
--   neu:      policies/tcms_nachricht_zustellung.tcms_nachricht_zustellung_isolation.sql
--   neu:      policies/tcms_systemakteur.tcms_systemakteur_isolation.sql
--   neu:      triggers/tcms_systemakteur.00_guard_tcms_systemakteur.sql
BEGIN;

CREATE TABLE public."tcms_systemakteur" (
  "tenant_id"   UUID           NOT NULL,
  "akteur_id"   UUID           NOT NULL DEFAULT gen_random_uuid(),
  "erstellt_am" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lauf_halter" UUID,
  "lauf_bis"    TIMESTAMPTZ(6),

  CONSTRAINT "tcms_systemakteur_pkey" PRIMARY KEY ("tenant_id"),
  CONSTRAINT "tcms_systemakteur_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "tcms_systemakteur_lauf_check" CHECK (("lauf_halter" IS NULL) = ("lauf_bis" IS NULL))
);
CREATE UNIQUE INDEX "tcms_systemakteur_akteur_id_key" ON public."tcms_systemakteur"("akteur_id");

COMMENT ON TABLE public."tcms_systemakteur" IS
  'Owner-only: Systemakteur des Tax-CMS je Tenant (feste ID) und Lease des Zustelllaufs.';

CREATE TABLE public."tcms_nachricht_zustellung" (
  "id"               UUID           NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"        UUID           NOT NULL,
  "nachricht_id"     TEXT           NOT NULL,
  "zweck"            TEXT           NOT NULL,
  "status"           TEXT           NOT NULL,
  "grund"            TEXT,
  "erstmals_am"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "geprueft_am"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "abgeschlossen_am" TIMESTAMPTZ(6),
  "hinweis_am"       TIMESTAMPTZ(6),
  "gemeldet_am"      TIMESTAMPTZ(6),

  CONSTRAINT "tcms_nachricht_zustellung_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tcms_nachricht_zustellung_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  -- Objekt-ID des Tax-CMS (wie objektId im Vertrag).
  CONSTRAINT "tcms_nachricht_zustellung_nachricht_id_check"
    CHECK ("nachricht_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT "tcms_nachricht_zustellung_zweck_check" CHECK ("zweck" IN (
    'FREIGABE_ANGEFORDERT', 'FREIGABE_CODE', 'FREIGABE_NEU_ADRESSIERT', 'EREIGNIS_GEMELDET'
  )),
  CONSTRAINT "tcms_nachricht_zustellung_status_check"
    CHECK ("status" IN ('EINGEPLANT', 'ZURUECKGESTELLT', 'UNZUSTELLBAR')),
  -- Feste Codes ohne personenbezogene Angaben; nur ohne Einplanung.
  CONSTRAINT "tcms_nachricht_zustellung_grund_check" CHECK (
    ("status" = 'EINGEPLANT') = ("grund" IS NULL)
    AND ("grund" IS NULL OR "grund" IN (
      'ABGELAUFEN',
      'MANDANT_UNBEKANNT', 'MANDANT_INAKTIV',
      'KONTAKT_UNBEKANNT', 'KONTAKT_ANDERER_MANDANT', 'KONTAKT_INAKTIV',
      'KONTAKT_OHNE_EMAIL', 'KONTAKT_UNBESTAETIGT',
      'PERSON_UNBEKANNT', 'PERSON_INAKTIV', 'PERSON_OHNE_ZUGRIFF'
    ))
  ),
  -- Abgeschlossen ist alles außer ZURUECKGESTELLT; gemeldet wird nur Abgeschlossenes.
  CONSTRAINT "tcms_nachricht_zustellung_abschluss_check" CHECK (
    ("status" = 'ZURUECKGESTELLT') = ("abgeschlossen_am" IS NULL)
    AND ("gemeldet_am" IS NULL OR "abgeschlossen_am" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "tcms_nachricht_zustellung_tenant_nachricht_key"
  ON public."tcms_nachricht_zustellung"("tenant_id", "nachricht_id");

COMMENT ON TABLE public."tcms_nachricht_zustellung" IS
  'Owner-only: Zustellstand je Mitteilung des Tax-CMS (ohne Inhalte); schließt Doppelzustellung aus.';

CREATE OR REPLACE FUNCTION app.guard_tcms_systemakteur()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- MAIL-OUTBOX-001 (TCMS Stufe 4): Der Systemakteur eines Tenants wird einmal
  -- erzeugt und nie geändert. Das Tax-CMS führt seine Audit-Einträge unter
  -- dieser ID; eine geänderte ID wäre ein anderer Akteur. Nur der Lease des
  -- Zustelllaufs (lauf_halter, lauf_bis) darf sich ändern.
  IF (NEW.tenant_id, NEW.akteur_id, NEW.erstellt_am)
     IS DISTINCT FROM (OLD.tenant_id, OLD.akteur_id, OLD.erstellt_am) THEN
    RAISE EXCEPTION 'TCMS_SYSTEMAKTEUR_UNVERAENDERLICH: Der Systemakteur eines Tenants ist unveränderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "00_guard_tcms_systemakteur" BEFORE UPDATE ON public.tcms_systemakteur FOR EACH ROW EXECUTE FUNCTION app.guard_tcms_systemakteur();

ALTER TABLE public."tcms_systemakteur" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."tcms_systemakteur" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."tcms_nachricht_zustellung" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."tcms_nachricht_zustellung" FORCE ROW LEVEL SECURITY;

CREATE POLICY tcms_nachricht_zustellung_isolation ON public.tcms_nachricht_zustellung
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((tenant_id = app.current_tenant_id()))
  WITH CHECK ((tenant_id = app.current_tenant_id()));

CREATE POLICY tcms_systemakteur_isolation ON public.tcms_systemakteur
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((tenant_id = app.current_tenant_id()))
  WITH CHECK ((tenant_id = app.current_tenant_id()));

-- Die Default-Privilegien des Schemas gewähren neuen Tabellen Rechte an die
-- App-Rolle; hier vollständig zurücknehmen (nur der Worker/Owner).
REVOKE ALL ON TABLE public."tcms_systemakteur" FROM PUBLIC;
REVOKE ALL ON TABLE public."tcms_systemakteur" FROM taxtronik_app;
REVOKE ALL ON TABLE public."tcms_nachricht_zustellung" FROM PUBLIC;
REVOKE ALL ON TABLE public."tcms_nachricht_zustellung" FROM taxtronik_app;

-- Höchstens ein Versandauftrag je Mitteilung (zweite Sperre neben der Zeile oben).
CREATE UNIQUE INDEX "mail_outbox_tcms_nachricht_key"
  ON public."mail_outbox"("tenant_id", "resource_id")
  WHERE "resource_type" = 'tcms_nachricht';

-- Mitteilungen des Tax-CMS: Inhalt und geheime Variablen (Bestätigungscode)
-- überleben keinen Endstatus, auch nicht FAILED/UNKNOWN (kein Neuversand).
ALTER TABLE public."mail_outbox" ADD CONSTRAINT "mail_outbox_tcms_content_check" CHECK (
  "resource_type" <> 'tcms_nachricht'
  OR "status" IN ('QUEUED', 'SENDING', 'RETRY_PENDING')
  OR ("payload" = '{}'::jsonb AND "secret_vars_enc" IS NULL)
);

COMMIT;
