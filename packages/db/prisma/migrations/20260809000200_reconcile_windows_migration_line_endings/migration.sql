-- Forward-only convergence for exact CRLF checksums written by historical
-- Windows checkouts before all SQL migrations were pinned to LF.

BEGIN;

CREATE TEMP TABLE known_windows_migration_eol (
  migration_name TEXT PRIMARY KEY,
  crlf_checksum TEXT NOT NULL,
  canonical_checksum TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO known_windows_migration_eol (
  migration_name,
  crlf_checksum,
  canonical_checksum
)
VALUES
  ('20260801001900_iter94_appeal_deadline_fix', '31ec0063959bb307ff46ebefaf1f6c5b1dd76281e6205992d14b13d8f257f0e7', 'd76cf7fa1223cca2ea99b62ea9d2ad25c9feda14370fa12ad77760007bb56ddd'),
  ('20260801002000_iter95_tax_notice_received_at', '165e54f880eebb0603db75665b5faabec7c2addc5b71c9b4a52e35e524015168', 'd1818386c9493739225e5e71f07542c62ff51b5d93b79accacc35250653b739d'),
  ('20260801002100_iter96_elster_kontoabfrage', '20d3e436313c688d4b6de14a04b6a7abd4a0eededd2f1446979ff92f38feea6d', '9c37d9206289184f8581ffa90b6b5947dc0f9dbfddb0ea1f799ad627cdfc3b8a'),
  ('20260801002300_iter98_invoice_service_period', '6217477a6cc93b9d0ff83509154f14fa4e9bbbb8cd8669244fc6d18f1588b899', 'f2e5e5ca024d91bdbf614e2d3c5b5f0c7c103ff043bf692663d09dd898ff0963'),
  ('20260801002400_iter99_notice_klage', 'effe9dafcd86e9bc5e78c327ec56981f616ea236ea01be9e5b03786313814452', 'c3d522da884b845f7c6bc85741e7490e02b97cf53c085b1cc8d501990460cc76'),
  ('20260801002500_iter100_invoice_storno', 'c74afe7a0987442ca730fdef886a3d85376ddc2bf06d8bee5e02bff09b2bee37', '9b4d1d695a436b415ec7af341494b3c90ec55751a9d7285b7d337c103cc8fc32'),
  ('20260801002600_iter101_invoice_vat_exemption', 'e37466f7e5b98bb481886e1bf66204cc4d0aad7b8992a610a36d8de105d5084c', '99c9e372f2a9e45d77b4da28ceb2c5ce7c2d2d56fa8d38c76f54291560df450b'),
  ('20260801002700_iter102_invoice_gob_freeze_extend', '843260ea328d68e4ac544899ed186d66cf1f5f201a8d48c7a38e5b99034682e4', '9cf7c20e45a181a0e1c608233e52ca4e3fce06084535589fe7eeff616824b6c0'),
  ('20260801003600_poa_signing_snapshot', '225753c9c03bd05c717f7e0f151a7ac2ed1db87c75f86b3de4e3e6a13e3b1dfa', '94d412607abcca7ef88748dd75629821398369f01acbcc6e2f13c92518923d1d'),
  ('20260801003700_n8n_workflow_routes', 'fca7f51d9eb02387fb20ee8c3319564ec3f0dc06bf9487a32f187cd4d51d0394', 'a7ab046abe92205f430202af01e0a0f955ad074eeb696a08842864102bf83387'),
  ('20260801003800_n8n_callback_receipts', 'ab8a651682b04d771320c8a628047bee8e24721d84f483afc857600edd53c303', '9ea34ff62642812abd7141b85b3f48df5973b25db0f1e69d390b85f50a2a611a'),
  ('20260801003900_n8n_delivery_ops_index', '6ac5ada54eadc5d9e19a2777b77ec5aa7354eefdf04fe012a31cda99c9bb2f94', 'f7af0aef8e6d3a15344651c13869e7eebf8ea7a40e36b12e27257a29fdbf79d1'),
  ('20260801004000_poa_created_at_db_clock', '169c5c5afd6dcc18d08cf9122a00e6553bce268005f462a01e9a43fe9557e605', '5b7441b7eb0d3148a6e4418fbdc61df8a7730cf856fa5f2cf27e3276228a89d1');

DO $windows_eol_attestation$
DECLARE
  invalid_rows TEXT;
BEGIN
  SELECT string_agg(known.migration_name, ', ' ORDER BY known.migration_name)
    INTO invalid_rows
    FROM known_windows_migration_eol AS known
    LEFT JOIN public._prisma_migrations AS ledger
      ON ledger.migration_name = known.migration_name
     AND ledger.finished_at IS NOT NULL
     AND ledger.rolled_back_at IS NULL
   WHERE ledger.migration_name IS NULL
      OR ledger.checksum NOT IN (known.crlf_checksum, known.canonical_checksum);

  IF invalid_rows IS NOT NULL THEN
    RAISE EXCEPTION 'Unknown or missing Windows migration ledger state: %', invalid_rows
      USING ERRCODE = 'data_exception';
  END IF;
END;
$windows_eol_attestation$;

UPDATE public._prisma_migrations AS ledger
   SET checksum = known.canonical_checksum
  FROM known_windows_migration_eol AS known
 WHERE ledger.migration_name = known.migration_name
   AND ledger.checksum = known.crlf_checksum
   AND ledger.finished_at IS NOT NULL
   AND ledger.rolled_back_at IS NULL;

DO $windows_eol_convergence$
DECLARE
  invalid_rows TEXT;
BEGIN
  SELECT string_agg(known.migration_name, ', ' ORDER BY known.migration_name)
    INTO invalid_rows
    FROM known_windows_migration_eol AS known
    LEFT JOIN public._prisma_migrations AS ledger
      ON ledger.migration_name = known.migration_name
     AND ledger.finished_at IS NOT NULL
     AND ledger.rolled_back_at IS NULL
   WHERE ledger.migration_name IS NULL
      OR ledger.checksum <> known.canonical_checksum;

  IF invalid_rows IS NOT NULL THEN
    RAISE EXCEPTION 'Windows migration checksums did not converge to LF: %', invalid_rows
      USING ERRCODE = 'data_exception';
  END IF;
END;
$windows_eol_convergence$;

COMMIT;
