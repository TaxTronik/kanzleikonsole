-- Fachkatalog: GWG-SELF-ONBOARDING-001
--
-- Erwarteter Backfill-Stand nach allen Migrationen fuer die historischen
-- GwG-Zustaende aus onboarding-041-fixtures.sql.
SET TIME ZONE 'UTC';
DO $$
BEGIN
  IF (SELECT onboarding_completed_at FROM client
       WHERE id = '11000000-0000-4000-8000-000000000041') IS NULL THEN
    RAISE EXCEPTION 'VERIFIED plus active contact was not backfilled';
  END IF;
  IF (SELECT onboarding_completed_at <= created_at FROM client
       WHERE id = '11000000-0000-4000-8000-000000000041') THEN
    RAISE EXCEPTION 'legacy completion marker must use the honest backfill time';
  END IF;
  IF (SELECT onboarding_completed_at FROM client
       WHERE id = '12000000-0000-4000-8000-000000000041') IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFIED without active contact was marked complete';
  END IF;
  IF (SELECT onboarding_completed_at FROM client
       WHERE id = '13000000-0000-4000-8000-000000000041') IS NULL THEN
    RAISE EXCEPTION 'EXPIRED historical verification with active contact was reopened';
  END IF;
END $$;
