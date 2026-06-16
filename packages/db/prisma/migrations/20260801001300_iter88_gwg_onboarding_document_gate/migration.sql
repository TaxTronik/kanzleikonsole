-- =============================================================================
-- iter88: GwG-Onboarding darf GwG-Nachweise vor Mandanten-Aktivierung hochladen.
--
-- Die allgemeine GwG-Schranke verhindert Dokumente fuer Mandanten ohne
-- allow_active=true. Das ist fuer normale Dokumente korrekt, blockiert aber den
-- Onboarding-Flow: Ausweis-/GwG-Nachweise muessen hochgeladen werden, bevor die
-- Kanzlei den gwg_check verifizieren und den Mandanten aktivieren kann.
--
-- Eng begrenzte Ausnahme:
--   - nur document.classification = GWG_EVIDENCE
--   - nur wenn fuer denselben Tenant+Mandanten eine nicht abgelaufene
--     GwG-Onboarding-Einladung in PENDING oder STARTED existiert
--
-- Anforderungen/Rechnungen und alle anderen Dokumentklassifikationen bleiben
-- weiterhin fail-closed hinter allow_active.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.enforce_client_active_for_document() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.client_id IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM "client" c
            WHERE c.id = NEW.client_id AND c.allow_active = TRUE
        ) THEN
            RETURN NEW;
        END IF;

        IF NEW.classification = 'GWG_EVIDENCE'::document_classification AND EXISTS (
            SELECT 1
            FROM "gwg_onboarding_invite" inv
            WHERE inv.tenant_id = NEW.tenant_id
              AND inv.client_id = NEW.client_id
              AND inv.status IN ('PENDING', 'STARTED')
              AND inv.expires_at > now()
        ) THEN
            RETURN NEW;
        END IF;

        RAISE EXCEPTION 'Mandant % ist nicht aktiv (GwG-Schranke). Dokumentenanlage abgewiesen.',
            NEW.client_id
            USING ERRCODE = 'check_violation',
                  HINT = 'Mandant muss verifiziert sein (gwg_check.status = VERIFIED); GwG-Onboarding erlaubt nur GWG_EVIDENCE mit aktiver Einladung.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.enforce_client_active_for_document() SET search_path = pg_catalog, public;
