-- Fachkatalog: GWG-ACTIVATION-GATE-001
--
-- Erwarteter Stand nach allen Migrationen fuer den Altbestand aus
-- gwg-034-fixtures.sql. Jede Abweichung bricht mit RAISE EXCEPTION ab.
DO $$
BEGIN
  IF (SELECT status FROM gwg_check
       WHERE id = '33333333-3333-4333-8333-333333333333')
     IS DISTINCT FROM 'EXPIRED'::gwg_status THEN
    RAISE EXCEPTION 'Migration 034 hat den unvollständigen Alt-Check nicht beendet';
  END IF;
  IF (SELECT allow_active FROM client
       WHERE id = '22222222-2222-4222-8222-222222222222') IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'Migration 034 hat den Alt-Mandanten nicht fail-closed deaktiviert';
  END IF;
  IF (SELECT COUNT(*) FROM gwg_check
       WHERE client_id = '22222222-2222-4222-8222-222222222222'
         AND status = 'IN_REVIEW') <> 1 THEN
    RAISE EXCEPTION 'Migration 034 hat keinen eindeutigen Folge-Review angelegt';
  END IF;
  IF pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)') IS NULL THEN
    RAISE EXCEPTION 'app.destroy_gwg_check(uuid) fehlt nach Migration 034';
  END IF;
END $$;
