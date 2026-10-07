-- ACCESS-TENANT-RLS-001 (Rolle taxtronik_app aus 20260510000000_init).
--
-- Review-Finding F-06: lock_timeout fuer die App-Rolle.
--
-- Bisher wartete eine Anfrage der App-Rolle beliebig lange auf eine Sperre,
-- gedeckelt nur durch den statement_timeout des App-Pools (20 s) und das
-- Transaktionslimit TX_OPTIONS.timeout (15 s). Jede wartende Anfrage haelt
-- dabei eine Verbindung des App-Pools; haengt eine lange Transaktion etwa an
-- der Audit-Sperre eines Tenants (pg_advisory_xact_lock je Audit-Eintrag),
-- stauen sich alle schreibenden Requests dieses Tenants und erschoepfen den
-- Pool auch fuer alle anderen.
--
-- Neu: lock_timeout = 5s fuer jede Verbindung von taxtronik_app zu dieser
-- Datenbank. Der Wert entspricht TX_OPTIONS.maxWait (5 s Warten auf eine
-- Pool-Verbindung) und liegt unter TX_OPTIONS.timeout (15 s) und dem
-- statement_timeout des App-Pools (20 s): Eine Sperre, die nach 5 s noch
-- fehlt, endet als eigener Fehler (SQLSTATE 55P03 lock_not_available) statt
-- als allgemeiner Transaktions- oder Statement-Timeout. In der Compose-
-- Installation protokolliert Postgres Wartezeiten ueber 1 s bereits
-- (log_lock_waits, deadlock_timeout).
--
-- Bewusst nicht gesetzt:
--   - taxtronik_owner: Die Wartungsjobs des Workers (z. B. audit-rotate,
--     dsgvo-retention, Restore-Drill) laufen ueber die Owner-Rolle mit
--     laengeren Transaktionen; eine kurze Sperrfrist koennte laufende Wartung
--     abbrechen. Ihr Verhalten bleibt unveraendert.
--   - Migrationsrolle taxtronik (Superuser): Migrationen duerfen warten.
-- Ein App-Pfad, der laenger warten muss, kann `SET LOCAL lock_timeout` setzen.
--
-- Datenbankbezogen (IN DATABASE): Die Einstellung gilt nur fuer diese
-- Datenbank, nicht fuer weitere Datenbanken desselben Clusters. Sie liegt in
-- pg_db_role_setting und ist nicht Teil des pg_dump; nach einem Restore in
-- einen neuen Cluster ist sie neu zu setzen (docs/operations/disaster-
-- recovery.md).
BEGIN;

DO $app_lock_timeout$
BEGIN
  EXECUTE format(
    'ALTER ROLE taxtronik_app IN DATABASE %I SET lock_timeout = %L',
    current_database(),
    '5s'
  );
END
$app_lock_timeout$;

COMMIT;
