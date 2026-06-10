# Test- und Abnahmekonzept

Dieses Dokument beschreibt, **was** bei TaxTronik getestet wird, **wie** und
**womit** — und wie die Durchführung für Dritte nachvollziehbar bleibt
(vgl. IDW PS 880 n.F. (01.2022), Tz. 60, 67 ff.). Es beschreibt den
Ist-Zustand; Änderungen am Testverfahren werden hier nachgezogen.

## 1. Testarten und ihr Zweck

| Testart | Werkzeug/Ort | Zweck | Auslösung |
|---|---|---|---|
| Unit-/Komponententests | Vitest, `**/__tests__/` in allen Paketen | Verarbeitungslogik, Validierungen, Mapping, Fehlerpfade | jeder CI-Lauf |
| Guard-Tests | Vitest (z. B. `prisma-client-guard`, ENV-Schema-Tests) | erzwingen Verfahrensregeln maschinell (kein DB-Zugriff am Kontrollsystem vorbei, keine ungültige Konfiguration) | jeder CI-Lauf |
| RLS-/Integrationstests | Vitest gegen echte Postgres-Instanz (`packages/db`) | Mandantentrennung auf Datenbankebene (Cross-Tenant-Zugriffe müssen scheitern), GwG-Schranken, Audit-Trigger | CI-Job `db` |
| Migrations-/Drift-Tests | Prisma + Drift-Check-Skript | Migrationshistorie erzeugt exakt das deklarierte Schema | CI-Job `db` |
| Restore-Roundtrip | `scripts/restore-selftest.sh` (echter Produktionscode-Pfad) | Backup ist wiederherstellbar UND inhaltlich intakt (Zeilenzahlen, Audit-Hash-Chain auf der wiederhergestellten DB) | CI-Job `restore` |
| Upgrade-Pfad-Test | CI-Job `upgrade-path` | Kunden-Update: Migrationsstand des letzten Releases → aktueller Stand → RLS-Tests | jeder CI-Lauf (aktiv ab erstem Release-Tag) |
| End-to-End-Smoke | Playwright (`apps/e2e`) | kritische Browserpfade gegen die gebaute App (Login, Kernnavigation) | CI-Job `e2e-smoke` |
| Negativtests („gegen das System") | in allen obigen Ebenen | abgelehnte Eingaben, Rückwärts-Übergänge, manipulierte Signaturen, fremde IDs (IDOR), kaputte Tokens — Fehlerfälle sind gleichberechtigte Testfälle | jeder CI-Lauf |
| Schnittstellentests | Vitest (HMAC-Signaturen n8n, Engine-Vertragstests gegen eingefrorene Fixtures, XRechnung-/ZUGFeRD-Erzeugung) | Ein-/Ausgangsschnittstellen mit definierten Erwartungswerten | jeder CI-Lauf |
| Parametertests | ENV-Schema-Tests (`@taxtronik/config`), Modul-Konfigurationstests | variable Steuerungsparameter werden validiert und im Verhalten getestet | jeder CI-Lauf |
| Sicherheits-Scans | gitleaks, `pnpm audit`, Trivy (Release-Images) | Secrets, verwundbare Abhängigkeiten, Image-CVEs | wöchentlich + je Push/Release |
| Strukturierte Sicherheits-Reviews | adversariale Mehrfach-Reviews mit dokumentierten Befunden | Angriffsflächen-Prüfung über automatisierte Tests hinaus | anlassbezogen; Ergebnisse unter `docs/security/` |
| Manuelle Abnahme | Verantwortlicher Entwickler | Bedien-/Sichtprüfung neuer bzw. geänderter Oberflächen vor Freigabe | je Release |

Stand bei Einführung dieses Konzepts: > 750 automatisierte Tests über
11 Pakete; die CI führt **alle** Pakete aus (DB-gebundene Tests im Job `db`
gegen eine echte Postgres-Instanz, alle übrigen im Job `quality`).

## 2. Abdeckungsanspruch je Prüfungs-Scope-Modul

Für die Module des Prüfungs-Scopes (siehe
[Gap-Analyse, Abschnitt 2](../compliance/idw-ps880-pruefungsbereitschaft.md))
gilt verbindlich:

| Modul | Mindestabdeckung |
|---|---|
| Fakturierung | jede Server-Action (Anlage, Änderung, Statusübergänge, Storno), Rechnungsnummern-Vergabe inkl. Eindeutigkeit/Lückenverhalten, Festschreibungs-Schutz (Negativtest: Änderung nach Versand), XRechnung-/ZUGFeRD-Erzeugung gegen Erwartungswerte, GoBD-Archivierungsfluss |
| Dokumentenarchiv | Upload-Validierungen (Größe, Magic-Bytes), Virenscan-Verhalten inkl. Fehlerpfad (infiziert/Scanner down = fail-closed), Schutzstufen/Retention-Zuordnung, Freigabe-Erzwingung serverseitig, Download-/Preview-Autorisierung (IDOR-Negativtests) |
| Audit-Protokollierung | Hash-Chain-Mechanik (Verkettung, Bruch-Erkennung), Versiegelung inkl. TSA-Fehlerpfad, Archiv-Rotation, Verify-Ergebnis-Persistenz |
| Zugriffsschutz | Login-Flows beidseitig (TOTP, Magic-Link inkl. Einmaligkeit/Ablauf/Replay), Rollen-Guards, Lockout-Verhalten, Session-Revalidierung, RLS-Cross-Tenant |
| Backup/Restore | Roundtrip mit Integritäts-Assertions (CI je Lauf), Restore-Drill-Logik, Hash-Verifikation des Backup-Objekts |

Neue Funktionen in Scope-Modulen werden **nicht freigegeben**, bevor die
zugehörigen Tests existieren; Fehlerbehebungen erfordern einen
Regressionstest (siehe
[Entwicklungsverfahren, Abschnitt 6](entwicklungsverfahren.md)).

## 3. Testumgebungen

| Umgebung | Beschreibung |
|---|---|
| CI (maßgeblich) | Forgejo-Runner; je Lauf frische Postgres-18-Instanz (Service-Container), definierte ENV (siehe `ci.yml`), reproduzierbare Installation (`--frozen-lockfile`). Die CI-Umgebung ist die Referenz für alle Testnachweise. |
| Lokal | identischer Stack via Docker Compose (`./scripts/setup.sh`), Demo-Stammdatenbestand über den Seed (`packages/db/seeds/dev.ts`) — Admin-Konto, Beispiel-Mandant, Dokumente. Dieser Seed ist zugleich die Basis des Prüf-Testsystems für eine Softwareprüfung (definierter, reproduzierbarer Stammdatenbestand). |
| Prüf-/Abnahmesystem | für eine externe Prüfung wird ein definierter Release-Stand (Tag + Image-Digest) mit dem Seed-Datenbestand auf dem dokumentierten Compose-Stack bereitgestellt; Hardware-/OS-/DB-Angaben ergeben sich aus der Betriebsdokumentation ([README](../../README.md), [release.md](../operations/release.md)). |

## 4. Testnachweise (Dokumentation der Durchführung)

Nachvollziehbarkeit je Lauf/Release (erwartetes vs. erzieltes Ergebnis,
Vollständigkeit, Abweichungen):

1. **CI-Artefakte je Lauf:** die Jobs `quality`, `db` und `restore` laden
   ihre vollständigen Testprotokolle als Artefakte hoch
   (`testbericht-unit`, `testbericht-db`, `testbericht-restore`); der
   E2E-Job archiviert den Playwright-Report. Ein Testprotokoll weist je
   Testdatei und Testfall Bestehen/Fehlschlag aus.
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

## 5. Grenzen und bewusste Entscheidungen

- **Kein Coverage-Prozentziel:** Maßstab ist die funktionale Abdeckung je
  Scope-Modul (Abschnitt 2) plus verpflichtende Negativ- und
  Regressionstests — ein Zeilenprozentwert erzeugt Scheinsicherheit.
- **E2E bewusst schmal** (Smoke): die fachliche Tiefe liegt in den Unit-/
  Integrationsebenen, wo Fehlerursachen präzise lokalisierbar sind.
- **Lasttests:** bisher nicht etabliert; bekanntes offenes Thema (siehe
  Gap-Analyse) — für die Bescheinigungsfähigkeit nicht vorausgesetzt, für
  den Betrieb größerer Kanzleien geplant.
