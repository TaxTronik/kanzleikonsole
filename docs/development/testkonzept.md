# Test- und Abnahmekonzept

- **Dokumentstatus:** gültige interne Verfahrensbeschreibung mit ausgewiesenen
  Lücken
- **Letzte inhaltliche Prüfung:** 2026-08-30

Dieses Dokument beschreibt, **was** bei TaxTronik getestet wird, **wie** und
**womit** — und wie die Durchführung für Dritte nachvollziehbar bleibt
(vgl. IDW PS 880 n.F. (01.2022), Tz. 60, 67 ff.). Es beschreibt den
Ist-Zustand; Änderungen am Testverfahren werden hier nachgezogen.

## 1. Testarten und ihr Zweck

| Testart                           | Werkzeug/Ort                                                                                                 | Zweck                                                                                                                                               | Auslösung                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Unit-/Komponententests            | Vitest, `**/__tests__/` in allen Paketen                                                                     | Verarbeitungslogik, Validierungen, Mapping, Fehlerpfade                                                                                             | jeder CI-Lauf                                                            |
| Guard-Tests                       | Vitest (z. B. `prisma-client-guard`, ENV-Schema-Tests)                                                       | erzwingen Verfahrensregeln maschinell (kein DB-Zugriff am Kontrollsystem vorbei, keine ungültige Konfiguration)                                     | jeder CI-Lauf                                                            |
| Operator-CLI-Tests                | `scripts/tests/ops-lib.test.sh`                                                                              | `./taxtronik doctor`, SMTP-Prod-Gates, Risk-Layer-Paarung und Build-Cache-Prune ohne echten Docker-Deploy                                           | CI-Job `quality`                                                         |
| RLS-/Integrationstests            | Vitest gegen echte Postgres-Instanz (`packages/db`)                                                          | Mandantentrennung auf Datenbankebene (Cross-Tenant-Zugriffe müssen scheitern), GwG-Schranken, Audit-Trigger                                         | CI-Job `db`                                                              |
| Migrations-/Drift-Tests           | Prisma + Drift-Check-Skript                                                                                  | Migrationshistorie erzeugt exakt das deklarierte Schema                                                                                             | CI-Job `db`                                                              |
| Restore-Roundtrip                 | `scripts/restore-selftest.sh` (echter Produktionscode-Pfad)                                                  | Backup ist wiederherstellbar UND inhaltlich intakt (Zeilenzahlen, Audit-Hash-Chain auf der wiederhergestellten DB)                                  | CI-Job `restore`                                                         |
| Upgrade-Pfad-Test                 | CI-Job `upgrade-path`                                                                                        | Kunden-Update: Migrationsstand des letzten Releases → aktueller Stand → RLS-Tests                                                                   | jeder CI-Lauf (aktiv ab erstem Release-Tag)                              |
| End-to-End-Smoke                  | Playwright (`apps/e2e`)                                                                                      | kritische Browserpfade gegen die gebaute App (Login, Kernnavigation)                                                                                | CI-Job `e2e-smoke`                                                       |
| Negativtests („gegen das System") | in allen obigen Ebenen                                                                                       | abgelehnte Eingaben, Rückwärts-Übergänge, manipulierte Signaturen, fremde IDs (IDOR), kaputte Tokens — Fehlerfälle sind gleichberechtigte Testfälle | jeder CI-Lauf                                                            |
| Schnittstellentests               | Vitest (HMAC-Signaturen n8n, Engine-Vertragstests gegen eingefrorene Fixtures, XRechnung-/ZUGFeRD-Erzeugung) | Ein-/Ausgangsschnittstellen mit definierten Erwartungswerten                                                                                        | jeder CI-Lauf                                                            |
| Parametertests                    | ENV-Schema-Tests (`@taxtronik/config`), Modul-Konfigurationstests                                            | variable Steuerungsparameter werden validiert und im Verhalten getestet                                                                             | jeder CI-Lauf                                                            |
| Dependency-/Secret-Scans          | gitleaks, `pnpm audit`                                                                                       | Secrets und verwundbare Abhängigkeiten                                                                                                              | täglich; Pull Requests; Pushes auf `main`/`develop`; Release-Aufruf      |
| Release-Image-Scan                | Trivy gegen die gebauten Release-Images                                                                      | Image-CVEs vor der Veröffentlichung                                                                                                                 | ausschließlich im Release-Workflow                                       |
| Strukturierte Sicherheits-Reviews | adversariale Mehrfach-Reviews mit dokumentierten Befunden                                                    | Angriffsflächen-Prüfung über automatisierte Tests hinaus                                                                                            | anlassbezogen; Ergebnisse in Commit-Historie und Befundkennungen am Code |
| Statische A11Y-Prüfung            | `eslint-plugin-jsx-a11y` im Repository-Lint                                                                  | statisch erkennbare Barrieren bei Semantik, Namen, Labels, Rollen und Tastaturereignissen                                                           | jeder CI-Lauf im Job `quality`                                           |
| A11Y-End-to-End                   | Playwright + Axe (`apps/e2e/tests/12-accessibility.spec.ts`)                                                 | ausgewählte öffentliche und authentifizierte Kernseiten gegen WCAG-A/AA-Tags, Dark Mode, 320-Pixel-Reflow, Skip-Link und mobile Navigation          | CI-Job `e2e-paranoid`; lokal gezielt mit `pnpm a11y:e2e`                 |
| Manuelle Abnahme                  | Verantwortlicher Entwickler                                                                                  | Bedien-/Sichtprüfung neuer bzw. geänderter Oberflächen vor Freigabe                                                                                 | je Release                                                               |

Die Anzahl erfolgreicher Testfälle ist kein dauerhafter Dokumentationswert und
keine aktuelle Freigabegarantie. Ein belastbarer Stand muss aus einem
reproduzierbaren vollständigen CI-Lauf für einen benannten Commit samt
Testreport abgeleitet werden. DB-gebundene Tests laufen im Job `db` gegen eine
echte Postgres-Instanz, die übrigen Pakete im Job `quality`.
Plattformabhängige Evidence-Tests dürfen lokal nur mit ausgewiesenem
Skip-Grund fehlen; in CI ist die erforderliche OpenSSL-Unterstützung ein Gate.
Die A11Y-Gates und ihre Grenzen sind in der
[Ist-/Gap-Dokumentation zur Barrierefreiheit](../assurance/barrierefreiheit.md)
beschrieben. Insbesondere ersetzt ein bestandener Axe-Lauf keine manuelle
Tastatur-, Screenreader-, Reflow-, Kontrast- und Reduced-Motion-Prüfung.

## 2. Zielabdeckung und belegter Ist-Stand

Für die Module des Prüfungs-Scopes (siehe
[Gap-Analyse, Abschnitt 2](../compliance/idw-ps880-pruefungsbereitschaft.md))
gilt folgende Zielabdeckung. Die Tabelle ist ein **Freigabe-Soll**, keine
pauschale Behauptung, jede einzelne Exportfunktion sei bereits direkt
Action-level getestet:

| Modul                 | Mindestabdeckung                                                                                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fakturierung          | jede Server-Action (Anlage, Änderung, Statusübergänge, Storno), Rechnungsnummern-Vergabe inkl. Eindeutigkeit/Lückenverhalten, Festschreibungs-Schutz (Negativtest: Änderung nach Versand), XRechnung-/ZUGFeRD-Erzeugung gegen Erwartungswerte, GoBD-Archivierungsfluss |
| Dokumentenarchiv      | Upload-Validierungen (Größe, Magic-Bytes), Virenscan-Verhalten inkl. Fehlerpfad (infiziert/Scanner down = fail-closed), Schutzstufen/Retention-Zuordnung, Freigabe-Erzwingung serverseitig, Download-/Preview-Autorisierung (IDOR-Negativtests)                        |
| Audit-Protokollierung | Hash-Chain-Mechanik (Verkettung, Bruch-Erkennung), Versiegelung inkl. TSA-Fehlerpfad, Archiv-Rotation, Verify-Ergebnis-Persistenz                                                                                                                                      |
| Zugriffsschutz        | Login-Flows beidseitig (TOTP, Magic-Link inkl. Einmaligkeit/Ablauf/Replay), Rollen-Guards, Lockout-Verhalten, Session-Revalidierung, RLS-Cross-Tenant                                                                                                                  |
| Backup/Restore        | Roundtrip mit Integritäts-Assertions (CI je Lauf), Restore-Drill-Logik, Hash-Verifikation des Backup-Objekts                                                                                                                                                           |

Für eine **formale PS-880-Scope-Freigabe** müssen die zugehörigen Tests
vorliegen; Fehlerbehebungen erfordern einen Regressionstest (siehe
[Entwicklungsverfahren, Abschnitt 6](entwicklungsverfahren.md)). Ein
Produktrelease kann technisch auch Funktionen außerhalb dieses formalen
Nachweisumfangs enthalten. Solange die hier genannten Lücken bestehen, darf es
aber nicht als vollständig nach diesem Scope abgedeckt dargestellt werden.

Der belegte Ist-Stand wird aus den tatsächlich ausgeführten CI-Testdateien und
Artefakten abgeleitet, nicht aus der Soll-Tabelle. Insbesondere sind bei der
Fakturierung Nummernvergabe, Statusmatrix, Festschreibungs-Trigger,
Archivierung, USt-/E-Rechnungs-Generatoren und Storno-Hilfslogik automatisiert
belegt. Für `markPaidAction`, den vollständigen orchestrierten
`cancelInvoiceAction`-Korrekturfluss und `uploadExternalInvoiceAction` besteht
derzeit kein eigener Action-Level-Test. Die bereits existierende Version
`v0.2.1` ist deshalb kein Beleg einer vollständigen PS-880-Scope-Testfreigabe.
Die Lücke darf in einem Prüfbericht nicht als abgedeckt ausgewiesen werden und
ist vor einer entsprechenden formalen Freigabe durch direkte Tests zu
schließen.

## 3. Testumgebungen

| Umgebung            | Beschreibung                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI (maßgeblich)     | Forgejo-Runner; je Lauf frische Postgres-18-Instanz (Service-Container), im Workflow definierte ENV und Installation mit `--frozen-lockfile`. Runner-Host, Kernel und Ressourcen sind nicht allein aus `ci.yml` eingefroren und müssen im Release-Evidence-Satz ergänzt werden.                                                                           |
| Lokal               | funktional vergleichbarer Docker-Compose-Stack (`./scripts/setup.sh`) mit Demo-Stammdaten aus `packages/db/seeds/dev.ts`. Image-Varianten, Host-OS, Ports, Ressourcen und optionale Dienste können von CI/Produktion abweichen; lokale Ergebnisse sind deshalb kein Ersatz für den maßgeblichen Release-Lauf.                                             |
| Prüf-/Abnahmesystem | wird für den konkreten Auftrag aus einem Release-Tag samt beiden Image-Digests bereitgestellt. Hardware, OS/Kernel, Compose-/DB-Versionen, Seed-Hash, Datenvolumen, Fälle und Erwartungswerte werden in der auszufüllenden [Prüfumgebung](../assurance/pruefumgebung.md) festgehalten; README und Release-Runbook allein enthalten diese Ist-Daten nicht. |

## 4. Testnachweise (Dokumentation der Durchführung)

Nachvollziehbarkeit je Lauf/Release (erwartetes vs. erzieltes Ergebnis,
Vollständigkeit, Abweichungen):

1. **CI-Artefakte je Lauf:** die Jobs `quality`, `db` und `restore` laden
   ihre vollständigen Testprotokolle als Artefakte hoch
   (`testbericht-unit`, `testbericht-ops`, `testbericht-db`,
   `testbericht-restore`); die E2E-Jobs archivieren Playwright-Reports. Ein
   Testprotokoll weist je Testdatei und Testfall Bestehen/Fehlschlag aus. Die
   Workflows fordern eine Aufbewahrung von 90 Tagen an; eine kürzere
   Instanzrichtlinie kann diese Frist begrenzen.
2. **Job-Logs:** alle übrigen Schritte (Upgrade-Pfad, Drift-Check, Builds)
   sind über die persistierten CI-Logs des jeweiligen Laufs nachvollziehbar.
3. **Release-Bezug:** maßgeblich für ein Release ist der CI-Lauf des
   getaggten Commits (Tag → Commit → Lauf → Artefakte ist eine eindeutige
   Kette; die Programmidentität der ausgelieferten Images ist über
   Image-Digest und `GIT_SHA` an denselben Commit gebunden).
4. **Abweichungen:** ein roter Lauf blockiert die Freigabe; nach einem Fix
   entsteht ein neuer vollständiger Lauf (kein partielles „Nachtesten" am
   Gate vorbei). Erkannte Fehler und ihre Wiederholungstests sind über
   Commit (Regressionstest) + CHANGELOG nachvollziehbar.
5. **Release-Evidence:** Für einen Prüf-Release werden relevante Logs,
   Reports, SBOMs, Scan-Ergebnisse und Manifeste heruntergeladen, gehasht und
   mit Freigabe und Abweichungen in der
   [Release-Evidence-Matrix](../assurance/ps880-release-evidence.md) gebunden.
   Erst diese tatsächlich befüllte und nach vereinbarter Frist extern gegen
   Änderung geschützte Ablage ist der langfristige Prüfnachweis; die Vorlage
   oder ein flüchtiges CI-Artefakt allein ist es nicht.

## 5. Grenzen und bewusste Entscheidungen

- **Kein Coverage-Prozentziel:** Maßstab ist die funktionale Abdeckung je
  Scope-Modul (Abschnitt 2) plus verpflichtende Negativ- und
  Regressionstests — ein Zeilenprozentwert erzeugt Scheinsicherheit.
- **E2E zweistufig:** `e2e-smoke` bleibt schnell und klein; die umfangreiche
  `e2e-paranoid`-Suite bleibt als breite Release-Regression bestehen
  (Auth/RBAC, Tenant-Isolation, Compliance, Differential, Concurrency,
  Upload-Fuzz). Fachliche Detailtiefe liegt zusätzlich in Unit-/Integrations-
  tests, wo Fehlerursachen präzise lokalisierbar sind.
- **Lasttests:** bisher nicht etabliert. Ob und in welchem Umfang sie für den
  konkreten Prüfungsauftrag und das zugesagte Mengengerüst erforderlich sind,
  ist risikobasiert mit dem Prüfer festzulegen; bis dahin bleiben
  Performancegrenzen unbestätigt.

## 6. Barrierefreiheitsprüfung

Zielniveau der Weboberflächen ist WCAG 2.2 AA. Das Ziel ist keine pauschale
Konformitätsbehauptung. Automatisierte Prüfungen bestehen aus drei Schichten:

1. `eslint-plugin-jsx-a11y` verhindert neue statisch erkennbare Muster im
   normalen Lint-Gate;
2. Vitest-Regressionstests sichern gemeinsame Shell-, Dialog-, Such-,
   Formular-, Editor- und Kontrastverträge;
3. Axe läuft mit Playwright auf einem repräsentativen Satz öffentlicher und
   authentifizierter Seiten und hängt Befunde an den Testbericht.

Für die Abnahme müssen zusätzlich die geänderten und risikobehafteten
Bedienwege mit Tastatur und der festgelegten Screenreader-/Browser-Matrix
geprüft werden. Dabei sind Light/Dark Mode, Forced Colors, Reduced Motion,
200-/400-Prozent-Zoom, 320-CSS-Pixel-Reflow, dynamische Statusmeldungen und
Whitelabel-Farben einzubeziehen. Die konkrete Durchführung wird je Release
protokolliert; diese Verfahrensbeschreibung allein ist kein Nachweis eines
erfolgreichen Tests. Vollständiger Ist-Stand, Routenscope und bekannte Grenzen
stehen in der
[Barrierefreiheitsdokumentation](../assurance/barrierefreiheit.md).
