# Softwareentwicklungs-, Wartungs- und Freigabeverfahren

Dieses Dokument beschreibt, wie TaxTronik entwickelt, geändert, getestet und
freigegeben wird. Es macht das tatsächlich gelebte Verfahren für Dritte
(insb. Software-Prüfer, vgl. IDW PS 880 n.F. (01.2022), Tz. 54 ff.)
nachvollziehbar. Es beschreibt den Ist-Zustand — Änderungen am Verfahren
werden hier im selben Commit nachgezogen.

## 1. Rollen und Verantwortung

| Rolle | Wer | Verantwortung |
|---|---|---|
| Verantwortlicher Entwickler / Produktverantwortung | Rey Koxha | fachliche Anforderungen, Architektur-Entscheidungen, Code-Review, Freigabe jedes Releases |
| KI-Assistenz | agentenbasiertes Entwicklerwerkzeug | Werkzeug zur Implementierung, Analyse und Dokumentation — **kein** eigenständiger Freigeber; jede Änderung durchläuft die maschinellen Gates (Abschnitt 4) und die menschliche Freigabe |
| Externe Prüfinstanzen | CI-Pipeline (Forgejo Actions), adversariale Security-Reviews | maschinelle bzw. strukturierte unabhängige Kontrolle vor Merge/Release |

Personelles Schlüsselrisiko (Einzelperson) ist bekannt und wird durch
konsequente Dokumentation gemildert: Architektur-Entscheidungen in
[docs/adr/](../adr/), Betriebswissen in [docs/operations/](../operations/),
Einarbeitungspfad in [docs/HANDOFF.md](../HANDOFF.md).

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

## 3. Änderungsverfahren (Entwicklung und Wartung)

Jede Änderung — Feature, Fehlerbehebung, Härtung — folgt demselben Weg:

1. **Anlass festhalten:** fachliche Anforderung, Fehlerbild oder
   Review-/Audit-Befund (Befunde erhalten eine Kennung und werden im
   jeweiligen Dokument unter `docs/` geführt, z. B.
   [docs/security/](../security/)).
2. **Implementierung** auf `main` bzw. Arbeitszweig; Migrationsänderungen
   ausschließlich additiv-vorwärts als neue, datierte Prisma-Migration
   (Expand/Contract-Konvention, siehe
   [docs/operations/release.md](../operations/release.md)).
   **Migrations-Zeitstempel: reales Erstellungsdatum verwenden** (Audit
   2026-07, N-11). Die Migrationen iter77–iter97 tragen vordatierte
   `20260801…`-Präfixe; sie sind appliziert und werden nicht umbenannt.
   Neue Migrationen müssen NACH `20260801002200` (iter97) einsortieren —
   bis zum realen 01.08.2026 heißt das: Präfix fortlaufend ab
   `20260801002300` wählen (nicht `prisma migrate dev` das reale Datum
   generieren lassen: die neue Migration sortierte sonst VOR bereits
   applizierte — `migrate dev` meldet einen Historien-Konflikt und schlägt
   Reset vor, und frische DBs wendeten die Historie in anderer Reihenfolge
   an als bestehende). Ab dem 02.08.2026 gilt wieder: echtes Datum.
3. **Tests zuerst dort, wo der Fehler war:** Fehlerbehebungen erhalten einen
   Regressionstest, der den Fehler vor dem Fix nachweisbar reproduziert.
4. **Review:** Code-Review durch den Verantwortlichen; bei sicherheits- oder
   compliance-relevanten Änderungen zusätzlich strukturierte adversariale
   Reviews (mehrere unabhängige Prüfperspektiven, Ergebnisse in der
   Commit-Historie und den PR-Beschreibungen dokumentiert).
5. **Maschinelle Gates:** Push löst die CI aus (Abschnitt 4). Ein roter Lauf
   blockiert die Freigabe; Gates werden nicht umgangen.
6. **Commit-Hygiene:** thematisch geschnittene Commits mit aussagefähiger
   Beschreibung (was/warum); die Git-Historie ist Teil der
   Änderungsdokumentation.

**Hotfix-Pfad:** identisches Verfahren in verkürzter Taktung — auch ein
Hotfix durchläuft alle CI-Gates und wird als eigenes Release (Patch-Version)
freigegeben. Es gibt keinen Weg, ungeprüften Code in ein Kundensystem zu
bringen: Produktivsysteme installieren ausschließlich getaggte, in der CI
gebaute Registry-Images (siehe Abschnitt 5).

## 4. Qualitätssicherung (maschinelle Kontrollen)

CI-Pipeline (`.forgejo/workflows/ci.yml`), läuft bei jedem Push/PR:

| Gate | Inhalt |
|---|---|
| `quality` | Lint, Typecheck, vollständige Unit-/Komponententests aller Pakete (außer DB-gebundenen), Operator-CLI-Tests (`pnpm test:ops`), Schutzprüfung gegen reale DATEV-Kennungen in Testdaten |
| `db` | Migrationen auf frischer DB, RLS-Cross-Tenant-Tests, Schema-Drift-Check (Schema ↔ Migrationshistorie), Audit-Chain-CLI |
| `restore` | echter Backup→Restore-Roundtrip mit Zeilenzahl-Assertions und Chain-Verifikation auf der wiederhergestellten DB |
| `upgrade-path` | Migrationsstand des letzten Releases → aktuelle Migrationen → RLS-Tests (simuliert das Kunden-Update) |
| `e2e-smoke` | Browser-Smoke-Tests (Playwright) gegen die gebaute App |
| `e2e-paranoid` | umfangreiche Browser-Regression gegen Auth/RBAC, Tenant-Isolation, Compliance, Differential, Concurrency und Upload-Fuzz |
| `security.yml` | wöchentlich + je Push: Dependency-Audit, Secret-Scanning (gitleaks), Logs als Artefakte |
| `build-images.yml` | Validierung der Produktions-Image-Builds |

Zusätzlich **Guard-Tests**, die Verfahrensregeln maschinell erzwingen
(Beispiele: keine ungeprüfte `PrismaClient`-Instanz außerhalb der Allowlist;
ENV-Schema-Validierung; Audit-Trigger-Verhalten). Testnachweise je Lauf
werden als CI-Artefakte archiviert (siehe
[testkonzept.md](testkonzept.md), Abschnitt „Testnachweise").

## 5. Versionsführung und Freigabeverfahren

- **Versionsführung:** Git ist das einzige Quellsystem; jede Änderung ist
  einem Commit mit Autor, Zeitpunkt und Begründung zuordenbar. Releases sind
  annotierte SemVer-Tags (`vMAJOR.MINOR.PATCH`).
- **Freigabe = Tag:** Das Setzen und Pushen eines Versions-Tags ist die
  formale Freigabeentscheidung des Verantwortlichen. Voraussetzung ist ein
  grüner CI-Lauf auf dem getaggten Stand.
- **Programmidentität:** Der Tag-Push baut die Auslieferungs-Images in der
  CI (Trivy-Sicherheitsscan als Gate), pusht sie mit Versions-Tag und
  unveränderlichem Image-Digest in die Registry und versieht sie mit
  Versions-/Commit-Metadaten (OCI-Labels, `APP_VERSION`/`GIT_SHA` zur
  Laufzeit sichtbar in Admin-UI und `/api/health/detail`). Ausgelieferte
  Software ist damit eindeutig und fälschungssicher einem Quellstand
  zuordenbar.
- **Update-Verteilung:** signiertes Update-Manifest (Ed25519, fail-closed)
  mit Release-Notes und Migrations-Kennzeichnung; Einspielen beim Betreiber
  ausschließlich manuell über das dokumentierte Update-Verfahren mit
  automatischem Backup vor jeder Migration und definiertem Rollback-Pfad
  (siehe [docs/operations/release.md](../operations/release.md)).
- **Änderungsdokumentation:** [CHANGELOG.md](../../CHANGELOG.md) führt bis
  zum ersten echten Release den `[Unreleased]`-Arbeitsstand und ab dem ersten
  Release je Version die Änderungen mit Kennzeichnung der für den
  Prüfungs-Scope relevanten Einträge (Grundlage für Folgeprüfungen, vgl.
  IDW PS 880 n.F. (01.2022), Tz. 110).

## 6. Fehlermanagement

1. Eingang (Betreiber-Meldung, Monitoring-Alarm, eigener Befund) →
   Bewertung nach Schwere: *kritisch* (Datenintegrität/Sicherheit/Ausfall) →
   Hotfix-Pfad; *normal* → nächstes reguläres Release.
2. Reproduktion als Test **vor** dem Fix (Regressionsnachweis).
3. Fix + Test durchlaufen alle Gates; der Fix erscheint im CHANGELOG.
4. Compliance-relevante Vorfälle (z. B. Chain-Bruch, Restore-Fehlschlag)
   sind zusätzlich systemseitig protokolliert (Audit-Events, Notifications)
   und damit unabhängig vom Ticket nachweisbar.

## 7. Mitgeltende Dokumente

- [Testkonzept](testkonzept.md) — Testarten, Abdeckung, Nachweise
- [Release-/Update-Prozess](../operations/release.md)
- [Disaster-Recovery-Runbook](../operations/disaster-recovery.md)
- [Architektur](../architecture.md) und [ADRs](../adr/)
- [Gap-Analyse Prüfungsbereitschaft](../compliance/idw-ps880-pruefungsbereitschaft.md)
