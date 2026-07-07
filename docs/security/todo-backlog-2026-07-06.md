# Arbeits-Backlog — Folge-Review 2026-07-06

Ergebnis eines vierdimensionalen Folge-Reviews (Security · Codequalität ·
fachliche Plausibilität · Betriebs-Robustheit) **nach** dem Gesamt-Audit
2026-07-05. Es listet nur **neue** Befunde, die das Vor-Audit nicht enthielt.
Dubletten zwischen den Prüfperspektiven sind zusammengeführt (eine ID je
Sachverhalt). `✓` = vom Haupt-Reviewer am Code gegengelesen.

Konvention: **P0** = sofort (Cross-Tenant / unwiederbringlicher Datenverlust /
ungeschützter Auth-Pfad) · **P1** = hoch (falsche Rechtsfolge oder stiller
Funktionsausfall) · **P2** = mittel · **P3** = niedrig. ⚡ = Quick Win (< 1 h).

---

## Bearbeitungsstand (2026-07-07, Selbst-Audit) — Runde 7

Audit der eigenen Branch-Arbeit (kein Spaghetti-Code, saubere Umsetzung) durch
zwei unabhängige Review-Durchläufe (Korrektheit riskanter Änderungen ·
Konsistenz/toter Code). Behoben:

- **A1 (HOCH, fachlicher Fristfehler) — Klagefrist rechnete Bekanntgabefiktion
  doppelt.** `notices/actions.ts` rief für die Klagefrist (§ 47 (1) FGO)
  `appealDeadline(bekanntgabetag, …)`, das intern die § 122 (2)-Fiktion (+3/4
  Werktage) aufschlug — obwohl der Übergabewert bereits der Bekanntgabetag der
  Einspruchsentscheidung ist. Ergebnis: Klagefrist bis zu ~4 Tage **zu spät**
  angezeigt (bei einem Fristenkontrolltool die gefährliche Richtung). Fix: neue
  dedizierte `klageDeadline(bekanntgabe, region)` in `@taxtronik/tax` (nur
  +1 Monat + § 108 (3)-Werktagsverschiebung, keine Fiktion); gemeinsamer
  Monats-Additions-Kern mit `appealDeadline` extrahiert. Beide Audit-Läufe
  fanden dies unabhängig als wichtigsten Befund. Tests ergänzt.
- **A2 (KRITISCH) — `backup-run.ts` fehlender `child.on('error')`.** Bei
  Spawn-Fehler (ENOENT: pg_dump nicht im PATH) hätte das unbehandelte
  `error`-Event den **gesamten Worker-Prozess** gerissen, und `upload.done()`
  wäre unbegrenzt gehängt (RUNNING-Records für immer offen). Fix: Error-Handler
  zerstört den Body und resolvt die exit-Promise; im Fehlerpfad zusätzlich
  `child.kill('SIGTERM')` (kein pg_dump-Zombie mit offener DB-Connection) und
  `body.destroy()`.
- **A3 (MITTEL, Konsistenz) — Storno-Beleg emittierte `invoice.due`.** Ein
  Gutschrift-/Korrekturbeleg (§ 14c i.V.m. § 17 UStG) hat keine fällige Zahlung;
  Zahlungserinnerungs-Workflows dürfen daran nicht anschlagen. Fix: eigenes
  `invoice.storno`-Event in `STATIC_EVENT_NAMES`.
- **A4 (Duplikation) — Festschreib-Block extrahiert.** `cancelInvoiceAction`
  Tx-B duplizierte die DRAFT→SENT-Claim + Portal-Freigabe + invoice.send-Evidence
  aus `markSentAction`. Fix: gemeinsamer Helfer `finalizeInvoiceSendTx(tx, …)`.
  Ebenso `pgConnArgs`/`prismaBytes` (in mehreren Worker-Jobs dupliziert) nach
  `apps/worker/src/pg-conn.ts` gezogen; `queue-status.ts`-QUEUES-Drift
  (`backup-run` fehlte) behoben.
- **A5 (dokumentiert, kein Fix nötig)** — EXTERNAL-Storno (Format PDF) bleibt
  bewusst DRAFT (kein Generat, manuelle Ausstellung); im Code kommentiert.

Verifiziert-korrekt ohne Befund (beide Läufe): `round2` (exhaustiv gegen
kaufmännische Rundung), EGAO-Basis-Termine, atomare Claims durchgängig,
Storno-Negierung, Migrationen iter98–101 ↔ Schema, Enum-Vollständigkeit
KLAGE/TEILABHILFE. Offen/niedrig als Folge notiert: CSV-Export bildet
Storno-Kennzeichnung (`stornoOfId`) noch nicht ab.

## Bearbeitungsstand (2026-07-07, Umsetzung) — Runde 6

**NEU ERLEDIGT (Runde 6):**
- **P1-24 (komplett)** Automatischer täglicher Backup-Job im Worker
  (`backup-run`, 01:00 UTC): pg_dump → S3-Multipart-Stream, BackupRecord +
  Audit je Tenant, Scheduler-Eintrag, Tests. Zusammen mit dem bereits
  umgesetzten Staleness-Alarm ist die Lücke geschlossen.
- **P2-8** ZUGFeRD/Factur-X: AFRelationship-Bug behoben (`Alternative` statt
  `Source`), vollständiger Factur-X-XMP-Block eingebettet, UI-Label ehrlich
  (kein falscher PDF/A-3-Anspruch — Standard-Fonts nicht eingebettet; XRechnung
  als führendes Format). Test.
  Offen als dokumentierter Folgeschritt: echtes veraPDF-validierbares PDF/A-3
  bräuchte eingebettete Fonts (fontkit + Font-Asset) + OutputIntent/ICC.

Damit sind **alle P0, alle P1 und praktisch alle P2** umgesetzt. Verbleibend nur
noch: autoheal-Sidecar (Image-Digest), P2-24 E2E-Specs, kosmetisches P3-27.

## Bearbeitungsstand (2026-07-07, Umsetzung) — Runde 5

**NEU ERLEDIGT (Runde 5):**
- **P2-19** Admin-Seite „System → Jobs": Job-Zähler, letzter Erfolg/Fehler +
  Staleness je BullMQ-Queue (getQueuesStatus).
- **P2-2 (komplett)** § 11 Abs. 4 GwG — Geburtsort/Staatsangehörigkeit/
  Wohnanschrift im Onboarding jetzt Pflicht (Schema + Wizard).
- **P3-14** Sample-Fixture: „Durchlaufender Posten" (§ 10 Abs. 1 S. 5 UStG) →
  echte 0 %-Nebenkostenposition.

Verbleibend (bewusst offen): **P2-8** PDF/A-3-Konformität (Factur-X-XMP),
**P1-24-Rest** echter Backup-Zeitplan (Runner-Extraktion), **P2-24** E2E-Specs,
autoheal-Sidecar (Digest), **P3-27** consent-Key (id-Threading).

## Bearbeitungsstand (2026-07-07, Umsetzung) — Runde 4

**NEU ERLEDIGT (Runde 4):**
- **P2-20** Ressourcen-Limits (`mem_limit` je Service) + Postgres-Basis-Tuning
  in Compose.
- **P2-21** n8n-Datenbank in `backup-full` (run_backup_n8n) + Volume-Inventar
  (disaster-recovery.md).
- **P1-25** Externes Monitoring/autoheal als Pflicht-Runbook
  (day-2-operations.md) + irreführende „Docker restartet unhealthy"-Kommentare
  korrigiert. (Sidecar bewusst nicht eingecheckt — braucht echten Image-Digest.)
- **P2-2 (Teil)** GwG-Verify verlangt ≥1 wirtschaftlich Berechtigten bei jur.
  Personen (§ 10 Abs. 1 Nr. 2 GwG). Offen: § 11(4)-Pflichtfelder im Onboarding-
  Formular.
- **P3-15** Rechnungs-Vorschau rundet je Satzgruppe wie der Server · **P3-20**
  one-line-Abrechnung EN-16931-konform · **P3-23** Modul-Gate-Kommentar ehrlich,
  toter Helfer entfernt · **P2-5** 0%-Befreiungsgrund (Kat. E/BT-120, iter101) ·
  **P3-29c** los.ts Zod-Validierung.

## Bearbeitungsstand (2026-07-06, Umsetzung) — Runde 3

Dritte Runde (weitere Features), alle Tests grün (21/21 Test-Tasks, 20/20
Typecheck-Tasks).

**NEU ERLEDIGT (Runde 3):**
- **P2-6** Storno-Korrekturbeleg (§ 14c i.V.m. § 17 UStG): Migration iter100
  (`stornoOfId`), XRechnung TypeCode 381 + BG-3-Referenz (BT-25), `cancelInvoice`
  erzeugt bei versendeten Rechnungen eine Stornorechnung (negierte Beträge,
  eigene lückenlose Nummer), archiviert + versendet sie, Detail-UI-Verkettung,
  Overdue-Check schließt Stornos aus. +Tests.
- **P2-22** Stammdaten-Validierung: P2002-Catch, PLZ/USt-IdNr/Steuernummer-
  Format (DE), Steuernummer-Feld, Soft-Duplikat-Warnung.
- **P2-12** BWA-Steuerbasis „vor Steuern" (DATEV 1345/1300) + Disclaimer bei
  Fallback.
- **P2-3** GwG-Verify verlangt gültigen, identifikationstauglichen Ausweis mit
  Kopie (§ 12/§ 8 GwG).
- **P2-4** GwG-Löschuhr auch für nie zustande gekommene Mandate (§ 8 Abs. 4 S. 2
  GwG, Fristbeginn Feststellung) + Tests.
- **P2-18** health-alert: zusätzliche App-/n8n-HTTP-Checks.
- **P3-16** § 110-AO-Hinweis bei überfälliger Einspruchsfrist · **P3-17**
  § 80-AO-Hinweis im POA-Widerruf · **P3-26** ZUGFeRD-PDF Word-Wrap.

## Bearbeitungsstand (2026-07-06, Umsetzung) — Runde 2

Zweite Umsetzungsrunde (DB-Migrationen + Features), alle Paket-Tests weiterhin
grün (21/21 Turbo-Test-Tasks, 20/20 Typecheck-Tasks).

**NEU ERLEDIGT (Runde 2):**
- **P1-18** Leistungszeitraum: Schema-Feld + Migration iter98, BG-14
  (BT-73/74) im XRechnung-CII, BT-72 = Zeitraumende, ZUGFeRD-PDF-Sichtteil,
  Erfassung in Action + Formular, 4 neue Tests.
- **P2-10** Einspruch → Klageweg: Enum KLAGE/TEILABHILFE + klageDeadline
  (Migration iter99), Transitions, Klagefrist-Berechnung (§ 47 FGO via
  appealDeadline), Fristenkontrollbuch-Quelle KLAGEFRIST, Staff-/Portal-Labels,
  Tests.
- **P2-1** BEG IV: belegart-abhängige Aufbewahrung (`gobdRetentionUntilFor` —
  Rechnungen 8 J., sonst 10), Rechnungs-Commits auf `GOBD_INVOICE` gesetzt,
  Doku + 3 Tests.
- **P2-9** Steuernummer im ZUGFeRD-PDF-Sichtteil (Fallback ohne USt-IdNr).
- **P1-24 (Teil)** Backup-Staleness-Alarm im health-alert (letzte erfolgreiche
  Sicherung > 26 h → OPS-Mail über die bestehende Transition-Mechanik).
- **P3-19** BWA-Projektion: toter „Saisonfaktor" entfernt, ehrlich `linear`.
- **P3-24** `readEncryptedSetting`-Helper (SMTP/n8n): Decrypt-Fehler wird
  geloggt statt still verschluckt.

## Bearbeitungsstand (2026-07-06, Umsetzung) — Runde 1

Alle Paket-Tests grün (21/21 Turbo-Tasks; web 570, worker 84, tax 86,
risk-layer 39, n8n-shared 21, evidence 9 Dateien, übrige Pakete grün). Neue
Regressionstests: EGAO-Fristen, Bekanntgabefiktion, dsgvo-retention-Jahresanker,
invoice-overdue-Tagesgrenze, round2-Halbcent, GwG-PEP-Override, BWA-§35.

**ERLEDIGT (im Code umgesetzt + getestet):**
- **P0:** P0-1 (Cross-Tenant autoResumePausedWorkflows → reines Server-Modul),
  P0-2 (dsgvo-retention Jahresende-Anker + Test), P0-3 (TOTP-Enrollment
  Rate-Limit/Lockout/Audit).
- **P1:** P1-1…P1-9 (Vertraulich-Ventil in 9 Top-Level-Action-Modulen),
  P1-10…P1-15 (atomare Claims: POA-Resend, GwG-Verify/Reject, Change-Request,
  Termin-Accept/Reject, Workflow-Transitions, Notice-Status), P1-16 (GwG-PEP →
  HIGH/1 J.), P1-17 (Rechnung überfällig erst ab Folgetag, Worker + Portal),
  P1-19 (IN_APP-„PDF" ohne Beleg blockiert + Option entfernt), P1-20
  (n8n-Whitelist `appointment.responded` + strukturelle Kopplung), P1-21
  (n8n-Emit nach Commit), P1-22/P1-23/P1-26 (Compose-ENV, RISK_LAYER im Worker,
  stop_grace_period), P1-25-Teil (Heartbeat Redis-Gate + Kommentar korrigiert).
- **P2:** P2-7 (round2 float-robust), P2-11 (BWA §35 EStG + Test), P2-13
  (BWA-Parser-Ranges nicht als volles Jahr), P2-16 (Redis defaultJobOptions),
  P2-17 (Scheduler `tz: Europe/Berlin` für Morgen-Jobs), P2-23a
  (reminders-daily filtert `mandateEndedAt`), P2-25 (ELSTER-Rate-Limit).
- **P3:** P3-1 (Export-Limit XRechnung/ZUGFeRD), P3-2 (Secrets nicht in
  Container-argv), P3-3 (set_env sed-Delimiter), P3-4 (Heartbeat Redis-blind),
  P3-5 (env-Schema + .env.example), P3-6 (n8n-Healthcheck), P3-13
  (USt-Satz-Whitelist), P3-18 (GwG-Kommentar GOVERNANCE), P3-21 (Absenzen-
  Tagesgrenze), P3-22 (tote Action entfernt), P3-25/N-N7 (monthsCovered — via
  P2-13 mitbehandelt), P3-28 (doppeltes Zod-Parse), P3-29a/b (Mail-Log,
  Positions-Refine).

**OFFEN — benötigt DB-Migration, größeres Feature oder Produktentscheidung**
(Runde 1; ✅ = in Runde 2 erledigt):
- ✅ **P1-18** Leistungszeitraum · ✅ **P2-1** BEG IV · ✅ **P2-9** Steuernummer-PDF
  · ✅ **P2-10** Klage-Status · ✅ **P3-19/P3-24**.
- **P1-24 (Teil offen)** Tatsächlicher Backup-Zeitplan (Runner-Extraktion in ein
  Paket); der Staleness-Alarm ist umgesetzt.
- **P1-25** (Rest) autoheal-Sidecar / externer Uptime-Check (Infra + Doku).
- **P2-2/P2-3/P2-4** GwG-Pflichtfelder/Ausweisgültigkeit/Löschuhr (Schema + UI).
- **P2-5/P2-6** 0 %-Befreiungsgrund / Storno-Korrekturbeleg (Schema + UI).
- **P2-8** PDF/A-3-Konformität (Factur-X-XMP).
- **P2-12** BWA-Basis „vor Steuern" (Parser-Zeilenwahl).
- **P2-14** ZUGFeRD-Archiv-Auslieferung best-effort bei XML-Nachrüstfehler.
- **P2-15** N8N_TRIGGER-Payload — **teilweise** (custom-Merge in execute-step
  umgesetzt; UI-Konfig bleibt).
- **P2-18/P2-19** health-alert-Ausbau / Admin-Jobs-Seite.
- **P2-20/P2-21** Ressourcen-Limits+PG-Tuning / n8n-Backup-Abdeckung.
- **P2-22** Stammdaten-Validierung + Duplikatprüfung (Schema + UI).
- **P2-23b** Abschluss-Workflow bei Mandatsende (UI).
- **P2-24** E2E-Specs (Einspruch, ELSTER-Mock-Bridge, TOTP-Enroll).
- **P3-7** Rollback-nach-Migration-Doku · **P3-8…P3-12** GwG-/Retention-Feinheiten
  · **P3-14…P3-17** Fixture/UI-Rundung/§110/§80-Hinweise · **P3-19/P3-20**
  BWA-Projektion/one-line-Netto · **P3-23** Modul-Gates · **P3-24** Decrypt-Helper
  · **P3-26/P3-27** ZUGFeRD-Word-Wrap/consent-key · **P3-29c** los.ts-Zod.
- Aus Vor-Audit weiterhin offen: **M-10, M-11, M-12, N-12, N-13, N-19, N-20,
  I-1, F-4.**

Hinweis: Der Test `ops-lib.test.sh > „doctor rejected a valid prod SMTP config"`
schlägt umgebungsbedingt auch ohne diese Änderungen fehl (vorbestehend).

Bereits am 2026-07-06 erledigt (nicht mehr im Backlog): EGAO-Übergangsfristen,
Bekanntgabefiktion 3/4 Tage (F-2/F-3), Migrations-Datierungs-Konvention (F-1,
Doku). Bekannt offen aus dem Vor-Audit: M-10, M-11, M-12, N-12, N-13, N-19,
N-20, I-1, F-4.

---

## P0 — Sofort

### P0-1 ✓ Cross-Tenant-Schreibprimitiv: `autoResumePausedWorkflows` ist ein ungeschützter Server-Action-Endpunkt
`apps/web/src/app/staff/(protected)/clients/[id]/workflows/actions.ts:701` (Datei ist `'use server'`).
Die Funktion nimmt `tenantId` und `staffId` **direkt vom Aufrufer** und ruft
damit `withTenantContext` — ohne `staffActionGuard`/Session. In Next.js ist jede
exportierte Funktion einer `'use server'`-Datei ein aufrufbarer POST-Endpunkt.
Ein beliebiger (auch nicht eingeloggter) Client kann mit fremder `tenantId`
Workflow-Instanzen fremder Kanzleien PAUSED→ACTIVE schalten und SYSTEM-Audit-
Einträge dort erzeugen. Tenant-Isolation ausgehebelt.
**ToDo:** Funktion nach `apps/web/src/server/workflows/auto-resume.ts` (ohne
`'use server'`) verschieben, Import in `workflows/page.tsx` anpassen. Falls sie
Action bleiben muss: `staffActionGuard()` rufen und `tenantId`/`staffId`
ausschließlich aus der Session ableiten.

### P0-2 ✓ Unwiederbringliche Löschung §147-pflichtiger Korrespondenz (rollierende statt jahresende-verankerte Frist)
`apps/worker/src/jobs/dsgvo-retention.ts:57-61,109-110,128-138` + Test `__tests__/dsgvo-retention.test.ts:56-60,110-112,153-157`.
`yearsAgo()` rechnet rollierend ab `createdAt`; `purgeRequests` löscht per
`deleteMany` (Cascade auf Responses, irreversibel). Ein GoBD-verknüpfter Request
vom 15.03.2026 wird ab 16.03.2036 vernichtet — § 147 Abs. 4 AO verlangt
Aufbewahrung bis 31.12.2036 (Fristbeginn Schluss des Kalenderjahres). Betrifft
6- und 10-Jahres-Klasse. Der Test zementiert den Fehler.
**ToDo:** Request-Cutoffs auf Jahresende-Anker umstellen
(`new Date(Date.UTC(now.getUTCFullYear() - years, 0, 1))`, Muster
`server/dsgvo/client-retention.ts:74`). Die 1/2/3-Jahres-Cutoffs (Notifications,
Phone-Notes, lastLoginAt) bleiben rollierend. Test-Assertions auf Jahresende
umstellen + Regressionstest „Jahresanfangs-Request wird nicht vor 1.1. nach
Fristablauf gelöscht".

### P0-3 ✓ Ungedrosselter zweiter Passwort-Prüfpfad (bcrypt-Orakel + CPU-DoS)
`apps/web/src/app/staff/(auth)/login/actions.ts:232-247` (`confirmTotpEnrollmentAction`).
Öffentlich aufrufbare Action, führt `compare(password, passwordHash)` für **jeden
aktiven Account** aus (der `totpSecretEnc`-Check kommt erst danach) — ohne
IP-Limit, Account-Limit, `lockedUntil`-Prüfung oder Fehlversuch-Audit. Der
gehärtete `checkPasswordAction` (Z. 79-143) hat all das. Verteiltes Brute-Force
gegen bekannte E-Mails und bcrypt-CPU-Erschöpfung möglich.
**ToDo:** Vor `compare` (Z. 246) dieselbe Schrankenkette wie in
`checkPasswordAction` einziehen: `checkIpOrGlobalLimit('staff-pw', ip, {max:10,
windowSec:600}, {max:200,windowSec:600})`, `lockedUntil`-Check,
`checkStaffPasswordAccountLimit(staffUser.id)`, Fehlversuche über
`recordFailedLoginAudited(...)` zählen.

---

## P1 — Hoch

### Authorisierung: fehlendes Vertraulich-/RESTRICTED-Ventil in Top-Level-Actions
> Gemeinsame Klasse (Security-Race-Sub-Review #1-#10 ∪ Qualität M-N1): Der
> M-1-Fix des Vor-Audits deckte nur `clients/[id]/**` ab. Top-Level-Action-Module,
> die per `clientId`/Objekt-ID mandantenbezogene Daten mutieren, prüfen nur
> Tenant-Zugehörigkeit (RLS), nicht das `canAccessClientTx`-Ventil. Ein nicht
> zuständiger Mitarbeiter derselben Kanzlei kann Daten **vertraulicher** Mandanten
> mutieren. Kein Cross-Tenant-Leak. Einheitlicher Fix: `clientId` serverseitig
> ermitteln (bei `*Id`-Actions via Lookup) und `assertClientAccessTx(tx, session,
> clientId)` als erste Tx-Anweisung; danach den Struktur-Guardrail
> `__tests__/server-action-authz.test.ts` um einen Ventil-Check erweitern.

- **P1-1** `admin/custom-fields/actions.ts:139` `saveCustomFieldValuesAction` — schreibt Mandanten-Stammdatenfelder ohne Ventil.
- **P1-2** `staff/(protected)/invoices/actions.ts:74` (`createInvoiceAction`), `:438` (`uploadExternalInvoiceAction`), sowie `markSentAction`/`markPaidAction`/`cancelInvoiceAction` (via `invoiceId`-Lookup) — Gegenstück `clients/[id]/billing/actions.ts:60` hat das Ventil.
- **P1-3** `staff/(protected)/documents/actions.ts:54,91,136,333` (softDelete/restore/retag/**setShare**) — `setDocumentShareAction` gibt Dokumente ans Portal frei; lesende Routen erzwingen `canAccessClientTx` bereits.
- **P1-4** `staff/(protected)/poa/actions.ts:182` (`sendForSignatureAction`), `:268` (`revokePoaAction`) — Versand/Widerruf einer Vollmacht vertraulicher Mandanten.
- **P1-5** `staff/(protected)/forms/actions.ts:195` (`createSubmissionAction`), `:269` (`reviewSubmissionAction`).
- **P1-6** `staff/(protected)/tax-deadlines/actions.ts:9,35` (mark done einzeln/bulk).
- **P1-7** `staff/(protected)/calendar/actions.ts:218` (accept), `:380` (reject), `:38/121` (create/update mit `clientId`).
- **P1-8** `staff/(protected)/clients/onboarding/[id]/actions.ts:34,139` (Kontakt anlegen, GwG-Onboarding senden).
- **P1-9** (P3-nah) `staff/(protected)/phone-notes/actions.ts:25,264` und `staff/(protected)/time/actions.ts:16` — clientId-Verknüpfung nur bei gesetztem `clientId` absichern.

### Race Conditions / TOCTOU (Read-then-Write ohne Status-Guard im `where`)
> `withTenantContext` = `prisma.$transaction` ohne erhöhtes Isolationslevel/Row-Lock
> (READ COMMITTED, `packages/db/src/tenant-context.ts:108`) → Read-then-Write in
> derselben Tx schützt NICHT vor Races. Einheitlicher Fix: Statuswechsel als
> atomarer Claim `updateMany({ where: { id, status: <erwartet> }, data })` +
> `count`-Prüfung, dann Folgeschritte.

- **P1-10** `poa/actions.ts:199-222` `sendForSignatureAction` — Update ohne Status-Guard; Race gegen `signPoaAction` kann eine bereits SIGNED-Vollmacht auf SENT zurücksetzen und neuen Signing-Token ausstellen (eIDAS-Beweisspur beschädigt). Claim auf `status: { in: ['DRAFT','SENT'] }`.
- **P1-11** `clients/[id]/gwg/actions.ts:269-298` (`verifyCheckAction`) + `:366-373` (`rejectCheckAction`) — verify hat gar keine Status-Precondition; ein REJECTED-Check ist ohne Neubewertung auf VERIFIED flippbar, Race kann `allowActive=true` trotz Reject ergeben. Claim + count.
- **P1-12** `clients/[id]/change-requests/actions.ts:36→60/75/96` — approve‖reject übernehmen Stammdaten trotz final REJECTED (doppelter GwG-Reset). Zuerst Request atomar claimen, dann `client.update`.
- **P1-13** `calendar/actions.ts:245→272` (accept), `:380→390` (reject) — Doppel-Accept erzeugt zwei bestätigte Termine + doppelte Mails. Request zuerst claimen, dann Termin anlegen.
- **P1-14** `clients/[id]/workflows/actions.ts` cancel/restore/pause/resume/deleteCancelled (`:346,394,444,485,751`) — `restore ‖ deleteCancelled` kann eine wieder aktive Instanz endgültig löschen. Alle Übergänge auf `updateMany`/`deleteMany` mit Status-Guard.
- **P1-15** `clients/[id]/notices/actions.ts:188-212` (`updateNoticeStatusAction`) — zwei einzeln gültige Übergänge aus gleichem Ausgangsstatus überschreiben `appealFiledAt`/`reviewedAt` (§122(2)-Nachweis). Claim auf `status: before.status`.

### Fachlich (falsche Rechtsfolge / Mandanten-sichtbar)
- **P1-16 (GwG PEP)** `server/gwg/risk-score.ts:55,93,99-100,147` + `clients/[id]/gwg/actions.ts:271-281` — PEP (§ 15 Abs. 3 Nr. 1, Abs. 4 GwG = zwingend verstärkte Sorgfalt) ergibt nur MEDIUM/3 Jahre; `beneficialOwner.isPep` (`schema.prisma:262`) ist folgenlos. **ToDo:** In `computeRiskScore` PEP-Override `answers.pep>=1 ⇒ HIGH, validForDays=365`; in `verifyCheckAction` bei `isPep` HIGH + max. 1 Jahr erzwingen bzw. Verifikation blockieren.
- **P1-17 ✓ (Rechnung überfällig am Fälligkeitstag)** `apps/worker/src/jobs/invoice-overdue-check.ts:35,44` + Portal `portal/(protected)/invoices/page.tsx:61`. `dueDate` (`@db.Date`, Mitternacht UTC) `{ lt: now }` markiert schon am Fälligkeitstag; `Math.ceil` zeigt „1 Tag überfällig". Zahlung am Fälligkeitstag ist rechtzeitig (§ 271, § 188 Abs. 1 BGB). **ToDo:** Gegen Berliner Tagesbeginn heute vergleichen, `daysOverdue` per `Math.floor` ab Folgetag; Portal-Bedingung und Tests (`:114-117,151-163`) angleichen.
- **P1-18 (Leistungszeitpunkt)** `server/invoicing/xrechnung.ts:270-281` — BT-72 hartkodiert = Rechnungsdatum; kein Leistungszeitraum-Feld. Bei Nachlauf-Abrechnung falsches Leistungsdatum → Vorsteuerabzug des Empfängers gefährdet (§ 14 Abs. 4 Nr. 6 UStG, § 31 Abs. 4 UStDV). **ToDo:** Leistungszeitraum am Invoice-Modell erfassen (Monat genügt), als BG-14/BT-72 ausgeben, im PDF drucken; Test `__tests__/xrechnung.test.ts:51-53` anpassen.
- **P1-19 (IN_APP-Rechnung ohne Beleg)** `server/invoicing/archive.ts:55`, `invoices/new/form.tsx:180`, `invoices/actions.ts:229` — Format „PDF" bei IN_APP → `not_applicable`, Versand ohne Rechnungsdokument und ohne GoBD-Archivkopie (§ 14 Abs. 1 UStG). **ToDo:** PDF-Option für IN_APP entfernen oder Generat erzeugen; `not_applicable` beim Versand nur bei vorhandener `documentId` (EXTERNAL) durchlassen.

### Codequalität (stiller Funktionsausfall)
- **P1-20 ⚡ (n8n-Event verworfen)** `packages/n8n-shared/src/index.ts:19-33` vs. `server/n8n/emit.ts:42`, `calendar/actions.ts:329,411`. `appointment.responded` ist typisiert und wird emittiert, fehlt aber in `STATIC_EVENT_WHITELIST` → `isAllowedN8nEvent()` lehnt ab, `outbox.ts:44` loggt nur — kein Termin-Event erreicht n8n. **ToDo:** `'appointment.responded'` in die Whitelist aufnehmen; Union-Quelle und Whitelist per Unit-Test koppeln (Drift strukturell verhindern).
- **P1-21 (n8n-Event vor Commit emittiert)** `server/workflows/execute-step.ts:246-260` — `emitN8nEvent` schreibt via `prismaOwner` innerhalb der Tenant-Tx; rollt die Tx danach zurück, ist das Event (mit `createdRequestId` einer nie existierenden Anforderung) trotzdem zugestellt. Mail-Pfad derselben Datei macht es korrekt. **ToDo:** Event-Daten im Callback sammeln, `emitN8nEvent` erst nach erfolgreichem `withTenantContext`-Return feuern.

### Betrieb/Infra (Prod-Funktion fällt aus)
- **P1-22 ⚡ (Compose-ENV-Lücke)** `infra/compose/docker-compose.app.yml` (`app` Z. 54-110, `worker` Z. 164-203) hat kein `env_file:`; sechs Variablen erreichen die Container nie: `TIMESTAMP_AUTHORITY_URL` (→ audit-verify/backup-drill fallen still auf `LocalTimestampAdapter` trotz `requireExternalTsa`), `UPDATE_MANIFEST_URL`/`UPDATE_PUBLIC_KEY` (→ Update-Check dauerhaft „nicht konfiguriert", Betreiber erfährt nie von Updates), `DATABASE_CONNECTION_LIMIT`, `SECRET_BOX_KEY`, `LICENSE_KEY`/`LICENSE_PUBLIC_KEY`. **ToDo:** Bei `app` und `worker` die Variablen als `${VAR:-}` in `environment:` ergänzen; CI-/doctor-Check schreiben, der `.env.example`-Schlüssel gegen die Compose-`environment:`-Blöcke diffed.
- **P1-23 ⚡ (Worker ohne RISK_LAYER_*)** `apps/worker/src/jobs/risk-analyse-llm.ts:62` — `worker`-Service bekommt `RISK_LAYER_URL/TOKEN` nicht; mit aktivem `risk-layer`-Profil wirft der Job `RiskLayerNotConfiguredError`, `llmEnrichedAt` wird nie gesetzt. **ToDo:** `RISK_LAYER_URL`/`RISK_LAYER_TOKEN` in den `worker`-`environment`-Block aufnehmen.
- **P1-24 (kein Backup-Zeitplan)** Backups laufen nur manuell/vor Updates; kein Scheduler-Job. `backup-drill` validiert nur „das letzte erfolgreiche" — bei update-los betriebenen Installationen faktisch kein aktuelles Backup, ohne Alarm. **ToDo:** Täglichen `backup-run`-Job im Worker ergänzen (Runner aus `server/backup/runner.ts` extrahieren); Staleness-Alarm in `backup-drill`/`health-alert` (letztes SUCCESS älter als 26 h → Notification + Ops-Mail).
- **P1-25 (unhealthy ≠ restart)** `apps/worker/src/index.ts:44-45` und `jobs/health-alert.ts:16-17` nehmen an, Docker restarte unhealthy Container — falsch bei Plain-Docker/Compose (nur Prozess-Exit triggert `restart:`). Ein deadlockter Worker läuft unbegrenzt weiter, und der health-alert-Job läuft **im Worker selbst** → keine Alarm-Mail. **ToDo:** (a) `autoheal`-Sidecar (digest-gepinnt) oder Host-systemd-Timer; (b) irreführende Kommentare korrigieren; (c) externen Uptime-Check auf `GET /api/health` in `docs/operations/day-2-operations.md` als Pflicht aufnehmen.
- **P1-26 ⚡ (kein `stop_grace_period`)** Shutdown wartet korrekt auf laufende Jobs (`index.ts:87-104`), aber Compose SIGKILLt nach 10 s. Betroffen: `backup-drill` (pg_restore), `risk-analyse-llm` (bis 180 s), `evidence-seal`, Verify-Walk (120-s-Tx). **ToDo:** `stop_grace_period: 180s` (worker) bzw. `30s` (app) in `infra/compose/docker-compose.app.yml`.

---

## P2 — Mittel

### Fachlich — Aufbewahrung / GwG
- **P2-1 (BEG IV: 8 statt 10 Jahre)** `packages/storage/src/service.ts:31-35,79-81`, `client.ts:44-47`, Doku `docs/compliance/gobd.md:19-22`. Alle GoBD-Klassen bekommen 10 J. + COMPLIANCE-Lock (irreversibel). Seit 1.1.2025: Buchungsbelege/Rechnungen 8 Jahre (§ 147 Abs. 3 AO n.F., § 257 Abs. 4 HGB n.F., § 14b Abs. 1 UStG n.F.) → Über-Aufbewahrung personenbezogener Daten (Art. 5 Abs. 1 lit. e DSGVO). **ToDo:** Retention je Belegart differenzieren (8 J. `GOBD_INVOICE`/Buchungsbelege, 10 J. Bücher/Abschlüsse, 6 J. Geschäftsbriefe); Doku + Tests nachziehen. `GOBD_RETENTION_YEARS=10` (`client-retention.ts:23`) bleibt als längste Anonymisierungs-Wartezeit.
- **P2-2 (GwG §11(4) Pflichtangaben)** `apps/web/src/app/gwg-onboarding/actions.ts:240-267`, `clients/[id]/gwg/actions.ts:95-105,274-279` — Geburtsort/Staatsangehörigkeit/Anschrift optional, keine Rechtsform/Registernummer/Vertretungsberechtigte, kein Vollständigkeits-Gate. **ToDo:** § 11 Abs. 4-Felder zu Pflichtfeldern; `verifyCheckAction` um Vollständigkeits-Gate erweitern.
- **P2-3 (GwG untauglicher Ausweis)** `clients/[id]/gwg/actions.ts:277-279` — jedes `GwgIdDocument` beliebigen Typs erfüllt das Gate, `expiryDate<now` ungeprüft. § 12 Abs. 1 S. 1 Nr. 1, § 8 Abs. 1-2 GwG. **ToDo:** identifikationstauglichen Typ + hinterlegte Kopie + nicht abgelaufene Gültigkeit verlangen.
- **P2-4 (GwG-Löschuhr)** `server/gwg/retention.ts:32-35`, `gwg-expiry-check.ts:287-304` — Frist startet nur mit `mandateEndedAt`; abgelehnte Onboardings (mit Ausweiskopie) werden nie gelöscht. § 8 Abs. 4 S. 2 GwG. **ToDo:** alternativer Fristbeginn (`createdAt`/`verifiedAt`-Jahr) für REJECTED/nie aktivierte Mandate in den `findDueGwg*`-Queries.

### Fachlich — Rechnung / USt
- **P2-5 (0 %-Befreiung / Kleinunternehmer)** `server/invoicing/vat.ts:59-61` — jede 0 %-Position → Kategorie „Z" ohne Befreiungsgrund (BT-120/121); § 19 UStG nirgends abbildbar. § 14 Abs. 4 Nr. 8 UStG. **ToDo:** Kategorie Z/E/§19 mit Pflicht-Befreiungsgrund in XML + PDF, oder 0 % blockieren.
- **P2-6 (Storno ohne Korrekturbeleg)** `server/invoicing/number.ts:76`, `invoices/actions.ts:364-406` — SENT/OVERDUE→CANCELLED nur per Status, kein Stornobeleg (TypeCode 381); ausgewiesene USt bleibt geschuldet bis Berichtigung (§ 14c Abs. 1 i.V.m. § 17 UStG). **ToDo:** Stornorechnung (eigene Nummer, 381, negierte Beträge, Referenz) erzeugen, archivieren, zustellen.
- **P2-7 (round2 nicht kaufmännisch)** — **Dublette Plausibilität M-7 ∪ Qualität M-N4.** `apps/web/src/lib/fmt.ts:20-22`: `Math.round(n*100)/100` rundet an Halbcent-Grenzen ab (`round2(1.005)=1.00`, `round2(8.575)=8.57`); Konsumenten sind `invoicing/vat.ts:41,45` (USt je Satzgruppe) und `billing/actions.ts:82-87` → 1 Cent zu wenig USt. **ToDo:** `round2` float-robust/half-away-from-zero machen, die drei Edge-Cases in `lib/__tests__/fmt.test.ts` festschreiben, den „nutze Decimal"-Kommentar entfernen.
- **P2-8 (kein PDF/A-3)** `server/invoicing/zugferd.ts:5-10,313-316`, UI-Label `invoices/[id]/page.tsx:24` — Hybrid-PDF ohne PDF/A-3 + Factur-X-XMP, aber als „ZUGFeRD" beschriftet (E-Rechnungspflicht B2B seit 1.1.2025). **ToDo:** PDF/A-3 nachrüsten oder Label korrigieren und XRechnung als führendes Format ausweisen.
- **P2-9 (PDF ohne Steuernummer)** `server/invoicing/zugferd.ts:186-189` — nur `vatId` gedruckt; Kanzlei nur mit Steuernummer → Pflichtangabe § 14 Abs. 4 Nr. 2 UStG fehlt im Sichtteil. **ToDo:** Steuernummer im PDF-Kopf drucken, wenn keine USt-IdNr.

### Fachlich — Einspruch / BWA
- **P2-10 (Klageweg fehlt)** `clients/[id]/notices/transitions.ts:22-25` — `ZURUECKGEWIESEN→[RECHTSKRAEFTIG]`, keine Klagefrist (§ 47 Abs. 1 FGO, 1 Monat), keine Teilabhilfe. Für ein Fristentool die gefährlichste Modell-Lücke. **ToDo:** Status `KLAGE` (+ Klagefrist-Feld, Aufnahme ins Fristenkontrollbuch), optional `TEILABHILFE`.
- **P2-11 (BWA §35 EStG)** — **Dublette Plausibilität M-11 ∪ Qualität M-N3.** `server/bwa/tax-estimator.ts:117-119` — `gewerblicheEinkuenfte = result - gewerbesteuer` verletzt § 4 Abs. 5b EStG (GewSt keine Betriebsausgabe seit 2008); § 35 EStG-Anrechnung fehlt → systematische Überschätzung der Gesamtlast (bei 100 T€ grob 7-9 T€). Live im UI. **ToDo:** ESt auf `input.result` rechnen, `min(gewerbesteuer, 4×Messbetrag, tarifliche ESt)` abziehen; Golden-Tests mit/ohne Freibetrag.
- **P2-12 (BWA-Basis nach Steuern)** `server/bwa/tax-estimator.ts:22-23,89-97`, `addison-parser.ts:194` — Bemessung auf DATEV 1380 „vorläufiges Ergebnis (nach Steuern)" → Zirkelbezug, unterschätzt sobald Steuern gebucht. **ToDo:** DATEV 1345 „Ergebnis vor Steuern" (bzw. Addison-Äquivalent) als Basis; Fallback dokumentieren.
- **P2-13 (BWA-Parser RANGE)** `server/bwa/addison-parser.ts:96-103`, `datev-parser.ts:55-61` — beliebige Perioden-Spannen fallen als `type:'YEAR'` durch; `projection.ts:125,209` behandeln sie als volles Jahr → Halbjahres-BWA halbiert scheinbar Jahreswerte. **ToDo:** eigenen `'RANGE'`-Typ einführen (oder in `projection.ts` zusätzlich `monthsCovered===12` verlangen); Testfall mit Halbjahres-Header.

### Codequalität
- **P2-14 (ZUGFeRD-Archiv-Auslieferung blockiert)** `server/invoicing/archive.ts:98-108` — im „Archiv existiert bereits"-Pfad scheitert der Download der unveränderlichen Archiv-PDF, wenn die XML-Nachrüstung `seller_incomplete` liefert. **ToDo:** XML-Nachrüstung im Existing-Pfad best-effort; vorhandenes Archiv trotzdem mit `ok:true` liefern, Mangel nur loggen.
- **P2-15 (N8N_TRIGGER payload ignoriert)** `server/workflows/step-config.ts:72-76` — validierter `payload` wird in `execute-step.ts` nie gelesen; das Konfig-UI verspricht mehr, als der Schritt tut. **ToDo:** `config.payload` beim Emit unter eigenem Key mergen — oder Feld aus Config + UI entfernen.

### Betrieb/Infra
- **P2-16 ⚡ (Redis-Jobs akkumulieren)** Nur `n8n-deliver` setzt `removeOnComplete/Fail`; alle anderen Queues sammeln unbegrenzt (~210 k Hashes/Jahr), Redis ohne `maxmemory`. **ToDo:** gemeinsame `defaultJobOptions: { removeOnComplete: { age: 86400, count: 500 }, removeOnFail: { age: 604800 } }` in `apps/worker/src/queues.ts`.
- **P2-17 ⚡ (Scheduler ohne `tz`)** `apps/worker/src/scheduler.ts` — alle Crons in UTC, Kommentare nennen feste MESZ-Zeiten → im Winter 1 h Versatz, `reminders-daily` im Sommer nach Bürobeginn. **ToDo:** `tz: 'Europe/Berlin'` bei allen `pattern`-Schedulern; nur Startzeiten normieren, UTC-Tagesgrenzen von `evidence-seal` unangetastet.
- **P2-18 (health-alert-Lücken)** `jobs/health-alert.ts:180-186` prüft nur PG/Redis/S3/ClamAV. Ungeprüft: App selbst, n8n, eric-bridge/risk-layer, Disk-Füllstand, Queue-Tiefe/failed, TLS-Ablauf. **ToDo:** HTTP-Checks (`app:3000/api/health`, `n8n:5678/healthz`, Bridges falls konfiguriert), Speicher-Schwellwerte (`pg_database_size` + Backup-Volume), `getJobCounts('failed','waiting')` je Queue, Zert-Check < 21 Tage.
- **P2-19 (keine Job-Einsicht)** Kein `bull-board`/`getJobCounts` im Repo; ein Tag ohne evidence-seal/dsgvo-retention fällt niemandem auf. **ToDo:** Admin-Seite „System → Jobs" (`getJobCounts()` + letzter Completed-Zeitstempel + letzter Fehler je Queue) oder minimal `lastRunAt` je Queue persistieren und gegen Soll-Intervall prüfen.
- **P2-20 (keine Ressourcen-Limits / kein PG-Tuning)** `infra/compose/*.yml` — kein `mem_limit`/`cpus`; ClamAV ~3-4 GB, risk-layer LLM; ein Leak triggert Host-OOM, der z. B. Postgres killt. Postgres auf Alpine-Defaults (`shared_buffers` 128 MB) für „10-500 MA" unterdimensioniert. **ToDo:** `mem_limit` je Service; Postgres-Tuning (`shared_buffers` 25 % RAM, `effective_cache_size` 50-75 %, `max_connections` ~ `DATABASE_CONNECTION_LIMIT`×Prozesse); Sizing-Tabelle in day-2-operations.md.
- **P2-21 (Backup-Abdeckung n8n)** `n8n_data`-Volume (Credentials, mit `N8N_ENCRYPTION_KEY` verschlüsselt) und die Postgres-`n8n`-DB sind in keinem Backup-Pfad. **ToDo:** `run_backup` um `pg_dump` der `n8n`-DB erweitern; Volume-Inventarliste mit Backup-Status je Volume in `docs/operations/disaster-recovery.md`.
- **P2-22 (Stammdaten-Validierung + Duplikate)** `clients/new/actions.ts:14-26,126-129` — kein Steuernummer-Feld bei Anlage, PLZ/USt-IdNr ohne Format, keine Duplikat-Erkennung, P2002 (`@@unique([tenantId,datevNo])`) unbehandelt → Serverfehler statt Meldung. **ToDo:** (a) ⚡ P2002 abfangen; (b) Soft-Duplikat-Warnung (Name+PLZ, invoiceEmail); (c) PLZ `^\d{5}$` (DE), USt-IdNr `^DE\d{9}$`; (d) Steuernummer-Feld schon im Anlageformular.
- **P2-23 (Mandatsende: Vorgänge laufen weiter)** `apps/worker/src/jobs/reminders-daily.ts:95-125,128-133` filtert nicht nach `mandateEndedAt`/`allowActive`; kein Abschluss-Workflow beim Mandatsende. **ToDo:** (a) `client: { mandateEndedAt: null }` in den drei Abschnitten; (b) Mandat-Beenden-Action mit Checkliste offener Requests/Workflows/Wiedervorlagen.
- **P2-24 (E2E-Lücken Kern-Flows)** Kein E2E für: kompletter Einspruchs-Flow (haftungsträchtige Fristen), ELSTER-Abfrage (keine Mock-Bridge in Fixtures), TOTP-Enrollment (CI läuft mit `DEV_SKIP_TOTP=true`, Prod-Pflichtpfad nie getestet). **ToDo:** `12-einspruch.spec.ts`; Mock-eric-bridge-Stub in `apps/e2e` + `ELSTER_BRIDGE_URL` in Paranoid-CI; TOTP-Enroll-Spec (otpauth-Secret parsen, `otplib`) ohne `DEV_SKIP_TOTP`.

### Security (kleiner)
- **P2-25 (ELSTER ohne Rate-Limit)** `clients/[id]/elster/actions.ts:49` — jeder Aufruf löst einen echten ELSTER-Vorgang aus (Bridge bis 120 s, PIN durchgereicht); kein Limit → Echtfall-Spam, Portalzertifikat-Sperrgefahr, blockierte Worker. **ToDo:** Nach `staffActionGuard()` `checkRateLimit('elster-konto:'+staffId, {max:5,windowSec:600})` + tenant-Backstop `elster-konto-tenant:'+tenantId` (20/10 min).

---

## P3 — Niedrig

### Security / Infra
- **P3-1 (XRechnung/ZUGFeRD ohne Export-Limit)** `api/staff/invoices/[id]/xrechnung/route.ts:12`, `.../zugferd/route.ts:12` — kein `checkStaffExportLimit` (die 6 CSV-Routen haben es). **ToDo:** `checkStaffExportLimit('xrechnung'|'zugferd', staffId)` nach `staffAuth()`.
- **P3-2 ⚡ (Secrets im Container-argv)** `infra/scripts/pg_dump-via-container.sh:17`, `pg_restore-via-container.sh:21`, `scripts/ops-lib.sh:695-697` — `-e VAR="$wert"` legt Secrets in die Prozess-Kommandozeile. **ToDo:** Pass-Through-Form `-e VARNAME` (Wert bereits im Env).
- **P3-3 (`set_env` sed-Delimiter)** `scripts/ops-lib.sh:86-89` — `esc` maskiert `|` nicht, das aber `sed`-Delimiter ist; Token mit `|`/Newline brechen das `.env`-Schreiben. **ToDo:** Escaping auf Delimiter erweitern oder Nicht-Regex-Zuweisung.
- **P3-4 ⚡ (Heartbeat Redis-blind)** `apps/worker/src/index.ts:38-52` — Touch unabhängig vom Redis-Status; Worker mit toter Verbindung bleibt „healthy". **ToDo:** Touch nur bei `connection.status === 'ready'`.
- **P3-5 ⚡ (env-Schema-Restdrift)** `S3_BUCKET_BACKUPS`, `LOG_LEVEL`, `UPDATE_MANIFEST_URL`, `UPDATE_PUBLIC_KEY` fehlen im Zod-Schema (`packages/config/src/env.ts`); `LICENSE_PUBLIC_KEY`/`LOG_LEVEL` fehlen in `.env.example`. **ToDo:** ins Schema aufnehmen (optional mit Defaults) + `.env.example` ergänzen.
- **P3-6 ⚡ (n8n ohne Healthcheck)** `infra/compose/docker-compose.app.yml:233-270` — einziger Dauer-Service ohne `healthcheck`. **ToDo:** `wget -qO- http://127.0.0.1:5678/healthz`.
- **P3-7 (Rollback-nach-Migration undokumentiert)** `cmd_rollback` warnt korrekt „forward-only", aber der Fall „Update mit destruktiver Migration fehlgeschlagen → Restore des in `cmd_update` erzeugten Backups" fehlt in `release.md`/`disaster-recovery.md`. **ToDo:** Abschnitt „Rollback nach Migration" mit konkretem Restore-Kommando.

### Fachlich
- **P3-8** `packages/storage/src/service.ts:429-434` Retention-Anker = Upload- statt Belegdatum (nie zu kurz). ToDo: optionales `documentDate` durchreichen.
- **P3-9** `admin/dsgvo/actions.ts:330-356` Einzel-Kontakt-Anonymisierung ohne Prüfung laufender Aufbewahrung. ToDo: Warn-/Blockierprüfung analog `confirmClientAnonymizationAction`.
- **P3-10** `gwg-onboarding/actions.ts:353-373` Resubmit reaktiviert Check mit altem Risk-Score. ToDo: Risk-Felder beim Resubmit nullen.
- **P3-11** `validForDays` doppelt hartkodiert (`risk-score.ts:147`, `gwg/actions.ts:281`). ToDo: eine exportierte Quelle.
- **P3-12** `gwg-expiry-check.ts:277-324` keine Eskalation bei dauerhaft ignorierter Lösch-Queue (§ 8 Abs. 4 S. 4 „unverzüglich"). ToDo: Eskalationsstufe ab N Tagen.
- **P3-13** `invoices/actions.ts:43` Server akzeptiert USt-Sätze 0-99 % (UI 19/7/0). ToDo: serverseitige Whitelist.
- **P3-14** `invoicing/sample-fixture.ts:25` „Durchlaufender Posten" als 0 %-Umsatz (§ 10 Abs. 1 S. 5 UStG: kein Entgelt). ToDo: Fixture korrigieren.
- **P3-15** `invoices/new/form.tsx:65-68` UI-Vorschau rundet je Position statt je Satzgruppe. ToDo: `computeVatTotals` clientseitig nutzen.
- **P3-16** Wiedereinsetzung § 110 AO nirgends abgebildet; kein Hinweis bei überfälligen Einspruchsfristen. ToDo: Hinweis/Checklistenpunkt (1-Monats-Frist).
- **P3-17** POA-Widerruf (`poa/actions.ts:268-295`) nur app-intern; kein Hinweis auf Wirksamkeit erst mit Zugang bei der Behörde (§ 80 Abs. 1 S. 4 AO) / Vollmachtsdatenbank. ToDo: Hinweistext im Widerrufs-Flow.
- **P3-18** Irreführende Kommentare gegen die (korrekte) Compliance-Entscheidung: `documents/actions.ts:28` („COMPLIANCE" statt GOVERNANCE), `gwg-onboarding/actions.ts:151` („10 Jahre" statt GwG 5 J.), `apps/worker/src/scheduler.ts:7` (30 statt 90/30/0 Tage). ToDo: korrigieren.

### Codequalität
- **P3-19** `server/bwa/projection.ts:137-149` — „linear-seasonal" ist toter Code (Saisonfaktor konstant); Label täuscht Präzision. ToDo: Schleife entfernen und Strategie ehrlich `linear` nennen — oder echte Saisonfaktoren berechnen.
- **P3-20** `billing/actions.ts:102-115` — `quantity × unitPrice ≠ netAmount` bei gemischten Sätzen (PEPPOL-EN16931-R120). ToDo: `one-line` als `quantity:1, unit:'pauschal', unitPrice:totalNet`.
- **P3-21** `server/absences/coverage.ts:31-41` — `endDate` (`@db.Date`) vs. `new Date()` → letzter Abwesenheitstag verloren ab 00:00 UTC. ToDo: `today` auf (Berliner) Tagesanfang normalisieren.
- **P3-22 ⚡ (tote Action)** `billing/actions.ts:196-224` `billAllPendingHoursAction` — null Aufrufer, erreichbarer POST-Endpoint; `Number(...?? 19)` liefert bei leerem Feld 0 %. ToDo: ersatzlos entfernen.
- **P3-23** `server/settings/modules.ts:154-170` — `assertModuleEnabled`/`isInvoiceCreationEnabled` haben null Aufrufer; Header verspricht serverseitige Modul-Gates, die nur teils existieren. ToDo: `assertModuleEnabled` in die mutierenden Actions der ungegateten Module einbauen — oder tote Helfer + Kommentar entfernen.
- **P3-24** `settings/smtp.ts:64-75` ≡ `settings/n8n.ts:63-75` (Decrypt-Block mit `catch { '' }`) → Decrypt-Fehler nach Key-Rotation still zu `''`. ToDo: gemeinsamen `readEncryptedSetting()` in `server/crypto/secret-box.ts`, Fehler mit `log.warn`.
- **P3-25** `bwa/projection.ts:69-87` ≡ `bwa/liquidity.ts:36-50` (`monthsCovered`/`PeriodInput`). ToDo: nach `bwa/period.ts` extrahieren.
- **P3-26** `invoicing/zugferd.ts:255-259` — Notiz-Zeilen hart bei 100 Zeichen abgeschnitten (Inhaltsverlust in Archiv-PDF). ToDo: Word-Wrap statt `slice`.
- **P3-27** `components/consent-fields.tsx:149,171` — `key={index}` bei entfernbaren Zeilen → Fokus/DOM-Sprung. ToDo: stabile lokale `id` als key (vor Serialisierung strippen).
- **P3-28 ⚡** `packages/risk-layer/src/client.ts:152-153` — doppeltes Zod-Parse (`parse` verworfen, `mapAnalyse` parst erneut). ToDo: ersten `parse` entfernen.
- **P3-29** Rechnungs-Kleinkram: (a) `invoices/actions.ts:594` Mailfehler still verschluckt → `fireAndForget(...)`; (b) `PositionSchema` (`:37-44`) erlaubt Produkt > `Decimal(12,2)` → Refine ergänzen; (c) `risk/los.ts:265` `tenantSetting.value` unvalidiert gecastet → Zod-Schema.

---

## Quick-Win-Index (⚡, < 1 h)
P0-3-nah nein · **P1-20** (Whitelist-Zeile) · **P1-22/P1-23** (Compose-ENV) ·
**P1-26** (stop_grace_period) · **P2-7** (round2) · **P2-16** (defaultJobOptions) ·
**P2-17** (tz) · **P2-22a** (P2002-Catch) · **P2-25** (ELSTER-Limit) ·
**P3-2** (Secrets argv) · **P3-4** (Heartbeat) · **P3-5** (env-Schema) ·
**P3-6** (n8n-Healthcheck) · **P3-22** (tote Action) · **P3-28** (doppeltes Parse).

## Empfohlene Abarbeitungsreihenfolge für Opus
1. **P0-1..P0-3** (Cross-Tenant, Datenverlust, Auth-Orakel) — je klein, je gravierend.
2. **P1-Authz-Batch (P1-1..P1-9)** — eine Fix-Klasse, gemeinsamer Guardrail-Test.
3. **P1-Race-Batch (P1-10..P1-15)** — eine Fix-Klasse (atomarer Claim).
4. **P1-16..P1-21** (fachliche Rechtsfolgen + stille Ausfälle).
5. **P1-22..P1-26** (Prod-Betrieb, überwiegend Quick Wins).
6. P2 in Themenblöcken (Aufbewahrung → Rechnung → BWA → Betrieb), dann P3.
