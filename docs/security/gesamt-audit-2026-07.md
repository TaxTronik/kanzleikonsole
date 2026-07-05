# Gesamt-Audit: Quality, Security, Tests (Repo-weit)

**Datum:** 2026-07-05 · **Methodik:** vier unabhängige adversariale
Code-Reviews (Security Web/Worker · Codequalität Web/Worker ·
Packages/Krypto/DB · Teststrategie/CI), jeder Befund am Code verifiziert
(Datei/Zeile), keine Vermutungen aus Dateinamen. Zusätzlich Basis-Checks
lokal ausgeführt: Typecheck ✓, Lint ✓, Unit-Tests ✓ (nach Fix, s. u.).

## Gesamtergebnis

Die Codebasis ist **deutlich überdurchschnittlich gehärtet und getestet**:
konsequente Guard-/Action-Patterns, RLS mit FORCE + Drift-Gate, fail-closed
Rate-Limits und Scans, Outbox-/Idempotenz-Mechanik im Worker, sieben
CI-Guards, gitleaks/Trivy/pnpm-audit-Gates, SHA-gepinnte Actions.
Keine kritischen Befunde. ERiC-/IDW-Vertraulichkeitsregeln sind eingehalten
und CI-abgesichert; `packages/elster` enthält keine ERiC-Interna.

Die **dringendsten Befunde sind fachlich, nicht technisch**: zwei gesetzlich
falsche Steuerfristen in `packages/tax` (GewSt-VZ, LSt-Jahresanmeldung).

## Vorab behoben (dieses Audit)

Die Suite `poa/__tests__/actions.test.ts` schlug lokal beim Import fehl:
`poa/actions.ts` importiert das echte `@taxtronik/storage`, das seine per
`injectWorkspacePackages` injizierte `@taxtronik/config`-Kopie lädt — ein
anderer Modulpfad, den `vi.mock('@taxtronik/config')` nicht abdeckt; deren
ENV-Validierung wirft ohne vollständige ENV. In CI kaschieren global gesetzte
ENV-Variablen das Problem (der Test war dort nie hermetisch). **Fix:**
`@taxtronik/storage` wird im Test gemockt (Muster der übrigen Mocks).
Verwandter DX-Befund: siehe I-1.

## Befunde: Hoch

| # | Befund | Ort | Empfehlung |
|---|--------|-----|------------|
| H-1 | **GewSt-Vorauszahlung mit falschen Fälligkeiten**: `GEWST_VZ` läuft im ESt/KSt-Zweig (10.03./10.06./10.09./10.12.). § 19 Abs. 1 GewStG schreibt **15.02./15.05./15.08./15.11.** vor. Dashboard zeigt Q1 ~3–4 Wochen zu spät → Säumniszuschläge (§ 240 AO). Fehler ist durch Test zementiert (`engine.test.ts:235`). | `packages/tax/src/engine.ts:76-89` | Eigener `GEWST_VZ`-Zweig mit 15er-Terminen; Test korrigieren. |
| H-2 | **LSt-Jahresanmeldung im Erklärungs-Zweig**: `LSTA_JAEHRLICH` erhält 31.07. des Folgejahres (bzw. beraten Ende Februar des zweiten Folgejahres). § 41a Abs. 1 EStG: **10. Januar des Folgejahres**; § 149 Abs. 3 AO gilt für Anmeldungen nicht. Frist wird ~7 Monate zu spät angezeigt (§ 152 AO). Kein Test deckt den Fall ab. | `packages/tax/src/engine.ts:91-107` | Eigener Zweig „10.01. Folgejahr", `advised` dort ignorieren; Test ergänzen. |
| H-3 | **Voll-Chain-Verifikation im Render-Pfad von `/staff/admin`**: `evidenceService.verifyChain(tx, …)` läuft bei jedem Render in der Default-Transaktion (5-s-Timeout); `AutoRefresh` schließt nur `/staff/admin/audit` aus → offener Admin-Tab feuert den SHA-256-Walk alle 30 s. Wachsender Log → P2028, `.catch(() => null)` verschluckt es, Chain-Status verschwindet kommentarlos; Dauer-DB-Last. Auf der Audit-Seite wurde exakt diese Bugklasse bereits behoben (P-1). | `apps/web/src/app/staff/(protected)/admin/page.tsx:60`, `components/auto-refresh.tsx:22` | Persistiertes `AUDIT_VERIFY_RESULT_SETTING_KEY`-Ergebnis lesen (wie Audit-Seite). |
| H-4 | **Terminzeiten ohne Zeitzone in Mails/Notifications**: `startsAt.toLocaleString('de-DE', …)` ohne `timeZone` — Container laufen UTC (kein `TZ` in `infra/`). 14:00-Termin (Berlin) wird als „12:00" bestätigt. | `apps/web/src/app/staff/(protected)/calendar/actions.ts:304,323` | `fmtDateTimeShort`/`fmtDateTimeMedium` aus `lib/fmt.ts` (Europe/Berlin fest) verwenden. |
| H-5 | **`packages/storage` hat null Tests, Script täuscht Erfolg vor** (`"test": "echo 'Keine Tests'"`): enthält die **§ 147-AO-Aufbewahrungsfristberechnung** (Retain-Until für Object-Lock, inkl. Kommentar über früheren ~9,5-statt-10-Jahre-Bug). CI-Object-Lock-Check prüft nur Bucket-Konfig, nicht die berechneten Daten. | `packages/storage/package.json`, `src/service.ts` | Unit-Tests für Fristberechnung (Jahresende, Schaltjahre, Tier-Zuordnung); Echo-Script ersetzen. |
| H-6 | **~97 feste Sleeps in der Paranoid-E2E-Suite + `retries: 2`**: `07-compliance.spec.ts` (59× `waitForTimeout`), `06-actions.spec.ts` (35×) u. a. — Race-Conditions werden dreimal gewürfelt statt abgewartet; ausgerechnet die als Compliance-Nachweis archivierte Suite ist die flakigste (>3 Min. reine Wartezeit). | `apps/e2e/tests/07-compliance.spec.ts` u. a.; `playwright.config.ts:45` | Sleeps durch `expect(...).toBeVisible()`/`waitForResponse`/`toPass()` ersetzen, dann Retries senken. |

## Befunde: Mittel

| # | Befund | Ort | Empfehlung |
|---|--------|-----|------------|
| M-1 | **Vertraulich-/`RESTRICTED`-Ventil greift bei mutierenden Server-Actions nicht**: Der Pro-Mandant-Zugriffscheck (`canAccessClient`) hängt allein am Seiten-Layout; Server-Actions sind direkt aufrufbare POSTs und laufen nicht durch den Layout-Guard. Von 16 Action-Modulen unter `clients/[id]/**` prüft nur `subsumtion/` den Zugriff; die übrigen (edit, gwg, bwa, billing, contacts, requests, notices, handovers, reminders, change-requests, binders, tax-schedule, workflows …) verlassen sich auf `staffActionGuard()` + RLS (scoped nur Tenant, nicht Vertraulichkeit). Ein nicht-zuständiger Mitarbeiter derselben Kanzlei kann Daten vertraulicher Mandanten mutieren. Kein Cross-Tenant-Leak. | `apps/web/src/server/actions/staff-action.ts:56-110`; `clients/[id]/layout.tsx:38` | In mutierenden Actions serverseitig `clientId` ermitteln und `requireClientAccess` aufrufen (Muster `subsumtion/actions.ts`). |
| M-2 | **Evidence: Tail-Truncation nach letztem Seal unentdeckt**: Löschen des unversiegelten Suffixes (laufender Tag) hinterlässt konsistente Kette → `ok: true`. DB-Härtung (Trigger, REVOKE) mildert, schützt nicht gegen Owner/Superuser. | `packages/evidence/src/service.ts:296-348` | `checked`-Zähler des letzten Verify-Ergebnisses als Monotonie-Anker prüfen (Schrumpfen = Alarm). |
| M-3 | **~20 unindizierte Foreign Keys**: u. a. 6 Tabellen referenzieren `document.id` ohne Index (Absence, GwgIdDocument, Invoice, RequestResponse, TaxFiling, TaxNotice); ferner Request.formSubmissionId, WorkflowInstance.templateId, diverse tenantId-lose Einzel-FKs. DELETE/Reverse-Lookups skalieren linear — bei 10-Jahres-GoBD-Beständen relevant. | `packages/db/prisma/schema.prisma` (Details im Audit-Verlauf) | `@@index([documentId])` bzw. `(tenantId, fk)`-Kompositindizes ergänzen. |
| M-4 | **Worker-Crash über async `failed`-Handler**: `n8nDeliverWorker.on('failed', async …)` schreibt in die DB; wirft das Update (DB down — der wahrscheinlichste Fail-Grund), wird es eine unhandled Rejection → `process.exit(1)`. Ein DB-Ausfall reißt den ganzen Worker um. | `apps/worker/src/jobs/n8n-deliver.ts:216-223` | try/catch im Handler, nur loggen. |
| M-5 | **Audit-Verify-Polling: Single-Slot-Ergebnis** — nächtlicher Lauf/zweiter Trigger überschreibt `requestId`, `done` wird nie true; UI gibt nach 5 min still auf („Ergebnis erscheint hier …" bleibt stehen). | `apps/worker/src/jobs/audit-verify-check.ts:125-129`; `api/staff/admin/audit/verify-status/route.ts:37`; `audit-verify-auto-refresh.tsx:41` | Status-Endpoint: `done` auch bei neuerem `checkedAt` als Trigger-Zeitpunkt; Poll-Timeout sichtbar machen. |
| M-6 | **`verifyRecoverySegment` weiter im Render-Pfad** der Audit-Seite, Fehler verschluckt — dieselbe P-1-Bugklasse kehrt ab Checkpoint schleichend zurück. | `admin/audit/page.tsx:134-142` | In den Worker-Lauf verlagern und persistieren. |
| M-7 | **Zeitzonen-Migration unvollständig**: tz-naive `toLocale*`-Reststellen in SSR-gerenderten Client-Komponenten (stammdaten-forms.tsx:148, research-view.tsx:112, subsumtion-workspace.tsx:474, office-viewer.tsx:196, billing-form.tsx:18) und serverseitig (to-pdf.ts:72, to-docx.ts:16, phone-notes/actions.ts:299) → Hydration-Drift bzw. Off-by-one-Tag 00:00–02:00 Berlin. | diverse (s. links) | Restliche Aufrufe auf `fmtDate*` aus `lib/fmt.ts` migrieren. |
| M-8 | **Theme-Auflösung dreifach implementiert** (Bootstrap-Inline-Script, theme-toggle.tsx, quantenlos-panel.tsx mit eigenem Listener-Satz statt `THEME_EVENT`) — strukturelle Ursache der Dark-Mode-Fix-Commit-Serie; Persistenz asymmetrisch (`ui_mode` mit Cookie/SSR, `theme` nur localStorage). | `app/layout.tsx:36-39`; `components/theme-toggle.tsx:9-25`; `admin/quantenlos/quantenlos-panel.tsx:74-108` | Eine gemeinsame `resolveTheme()`/`applyTheme()` extrahieren, Bootstrap daraus generieren, `QuantenlosThemeSync` löschen. |
| M-9 | **`describe.skipIf` umgeht den Focused-Tests-Guard**: RFC-3161-Differenztest entfällt ohne openssl still; Guard matcht nur `.only|.skip|.fixme(`, nicht `skipIf`/`todo`/ternäre Skips. DB-Tests haben einen CI-Zwangs-Throw, der Evidence-Test nicht. | `packages/evidence/src/__tests__/rfc3161-differential.test.ts:78`; `scripts/check-no-focused-tests.sh:14` | Bei `CI=true` ohne openssl hart werfen; Guard-Pattern erweitern. |
| M-10 | **Worker-Job-Kerne ungetestet / wegmockt**: `audit-verify-check` (Hash-Chain-Wache!) ohne Test; Job-Tests (z. B. backup-drill) mocken ~12 Module und testen nur Helfer — Drill-Ablauf (Download→Restore→Vergleich) hat keinen Testpfad. | `apps/worker/src/jobs/**` | Verify-/Alarm-Logik als pure Funktion extrahieren und testen; Job-Handler mit In-Memory-Fakes einmal durchlaufen. |
| M-11 | **ops-lib.sh <10 % getestet**: ungetestet sind gerade die Deploy-kritischen Funktionen `sql_literal` (SQL-Escaping), `sync_postgres_roles_from_env`, `run_backup`/`run_restore`, `validate_cookie_domains_or_die`, `ensure_secret`. | `scripts/ops-lib.sh` vs. `scripts/tests/ops-lib.test.sh` | Mindestens `sql_literal`-Kantenfälle und Cookie-Domain-Validierung mit Tabellentests. |
| M-12 | **Backup/Restore nur Happy Path**: CI-Roundtrip ✓, aber kein Negativfall (korrupter Dump, Versions-Mismatch); `runner.ts`/`restore.ts` ohne Unit-Tests. TOTP-Replay-Schutz und Portal-Session-Auflösung nur indirekt getestet. | `apps/web/src/server/backup/`; `server/auth/totp-replay.ts` | restore-selftest um Negativfall erweitern; Replay-Unit-Test mit Fake-Redis. |

## Befunde: Niedrig (kompakt)

- **N-1** `packages/crypto/src/index.ts:91-95`: `decryptSecret` prüft IV-/Tag-Länge nicht (GCM akzeptiert Tags ab 4 Bytes → Forgery-Hürde senkbar bei DB-Schreibzugriff). Fix: `iv.length === 12 && tag.length === 16` erzwingen.
- **N-2** `packages/crypto`: Secret-Box-Key per HKDF aus `AUTH_SECRET` — Rotation macht gespeicherte Secrets undechiffrierbar, kein Re-Wrap-Pfad. Fix: dediziertes `SECRET_BOX_KEY` bzw. Key-Ring mit Key-ID im Blob.
- **N-3** `packages/evidence`: `verifyChain` meldet `ok` bei komplett leerer Kette (Tenant-Wipe fiele nicht auf). Fix: `checked=0` bei existierendem früheren Ergebnis als Bruch werten.
- **N-4** `packages/elster/client.ts:119-130`: Kontoabfrage ohne Laufzeit-Validierung (max. 75 etc.); `KontoabfrageTeilSchema` existiert, wird nicht angewandt — jeder Fehlversuch erzeugt einen Vorgang beim ELSTER-Server.
- **N-5** `packages/elster/client.ts:46`: Fehler-Body (potenziell Steuerdaten) landet ungefiltert in der Exception-Message → Logs.
- **N-6** `packages/storage`: 100-MB-Upload-Cap vs. clamd-Default `StreamMaxLength` 25 MB → Uploads >25 MB enden als `SCAN_ERROR` (fail-closed, aber funktional kaputt). clamd-Konfig dokumentieren/angleichen.
- **N-7** `packages/storage/src/service.ts:333-335`: `putObjectBytes` erzwingt `COMPLIANCE` unabhängig vom Tier — Konflikt mit eigener `lockModeForTier`-Regel (GwG → GOVERNANCE, § 8 Abs. 4 S. 4 GwG).
- **N-8** `packages/storage/src/service.ts:163-169`: ClamAV-Socket-Write ohne Backpressure (bis 100 MB gepuffert).
- **N-9** `packages/http-utils/index.ts:52-73`: IPv6-Blockliste ohne `ff00::/8`, Teredo, `2001:db8::/32` (Ausnutzbarkeit gering, aber fail-closed vervollständigen).
- **N-10** `packages/http-utils/index.ts:263-298`: undici-Agent-Leak, wenn Response-Body nie konsumiert wird.
- **N-11** `packages/db/prisma/migrations`: iter77–92 auf August 2026 vordatiert, iter81 ohne sprechenden Namen — Ordnungs-/Kollisionsrisiko.
- **N-12** `scripts/verify-rls.ts:83-93`: prüft Policy-Existenz, nicht -Semantik (`USING (true)` passierte). Zusätzlich `polqual` auf `current_tenant_id()` prüfen.
- **N-13** `packages/tax/engine.ts:232-242`: Tagesgrenzen (OVERDUE) in UTC statt Europe/Berlin — nie fristverkürzend, nur 1–2 h verspätete Anzeige.
- **N-14** `admin/audit/page.tsx:72-76`: Datumsfilter mischt UTC-Parsing und server-lokale Uhrzeit — Einträge 00:00–02:00 Berlin erscheinen im Vortagsfilter.
- **N-15** `dashboard/dashboard-grid.tsx:158-161`: `void save…().then(…)` ohne `.catch` — Netzwerkfehler = unhandled Rejection, Nutzer glaubt gespeichert.
- **N-16** `scheduler.ts`: Daily-Jobs (audit-verify-check, dsgvo-retention, reminders …) ohne Retries (`attempts: 1`) — transienter Fehler um 02:45 = ein Tag ohne Integritäts-Check, ohne Alarm.
- **N-17** `apps/worker/src/jobs/audit-verify-check.ts:146-244`: duplizierter Notification-Upsert-Block (Drift-Risiko) → Helper extrahieren.
- **N-18** API-Fehlerformate uneinheitlich (`not_found` vs. `'not found'` vs. Klartext); `api/portal/documents/commit/route.ts:82` gibt rohe Exception-Message zurück (interna-leakend). `jsonError(code, status)`-Helper einführen.
- **N-19** `app/api/n8n/[...path]/route.ts:49-57`: toter 501-Platzhalter-Endpoint („Iteration 2") — implementieren oder entfernen.
- **N-20** Überlange Dateien: `document-explorer.tsx` (1 246 Z.), `subsumtion/actions.ts` (898), `clients/[id]/page.tsx` (885) — nächste Split-Kandidaten.
- **N-21** E2E: tautologienahe Assertion `expect([401,403,200,503]).toContain(…)` in 07-compliance 5.4; Jahreswechsel-Sensitivität in 08-differential (`CURRENT_YEAR` aus Testuhr); kein Playwright-`webServer` (lokale Portkonflikt-Logs im Root — gitignored, können gelöscht werden).
- **N-22** CI: `pnpm rebuild … || true` in 5 Jobs (der Paranoid-Job hat es bewusst nicht — Inkonsistenz); Image-Pinning-Guard prüft `docker run`-Zeilen in Steps nicht.

## Info / DX

- **I-1** `pnpm-workspace.yaml` (`injectWorkspacePackages: true` + `nodeLinker: hoisted`): injizierte Workspace-Kopien werden bei Quelländerungen **nicht** nachsynchronisiert (`pnpm install`/`--force` melden „Already up to date") — verursachte einen veralteten `@taxtronik/config`-Stand unter `node_modules/@taxtronik/storage/…` und den lokalen Testfehler. Zusätzlich: `vi.mock`-Spezifizierer decken injizierte Kopien (anderer Modulpfad) nicht ab. Empfehlung: Vitest-`resolve.alias` für `@taxtronik/*` auf die Workspace-Quellen (dedupliziert Modul-Identität) und/oder Sync-Schritt dokumentieren.

## Abdeckung (geprüft und sauber)

- **Auth/Session:** TOTP verpflichtend mit fail-closed Redis-Replay-Schutz, Backup-Codes atomar (`FOR UPDATE`), verteiltes Lockout (≥5 distinkte IPs), Revocation + frischer Rechte-Load pro Request, `__Host-`-Cookies, CSRF via Origin + `Sec-Fetch-Site` fail-closed, `DEV_SKIP_TOTP` dreifach gegated.
- **Autorisierung (Lesen/Export):** Dokument-Download/Preview, Bulk-ZIP, DATEV/XRechnung/ZUGFeRD, Suche — konsequent `canAccessClientTx` + expliziter Tenant-Filter zusätzlich zu RLS; Portal-Sessions single-client-scoped.
- **POA-Signatur-Flow:** Token nur als SHA-256-Hash, OTP-Zweitfaktor, `timingSafeEqual`, doppelte Caps, Anti-Enumeration — sauber.
- **Datei-Handling:** kein Zip-Slip (Restore = reines `pg_restore` mit SHA-256-Verifikation), Pfadbau leaf-only mit `..`-Verbot, MIME-Whitelist + `CSP: sandbox`.
- **Injection/SSRF:** kein `$queryRawUnsafe` mit User-Input; `spawn` mit Arg-Array; n8n-Routen HMAC-verifiziert (Nonce-Replay fail-closed); `safeFetch` mit DNS-Pinning.
- **Secrets/Vertraulichkeit:** kein echtes `.env` eingecheckt, keine hartcodierten Keys; kein ERiC-Material (CI-Guard `check-no-eric-spec.sh` aktiv); IDW-Dokumente nur mit Tz.-Verweisen in eigener Formulierung.
- **Teststrategie:** Unit + Property + echte-DB-RLS-Tests + Struktur-Guardrails (api-route-authz/csrf, prisma-client-guard) + 11 E2E-Specs + Backup-Roundtrip + KoSIT-XRechnung-Validator + gitleaks/Trivy/pnpm-audit. Alle Pakete laufen in CI; Actions SHA-gepinnt, Images Digest-gepinnt, guards erzwingen beides.

## Einordnung

Priorität 1 sind **H-1/H-2 (Steuerfristen)** — fachliche Fehler mit
unmittelbarem Mandanten-Schadenpotenzial, je ein kleiner Zweig + Test.
Priorität 2: **M-1** (Vertraulichkeits-Ventil in mutierenden Actions) und
**H-3/M-6** (Krypto im Render-Pfad). Priorität 3: **H-4/M-7** (Zeitzonen)
und **M-4** (Worker-Crash). Der Rest ist planbare Wartung. Die Fix-Historie
(„Audit 2026-06") zeigt, dass Befunde hier konsequent abgearbeitet werden —
dieser Bericht ist als dieselbe Arbeitsliste gedacht.
