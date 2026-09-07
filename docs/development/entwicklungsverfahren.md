# Softwareentwicklungs-, Wartungs- und Freigabeverfahren

- **Dokumentstatus:** gültige interne Verfahrensbeschreibung
- **Verantwortung:** Produktverantwortung
- **Letzte inhaltliche Prüfung:** 2026-08-23

Dieses Dokument beschreibt, wie TaxTronik entwickelt, geändert, getestet und
freigegeben wird. Es macht das eingeführte Verfahren für Dritte
(insb. Software-Prüfer, vgl. IDW PS 880 n.F. (01.2022), Tz. 54 ff.)
nachvollziehbar. Eine Verfahrensbeschreibung ist noch kein Nachweis ihrer
Durchführung; diese wird je Release über CI-, Review- und Freigabeartefakte
belegt. Änderungen am Verfahren werden hier im selben Commit nachgezogen.

## 1. Rollen und Verantwortung

| Rolle                                              | Besetzung/Beleg                                       | Verantwortung                                                                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verantwortlicher Entwickler / Produktverantwortung | Rey Koxha                                             | Anforderungen koordinieren, Architektur-Entscheidungen, Code-Review und betriebliche Release-Entscheidung                                                                          |
| Fachlicher Reviewer                                | für jede Freigabe konkret zu benennender Berufsträger | steuerliche, rechtliche und kanzleifachliche Beurteilung; nur diese Rolle darf einen Fachkatalogeintrag fachlich freigeben                                                         |
| KI-Assistenz                                       | agentenbasiertes Entwicklerwerkzeug                   | Werkzeug zur Implementierung, Analyse und Dokumentation — **kein** eigenständiger Freigeber; jede Änderung durchläuft maschinelle Gates und die erforderliche menschliche Freigabe |
| Maschinelle Kontrollen                             | Forgejo Actions                                       | reproduzierbare Prüfungen nach Abschnitt 4; keine Person, keine unabhängige Prüfung und kein Ersatz für Fach- oder Release-Freigabe                                                |
| Unabhängige Prüfer                                 | erst im konkreten Auftrag zu benennen                 | Prüfungsumfang, Prüfungshandlungen und Prüfungsurteil; nicht durch CI, KI-Review oder Repository-Autoren vorweggenommen                                                            |

Personelles Schlüsselrisiko und geringe Funktionstrennung sind bekannt. Sie
werden durch Dokumentation und maschinelle Kontrollen gemildert, aber nicht
beseitigt: Architektur-Entscheidungen in
[docs/adr/](../adr/), Betriebswissen in [docs/operations/](../operations/),
aktueller Einarbeitungs- und Übergabepfad in
[docs/HANDOFF.md](../HANDOFF.md).

## 2. Entwicklungsumgebung und Standards

- **Monorepo** (pnpm + Turborepo): `apps/web` (Next.js), `apps/worker`
  (BullMQ), `apps/e2e` (Playwright), `packages/*` mit klaren Verträgen.
  Versionsstände aller Abhängigkeiten sind über `pnpm-lock.yaml` fixiert;
  Installation ausschließlich mit `--frozen-lockfile`.
- **Programmierstandards werden maschinell erzwungen**, nicht nur empfohlen:
  TypeScript strict (`tsconfig.base.json`), ESLint (`eslint.config.mjs`),
  Prettier (`.prettierrc`), EditorConfig. Verstöße brechen die CI.
- **Namens-/Strukturkonventionen:** Server-Logik unter `src/server/<domäne>/`,
  Server Actions je Route in `actions.ts` mit zod-validierten Inputs,
  Datenbankzugriff ausschließlich über `withTenantContext` (RLS-Kontext);
  Ausnahmen sind testseitig gesperrt (siehe Guard-Tests, Abschnitt 4).
- **Kommentar-Konvention:** Nicht-offensichtliche Entscheidungen werden am
  Code begründet und tragen eine Befund-/Audit-Referenz (z. B. `H7`, `P-2`,
  `Audit 2026-06 Befund 3`), sodass die Herkunft jeder Härtung
  nachvollziehbar bleibt.
- **Dokumentationspflicht:** Jede Änderung, die Verhalten, Betrieb oder
  Bedienung ändert, aktualisiert die betroffene Dokumentation (Anwender-,
  Technik-, Betriebsdoku) **im selben Commit**.
- **Fachkatalogpflicht:** Änderungen an steuerlicher, rechtlicher,
  compliance-relevanter oder kanzleifachlicher Workflow-Logik aktualisieren
  zusätzlich die betroffenen Regeln im
  [Fachkatalog](../fachkatalog/README.md). Fachliche Freigaben dürfen nur durch
  einen dokumentierten Berufsträger-Review entstehen.

## 3. Änderungsverfahren (Entwicklung und Wartung)

Für Änderungen an Setup und Launcher gelten zusätzlich die lokalen
[Regressionstests der Windows-Hilfsskripte](windows-hilfsskripte.md).

Jede Änderung — Feature, Fehlerbehebung, Härtung — folgt demselben Weg:

1. **Anlass festhalten:** fachliche Anforderung, Fehlerbild oder
   Review-/Audit-Befund (Befunde erhalten eine Kennung und werden im
   jeweiligen Dokument unter `docs/` geführt, z. B. im
   [Assurance- und Bedrohungsmodell](../assurance/assurance-model.md)).
2. **Implementierung** auf `main` bzw. Arbeitszweig; Migrationsänderungen
   ausschließlich additiv-vorwärts als neue, datierte Prisma-Migration
   (Expand/Contract-Konvention, siehe
   [docs/operations/release.md](../operations/release.md)).
   **Migrations-Zeitstempel:** Das Verzeichnis erhält den tatsächlichen
   Erstellungszeitpunkt und muss lexikografisch hinter der jüngsten vorhandenen
   Migration liegen. Historische, bereits applizierte Migrationen werden auch
   bei unglücklicher Benennung niemals umbenannt oder nachträglich geändert.
   Ledger-, Line-Ending-, Deploy- und Drift-Prüfungen sind vor Freigabe Pflicht.
3. **Tests zuerst dort, wo der Fehler war:** Fehlerbehebungen erhalten einen
   Regressionstest, der den Fehler vor dem Fix nachweisbar reproduziert.
4. **Review:** Code-Review durch den Verantwortlichen; bei sicherheits- oder
   compliance-relevanten Änderungen zusätzlich strukturierte adversariale
   Reviews (mehrere unabhängige Prüfperspektiven, Ergebnisse in der
   Commit-Historie und den PR-Beschreibungen dokumentiert).
5. **Maschinelle Gates:** Pull Requests sowie Pushes auf `main`/`develop`
   lösen die CI aus (Abschnitt 4); der Release-Workflow ruft CI und Security
   für den Tag-Commit erneut auf. Ein roter Release-Lauf blockiert die
   Veröffentlichung der verifizierten Release-Artefakte.
6. **Commit-Hygiene:** thematisch geschnittene Commits mit aussagefähiger
   Beschreibung (was/warum); die Git-Historie ist Teil der
   Änderungsdokumentation.

**Hotfix-Pfad:** identisches Verfahren in verkürzter Taktung — auch ein
formaler Hotfix durchläuft alle CI-Gates und wird als eigenes Release
(Patch-Version) freigegeben. Für den PS-880-Nachweisumfang gilt ausschließlich
der Release-Kanal mit CI-gebauten, digest-gepinnten Images. Der technisch
unterstützte Source-Kanal baut dagegen lokal und kann deshalb nicht pauschal
als dasselbe geprüfte Artefakt gelten; er ist ohne gesonderte Build-, Test- und
Freigabe-Evidence vom formalen Scope ausgeschlossen.

## 4. Qualitätssicherung (maschinelle Kontrollen)

CI-Pipeline (`.forgejo/workflows/ci.yml`), läuft bei Pull Requests, Pushes auf
`main`/`develop` und als wiederverwendeter Workflow im Release-Lauf:

| Gate               | Inhalt                                                                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality`          | Lint, Typecheck, vollständige Unit-/Komponententests aller Pakete (außer DB-gebundenen), Operator-CLI-Tests (`pnpm test:ops`), Schutzprüfung gegen reale DATEV-Kennungen in Testdaten                                            |
| `db`               | Migrationen auf frischer DB, RLS-Cross-Tenant-Tests, Schema-Drift-Check (Schema ↔ Migrationshistorie), Audit-Chain-CLI                                                                                                           |
| `restore`          | echter Backup→Restore-Roundtrip mit Zeilenzahl-Assertions und Chain-Verifikation auf der wiederhergestellten DB                                                                                                                  |
| `upgrade-path`     | Migrationsstand des letzten Releases → aktuelle Migrationen → RLS-Tests (simuliert das Kunden-Update)                                                                                                                            |
| `e2e-smoke`        | Browser-Smoke-Tests (Playwright) gegen die gebaute App                                                                                                                                                                           |
| `e2e-paranoid`     | umfangreiche Browser-Regression gegen Auth/RBAC, Tenant-Isolation, Compliance, Differential, Concurrency und Upload-Fuzz                                                                                                         |
| `security.yml`     | täglich, bei Pull Requests und Pushes auf `main`/`develop`: Dependency-Audit (blockierend prod/high, zusätzlich nicht-blockierender Vollauf über den gesamten Graphen inkl. Dev), Secret-Scanning (gitleaks), Logs als Artefakte |
| `build-images.yml` | Validierung der Produktions-Image-Builds                                                                                                                                                                                         |

Zusätzlich **Guard-Tests**, die Verfahrensregeln maschinell erzwingen
(Beispiele: keine ungeprüfte `PrismaClient`-Instanz außerhalb der Allowlist;
ENV-Schema-Validierung; Audit-Trigger-Verhalten). Testnachweise je Lauf
werden als zeitlich begrenzte CI-Artefakte gespeichert (siehe
[testkonzept.md](testkonzept.md), Abschnitt „Testnachweise").
Der Quality-Job validiert außerdem den Fachkatalog, seine lokalen Nachweise und
die deterministisch erzeugten Mensch-/KI-Indizes (`pnpm fachkatalog:check`). Das
zusätzliche Diff-Gate ordnet Änderungen an überwachten Fach- und Prisma-Pfaden
konkret einer geänderten Regel oder einer strukturierten, unveränderlichen
Ausnahme zu (`pnpm fachkatalog:diff`).

## 5. Versionsführung und Freigabeverfahren

- **Versionsführung:** Git ist das einzige Quellsystem; jede Änderung ist
  einem Commit mit Autor, Zeitpunkt und Begründung zuordenbar. Releases sind
  annotierte SemVer-Tags (`vMAJOR.MINOR.PATCH`).
- **Formale Release-Freigabe = Tag plus grüner Release-Lauf:** Das Setzen und
  Pushen eines annotierten Versions-Tags ist die menschliche
  Release-Entscheidung. Verwendbare Release-Artefakte entstehen erst, wenn der
  vollständige CI-/Security-Lauf dieses Tags bestanden wurde und das signierte
  Manifest beide Image-Digests an den Tag-Commit bindet.
- **Programmidentität:** Der Tag-Push baut die Auslieferungs-Images in der
  CI (Trivy-Sicherheitsscan als Gate), pusht sie mit Versions-Tag und
  unveränderlichem Image-Digest in die Registry und versieht sie mit
  Versions-/Commit-Metadaten (OCI-Labels, `APP_VERSION`/`GIT_SHA` zur
  Laufzeit sichtbar in Admin-UI und `/api/health/detail`). Ausgelieferte
  Software ist damit im verifizierten Release-Kanal eindeutig einem Quellstand
  zuordenbar. Das ist eine Integritäts- und Identitätskontrolle, keine Aussage
  über fachliche Fehlerfreiheit.
- **Update-Verteilung:** signiertes Update-Manifest (Ed25519, fail-closed)
  mit Release-Notes und Migrations-Kennzeichnung; Einspielen beim Betreiber
  ausschließlich manuell über das dokumentierte Update-Verfahren mit
  automatischem Backup vor jeder Migration und definiertem Rollback-Pfad
  (siehe [docs/operations/release.md](../operations/release.md)).
- **Änderungsdokumentation:** [CHANGELOG.md](../../CHANGELOG.md) führt den
  `[Unreleased]`-Arbeitsstand und je Release einen versionierten Abschnitt mit
  Kennzeichnung der für den
  Prüfungs-Scope relevanten Einträge (Grundlage für Folgeprüfungen, vgl.
  IDW PS 880 n.F. (01.2022), Tz. 110).

## 6. Fehlermanagement

1. Eingang (Betreiber-Meldung, Monitoring-Alarm, eigener Befund) →
   Bewertung nach Schwere: _kritisch_ (Datenintegrität/Sicherheit/Ausfall) →
   Hotfix-Pfad; _normal_ → nächstes reguläres Release.
2. Reproduktion als Test **vor** dem Fix (Regressionsnachweis).
3. Fix + Test durchlaufen alle Gates; der Fix erscheint im CHANGELOG.
4. Compliance-relevante Vorfälle (z. B. Chain-Bruch, Restore-Fehlschlag)
   sind zusätzlich systemseitig protokolliert (Audit-Events, Notifications)
   und damit unabhängig vom Ticket nachweisbar.

## 7. Dokumentenlenkung

Diese Regeln gelten ab diesem Dokumentstand für Dateien unter `docs/`:

1. **Dokumenttyp kenntlich machen:** gültige Verfahrens-/Betriebsbeschreibung,
   Anwenderhilfe, Fachregel, Vorlage, Konzept/Zielbild oder historisches
   Archiv. Die zentrale Einordnung steht im [Doku-Index](../README.md).
2. **Änderung im selben Commit:** Verhalten, Betrieb, Testverfahren oder
   fachliche Logik und ihre Dokumentation werden gemeinsam geändert. Lokale
   Links werden durch `pnpm docs:check` technisch geprüft.
3. **Freigaben trennen:** Produktverantwortung gibt Releases frei;
   Berufsträger geben Fachkatalogregeln frei; unabhängige Prüfer erteilen nur
   im Prüfungsauftrag ein Prüfungsurteil. Ein Commit oder Inhalts-Hash belegt
   den Stand, authentifiziert allein aber keine fachliche Freigabe.
4. **Review-Anlass:** betroffene Dokumente werden bei jeder relevanten
   Änderung und zusätzlich vor einem formalen Release-/Prüfnachweis geprüft.
   Der jeweilige Evidence-Satz hält Reviewer, Datum, Commit und Abweichungen
   fest. Eine pauschale periodische Prüfung darf nicht behauptet werden, wenn
   sie nicht tatsächlich dokumentiert wurde.
5. **Ablösung:** überholte Dokumente werden nicht still weiterverwendet. Sie
   erhalten eine Archivwarnung, werden nach `docs/archive/` verschoben und aus
   aktuellen Indizes entfernt; nötige historische Links bleiben erhalten.
6. **Offene organisatorische Grenze:** Derzeit erzwingt keine `CODEOWNERS`-
   Regel eine personenbezogene Zweitfreigabe aller Dokumente. Dieses Risiko
   bleibt in der PS-880-Gap-Analyse offen und darf nicht durch den Link- oder
   Fachkatalog-Validator als geschlossen dargestellt werden.

## 8. Mitgeltende Dokumente

- [Testkonzept](testkonzept.md) — Testarten, Abdeckung, Nachweise
- [Release-/Update-Prozess](../operations/release.md)
- [Disaster-Recovery-Runbook](../operations/disaster-recovery.md)
- [Architektur](../architecture.md) und [ADRs](../adr/)
- [Gap-Analyse Prüfungsbereitschaft](../compliance/idw-ps880-pruefungsbereitschaft.md)
- [Prüfumgebung](../assurance/pruefumgebung.md) und
  [Release-Evidence](../assurance/ps880-release-evidence.md)
