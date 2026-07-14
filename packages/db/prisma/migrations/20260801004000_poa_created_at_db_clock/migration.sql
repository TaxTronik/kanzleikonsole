-- Prisma's `now()` model default is materialized by the client. A small clock
-- skew between the application host and PostgreSQL can therefore make a newly
-- created PoA appear newer than the DB-generated `sent_at`, blocking an
-- immediate DRAFT -> SENT transition. Both timestamps must use the DB clock.
ALTER TABLE "power_of_attorney"
  ALTER COLUMN "created_at" SET DEFAULT statement_timestamp();
