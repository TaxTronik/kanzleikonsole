# Technische Modulbeschreibung: Audit-Protokollierung

## Zweck

Manipulationsevidente Protokollierung aller compliance-relevanten Aktionen
(GoBD-Nachvollziehbarkeit/Unveränderlichkeit) als vollständige lokale
SHA-256-Hash-Chain plus gekoppelter externer RFC-3161-Anchor-Kette,
Tagesversiegelung und unveränderlicher Langzeit-Archivierung.

## Mechanik (packages/evidence)

1. `record()` schreibt append-only in `audit_log`:
   `this_hash = SHA-256(prev_hash ‖ canonical_json(event))`, serialisiert
   pro Tenant via Advisory-Lock, **in derselben Transaktion wie die
   Fachoperation** (kein Event ohne Daten, keine Daten ohne Event).
2. Kanonisierung deterministisch (`canonical-json.ts`, BigInt/Decimal-
   Normalisierung); IP/User-Agent bewusst außerhalb des Hashes.
3. Rolling-Verankerung (`anchorLatest`): Der Worker stempelt außerhalb der
   Fachtransaktion einen committeten Präfix. Der Anchor-Payload bindet lokalen
   ID-Bereich, rekonstruierten Spitzen-Hash und vorheriges TSA-Token; ein
   bedingtes Insert plus Unique-Constraint auf Tenant/Vorgänger-Hash verhindert
   Zweige auch bei parallelen Läufen mit demselben MVCC-Snapshot.
4. Tagesversiegelung (`sealDay`): RFC-3161-Zeitstempel über den
   Tages-Spitzen-Hash in `audit_seal` (idempotent, Backfill verpasster Tage).
5. `verifyChain()` rechnet jede Zeile nach (cursor-basiert, 1000er-Chunks)
   und prüft Anchor-Kette und Tagesversiegelungen kryptografisch (pkijs) gegen den
   **rekonstruierten** Spitzen-Hash; `requireExternalTsa` macht
   Self-Timestamps in Produktion zum Verstoß.
6. Wöchentliche Archiv-Rotation: deterministische NDJSON-Segmente in den
   GOBD-Bucket (Object-Lock COMPLIANCE 10 J.), Segment-Verifikation mit
   derselben Hash-Funktion (keine Record/Verify-Drift). Vorhandene externe
   RFC-3161-Tokens werden gegen den tatsächlichen Datei-Hash und konfigurierte
   Trust-Roots geprüft; ein fehlender Token bleibt sichtbar, statt als
   erfolgreicher TSA-Nachweis zu gelten.

## Betrieb / Oberflächen

- Worker: `audit-anchor` (alle 2 Sekunden, Rechnung/GwG bevorzugt, Backoff),
  `evidence-seal` (02:30 UTC), `audit-verify-check` (02:45 UTC,
  persistiert Ergebnis als `tenant_setting`, Notification an Admins bei
  Bruch **und bei einer Exception des Prüflaufs**), `audit-rotate` (So 03:00 UTC). HARD-Mode (DB-Kürzung) bewusst
  nicht implementiert.
- Admin-UI: getrennte Status-Karten für lokalen Verify und externen
  Anchor-Rückstand (Auto-Refresh; kein Chain-Walk im
  Render-Pfad; einzige Ausnahme: Einzel-Hash-Nachrechnung auf der
  Detailseite), Filter/Detail mit before/after, manueller Prüf-Trigger
  (selbst auditiert), CSV-Export (ratenlimitiert, gekappt, auditiert, inkl.
  Hashes), zeitlich begrenzter Prüfer-Link (HMAC, nur Chain-Attestierung,
  kein Datenzugriff).
- TSA-Konfiguration je Tenant (kostenlose und kommerzielle Presets; keine
  pauschale Qualifikationszusage allein aus dem Anbieternamen; SSRF-Check auf
  Custom-URLs); Auflösung Tenant → ENV → GlobalSign-Default.
  Statusprüfung und Worker verwenden dieselbe Auflösung. In Produktion gibt es
  keinen stillen Self-Timestamp-Fallback. Nicht-GlobalSign-Anbieter benötigen
  ihren Betreiber-Trust-Anchor über `TSA_TRUSTED_ROOTS_FILE`.
- CLI `pnpm verify:chain` (alle Tenants + Archiv-Segmente, Exit-Codes für CI).

## Traceability

Die zentrale Ansicht und ihr CSV-Export teilen Kategorien, Sortierung nach
Audit-ID und Datumsfilter in `server/audit/query.ts`. Kategorien sind rein
abgeleitet; historische Ereignisse und Hashes werden nicht umgeschrieben.
Unbekannte Actions bleiben unter „Sonstige“ sichtbar. Berliner Tagesgrenzen
werden inklusive Beginn und exklusiv bis zur nächsten Mitternacht ausgewertet,
auch an Zeitumstellungstagen. Der CSV-Auszug ist bei Filtern keine vollständige
Hash-Kette. Die Berechtigung bleibt auf ADMIN/PARTNER begrenzt.

Die Seitendatei prüft zuerst die Berechtigung und komponiert anschließend
getrennte Daten-, Filter-, Tabellen- und Statusbausteine. `audit-page-data.ts`
bündelt alle Reads in demselben Tenantkontext; `audit-page-state.ts` hält
Filtervalidierung, Cursorbildung und die Zuordnung des persistierten
Prüfergebnisses. `audit-chain-status.tsx` stellt ungeprüfte, intakte,
historisch abgegrenzte und neue negative Befunde getrennt dar. Die
Server-Actions und die Hash-/Ankerprüfung bleiben unverändert.

Der Gesamtzähler ist auch ungefiltert ein exakter, explizit tenantgebundener
Count. Die frühere `pg_class.reltuples`-Schätzung zählte die gesamte Tabelle
und konnte Bestände anderer Kanzleien in der Anzeige offenlegen. Seitenliste,
Ressourcenfilter und Count setzen den Tenant zusätzlich zum RLS-Kontext.
Count und CSV-Auswahl bleiben cursorfrei; Pagination verwendet weiterhin
50 sichtbare Zeilen plus eine Probezeile. Der vorhandene
`audit_log_tenant_id_id_idx` unterstützt die Tenantbegrenzung; der Count muss
trotzdem den sichtbaren Bestand des Tenants zählen und kann bei großen Logs
aufwendiger werden. Es gibt keine neue Vollkettenprüfung im Renderpfad.
`page.test.tsx` belegt die Scopekorrektur, Rollenprüfung, Filter-/Cursorverträge
und gerenderte Statusübergänge mit simulierten DB-Grenzen
(`AUDIT-HASH-CHAIN-001`, `ACCESS-TENANT-RLS-001`, `AUDIT-VERIFY-ALERT-001`).

Die historische Einordnung der Statuskarte verlangt den persistierten
`recovered`-Wert; ein Checkpoint allein verdeckt keinen neu gemeldeten Fehler.
Bei einem historischen Hash-/Link-Bruch verifiziert der Worker die Teilkette
ab dem konkreten Checkpoint. Bei einer Tail-Truncation gilt nur ein nach dem
negativen Ergebnis auditierter Checkpoint als neue Vergleichsbasis. Einmal
beobachtete lokale und externe Spitzen-IDs werden auch bei Schrumpf, frühem
Kettenabbruch oder Lauf-Exception monoton erhalten (`AUDIT-VERIFY-ALERT-001`).

| Anforderung                                                                | Implementierung                 | Test                                                                        |
| -------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| Ketten-Integrität + Bruch-Erkennung                                        | chain/service                   | `hash-chain.test.ts`, `service-verifychain.test.ts`                         |
| Record==Verify für alle Werttypen                                          | canonical-json/chain            | `chain.test.ts`, `canonical-json.test.ts`                                   |
| RFC-3161 kryptografisch korrekt                                            | rfc3161-verify                  | echtes Fixture + synthetische Negativ-CA + Differenztest gegen `openssl ts` |
| Gekoppelte Rolling-Anchor-Kette ohne Zweige                                | anchor/service + audit-anchor   | `anchor.test.ts`, `service-anchor.test.ts`, `service-verifychain.test.ts`   |
| Backfill fehlender Tages-Seals (kein Restamp bestehender `NULL`-Zeilen)    | evidence-seal-Worker            | `evidence-seal.test.ts`                                                     |
| Archiv-Segmente unveränderlich; TSA-Token geprüft oder fehlend ausgewiesen | audit-rotate + verify:chain     | `archive.test.ts`, `audit-rotate.test.ts`                                   |
| Jede record-Action hat ein Label                                           | labels.ts                       | `audit-label-coverage.test.ts` (AST-Guard)                                  |
| Restore-Beweis auf wiederhergestellter DB                                  | backup-drill + restore-selftest | CI-Job `restore` + Drill-E2E (verifiziert 2026-06-10)                       |
| Monotone Spitzen, Recovery-Abgrenzung und Exception-Alarm                  | audit-verify-check              | `audit-verify-check.test.ts` (`AUDIT-VERIFY-ALERT-001`)                     |

## Bekannte Grenzen

`audit_log` wächst unbegrenzt (SOFT-Rotation behält DB-Zeilen); Prüfer-Link
nur global widerrufbar; `audit-verify-check` prüft TSA-Policy gegen die
ENV-/Default-TSA (bewusst — verify validiert nur).
