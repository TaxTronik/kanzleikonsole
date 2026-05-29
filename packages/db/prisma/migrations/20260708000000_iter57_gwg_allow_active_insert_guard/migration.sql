-- =============================================================================
-- iter57: GwG-Schranke auch auf INSERT erzwingen (Defense-in-Depth).
--
-- Befund Security-Review: Der Trigger client_allow_active_requires_gwg aus
-- iter4_gwg feuert nur BEFORE UPDATE OF allow_active. Ein INSERT mit
-- allow_active = TRUE umging die GwG-Invariante komplett.
--
-- Die App legt Mandanten zwar immer mit allow_active = false an (Aktivierung
-- läuft separat über den verifizierten UPDATE-Pfad), aber die DB-Verteidigung
-- darf sich nicht auf App-Korrektheit verlassen — sonst genügt ein einziger
-- künftiger create({ allowActive: true }) oder eine Daten-Migration, um einen
-- aktiven Mandanten ohne GwG-Prüfung zu erzeugen (§ 8 GwG).
--
-- Die Trigger-Funktion app.enforce_client_allow_active_requires_gwg() referen-
-- ziert ausschließlich NEW und funktioniert daher für INSERT und UPDATE gleich.
-- Wir hängen sie zusätzlich an einen BEFORE-INSERT-Trigger.
-- =============================================================================

CREATE TRIGGER client_allow_active_requires_gwg_insert
    BEFORE INSERT ON "client"
    FOR EACH ROW
    WHEN (NEW.allow_active = TRUE)
    EXECUTE FUNCTION app.enforce_client_allow_active_requires_gwg();
