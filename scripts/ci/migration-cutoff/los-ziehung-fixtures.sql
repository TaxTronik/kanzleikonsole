-- Fachkatalog: TCMS-SAMPLE-PROOF-001
--
-- Historische Los-Ziehungen unmittelbar vor
-- 20261012100000_risk_los_ziehung (Cutoff
-- 20261007160200_portal_inbox_staff_search_candidates): Bis dahin standen sie
-- ausschliesslich im Audit-Log. Die Migration muss jede Ziehung mit
-- vollstaendigem Nachweis genau einmal uebernehmen, unvollstaendige Ereignisse
-- und andere Aktionen nicht (siehe los-ziehung-asserts.sql).
SET TIME ZONE 'UTC';

INSERT INTO tenant (id, slug, name, updated_at)
VALUES
  ('10000000-0000-4000-8000-000000001500', 'los-ziehung-w15', 'Los-Ziehung Welle 15', CURRENT_TIMESTAMP),
  ('10000000-0000-4000-8000-000000001501', 'los-ziehung-w15-b', 'Los-Ziehung Welle 15 B', CURRENT_TIMESTAMP);

INSERT INTO audit_log (id, tenant_id, occurred_at, actor_type, actor_id, action, resource_type, resource_id, after, prev_hash, this_hash)
VALUES
  -- Alt-Ereignis vor der Audit-Nachschau: ohne rahmenTyp (= subsumtion), mit Aufgaben.
  (9150001, '10000000-0000-4000-8000-000000001500', '2026-06-10 08:00:00+00', 'STAFF',
   '20000000-0000-4000-8000-000000001500', 'risk.los.gezogen', 'quantenlos', 'c0ffee',
   '{"nachweis":{"protokoll_version":1,"gezogen_am":"2026-06-10T08:00:00Z","rahmen":{"commitment":"c0ffee","n":3},"k":2,"stichprobe":["a1","c3"],"entropie":{"quelle_klasse":"csprng","backend":"csprng"},"ableitung":{"extraktor":"sha256-vn","drbg":"hmac-drbg-sha256"}},"rahmen":["a1","b2","c3"],"zeitraum":{"von":"2026-05-01","bis":"2026-05-31"},"reviewAufgaben":["30000000-0000-4000-8000-000000001500"],"attemptId":"40000000-0000-4000-8000-000000001500"}',
   '\x00', '\x01'),
  -- Betriebs-Nachschau (rahmenTyp audit) aus einem abgeholten QPU-Job.
  (9150002, '10000000-0000-4000-8000-000000001501', '2026-07-01 09:30:00+00', 'STAFF',
   '20000000-0000-4000-8000-000000001501', 'risk.los.gezogen', 'quantenlos', 'beef',
   '{"nachweis":{"protokoll_version":1,"gezogen_am":"2026-07-01T09:30:00Z","rahmen":{"commitment":"beef","n":2},"k":1,"stichprobe":["17"],"entropie":{"quelle_klasse":"qpu","backend":"ibm_test","job_id":"ibm-job-15"},"ableitung":{"extraktor":"sha256-vn","drbg":"hmac-drbg-sha256"}},"rahmen":["17","18"],"zeitraum":{"von":"2026-06-01","bis":"2026-06-30"},"rahmenTyp":"audit","reviewAufgaben":[],"jobId":"ibm-job-15"}',
   '\x01', '\x02'),
  -- Ohne Nachweis: zeigte die Liste nie an, bleibt nur im Audit-Log.
  (9150003, '10000000-0000-4000-8000-000000001500', '2026-07-02 10:00:00+00', 'STAFF',
   '20000000-0000-4000-8000-000000001500', 'risk.los.gezogen', 'quantenlos', 'kaputt',
   '{"rahmen":["a1"]}', '\x02', '\x03'),
  -- Beantragung (wartender QPU-Job): keine Ziehung.
  (9150004, '10000000-0000-4000-8000-000000001500', '2026-07-03 11:00:00+00', 'STAFF',
   '20000000-0000-4000-8000-000000001500', 'risk.los.beantragt', 'quantenlos', 'beef',
   '{"jobId":"ibm-job-15","backend":"ibm_test","k":1,"n":2}', '\x03', '\x04');
