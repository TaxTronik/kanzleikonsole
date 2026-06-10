# Technische Modulbeschreibung: Audit-Protokollierung

## Zweck

Manipulationsevidente Protokollierung aller compliance-relevanten Aktionen
(GoBD-Nachvollziehbarkeit/Unveränderlichkeit) als SHA-256-Hash-Chain mit
täglicher RFC-3161-Versiegelung und unveränderlicher Langzeit-Archivierung.

## Mechanik (packages/evidence)

1. `record()` schreibt append-only in `audit_log`:
   `this_hash = SHA-256(prev_hash ‖ canonical_json(event))`, serialisiert
   pro Tenant via Advisory-Lock, **in derselben Transaktion wie die
   Fachoperation** (kein Event ohne Daten, keine Daten ohne Event).
2. Kanonisierung deterministisch (`canonical-json.ts`, BigInt/Decimal-
   Normalisierung); IP/User-Agent bewusst außerhalb des Hashes.
3. Tagesversiegelung (`sealDay`): RFC-3161-Zeitstempel über den
   Tages-Spitzen-Hash in `audit_seal` (idempotent, Backfill verpasster Tage).
4. `verifyChain()` rechnet jede Zeile nach (cursor-basiert, 1000er-Chunks)
   und prüft Versiegelungen kryptografisch (pkijs) gegen den
   **rekonstruierten** Spitzen-Hash; `requireExternalTsa` macht
   Self-Timestamps in Produktion zum Verstoß.
5. Wöchentliche Archiv-Rotation: deterministische NDJSON-Segmente in den
   GOBD-Bucket (Object-Lock COMPLIANCE 10 J.), Segment-Verifikation mit
   derselben Hash-Funktion (keine Record/Verify-Drift).

## Betrieb / Oberflächen

- Worker: `evidence-seal` (02:30 UTC), `audit-verify-check` (02:45 UTC,
  persistiert Ergebnis als `tenant_setting`, Notification an Admins bei
  Bruch), `audit-rotate` (So 03:00 UTC). HARD-Mode (DB-Kürzung) bewusst
  nicht implementiert.
- Admin-UI: Status-Karte (nur persistiertes Ergebnis — kein Chain-Walk im
  Render-Pfad; einzige Ausnahme: Einzel-Hash-Nachrechnung auf der
  Detailseite), Filter/Detail mit before/after, manueller Prüf-Trigger
  (selbst auditiert), CSV-Export (ratenlimitiert, gekappt, auditiert, inkl.
  Hashes), zeitlich begrenzter Prüfer-Link (HMAC, nur Chain-Attestierung,
  kein Datenzugriff).
- TSA-Konfiguration je Tenant (Anbieterkatalog inkl. eIDAS-qualifizierter;
  SSRF-Check auf Custom-URLs); Auflösung Tenant → ENV → Self-Timestamp.
- CLI `pnpm verify:chain` (alle Tenants + Archiv-Segmente, Exit-Codes für CI).

## Traceability

| Anforderung | Implementierung | Test |
|---|---|---|
| Ketten-Integrität + Bruch-Erkennung | chain/service | `hash-chain.test.ts`, `service-verifychain.test.ts` |
| Record==Verify für alle Werttypen | canonical-json/chain | `chain.test.ts`, `canonical-json.test.ts` |
| RFC-3161 kryptografisch korrekt | rfc3161-verify | echtes Fixture + synthetische Negativ-CA + Differenztest gegen `openssl ts` |
| Versiegelungs-Backfill | evidence-seal-Worker | `evidence-seal.test.ts` |
| Archiv-Segmente unveränderlich + verifizierbar | audit-rotate | `archive.test.ts`, `audit-rotate.test.ts` |
| Jede record-Action hat ein Label | labels.ts | `audit-label-coverage.test.ts` (AST-Guard) |
| Restore-Beweis auf wiederhergestellter DB | backup-drill + restore-selftest | CI-Job `restore` + Drill-E2E (verifiziert 2026-06-10) |

## Bekannte Grenzen

`audit_log` wächst unbegrenzt (SOFT-Rotation behält DB-Zeilen); Prüfer-Link
nur global widerrufbar; `audit-verify-check` prüft TSA-Policy gegen die
ENV-/Default-TSA (bewusst — verify validiert nur).
