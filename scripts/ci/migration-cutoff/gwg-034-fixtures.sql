-- Fachkatalog: GWG-ACTIVATION-GATE-001
--
-- Altbestand unmittelbar vor 20260801003400_gwg_fail_closed_and_destruction
-- (Cutoff 20260801003300_invoice_storno_unique): ein als VERIFIED gefuehrter
-- GwG-Check ohne die spaeter verlangten Identifizierungsangaben und ein
-- aktiv geschalteter Mandant. Migration 034 muss diesen Stand fail-closed
-- beenden (siehe gwg-034-asserts.sql).
INSERT INTO tenant (id, slug, name, updated_at)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  'upgrade-gwg-034',
  'Upgrade GwG 034 GmbH',
  CURRENT_TIMESTAMP
);

INSERT INTO client (id, tenant_id, kind, name, allow_active, updated_at)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'JURPERS',
  'Altbestand GmbH',
  FALSE,
  CURRENT_TIMESTAMP
);

INSERT INTO gwg_check (
  id, tenant_id, client_id, status, risk_level, risk_score,
  verified_at, valid_until, notes, updated_at
) VALUES (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'VERIFIED', 'MEDIUM', 10,
  CURRENT_TIMESTAMP - INTERVAL '1 day',
  CURRENT_TIMESTAMP + INTERVAL '5 years',
  'Alt-Snapshot', CURRENT_TIMESTAMP
);

INSERT INTO gwg_id_document (
  id, gwg_check_id, type, owner_name, number, issued_by, verified_at
) VALUES (
  '44444444-4444-4444-8444-444444444444',
  '33333333-3333-4333-8333-333333333333',
  'HANDELSREGISTERAUSZUG', 'Erika Altbestand', 'ALT-123',
  'Registerstelle', '2025-01-01'
);

INSERT INTO gwg_beneficial_owner (
  id, gwg_check_id, full_name, birth_date, residence, ownership_pct
) VALUES (
  '55555555-5555-4555-8555-555555555555',
  '33333333-3333-4333-8333-333333333333',
  'Max Altbestand', '1980-01-01', 'Berlin', 100.00
);

UPDATE client
   SET allow_active = TRUE, updated_at = CURRENT_TIMESTAMP
 WHERE id = '22222222-2222-4222-8222-222222222222';
