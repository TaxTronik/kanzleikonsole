# Release-Rehearsal

Dieses Runbook beschreibt die Generalprobe vor dem ersten echten Release und
vor späteren größeren Releases. Es ersetzt keinen Release-Tag, sondern prüft,
ob ein Tag ohne Überraschungen ausgeliefert werden kann.

## Wann durchführen?

- Vor dem ersten echten Produkt-Release.
- Vor Releases mit Migrationen, Auth-/Cookie-Änderungen, Restore-/Backup-
  Änderungen oder neuen Infrastrukturkomponenten.
- Nach größeren Änderungen an `./taxtronik`, Compose, nginx oder n8n.

## Voraussetzungen

- Frischer Server oder Wegwerf-VM mit Docker.
- DNS/Reverse-Proxy oder lokale Testdomains.
- Echtes SMTP-Test-Relay, kein Mailhog.
- Zugriff auf Forgejo-Registry oder bewusster Lokalbuild.
- Leere Ziel-DB/Volumes.

## Schritt 1: Kandidat einfrieren

```bash
git status --short
pnpm lint
pnpm typecheck
pnpm test
pnpm test:ops
pnpm verify:schema-drift
pnpm verify:chain
```

Der Kandidat darf erst weiter, wenn diese lokalen Checks grün sind und CI auf
dem Commit grün ist, inklusive `restore`, `e2e-smoke` und `e2e-paranoid`.

## Schritt 2: `[Unreleased]` prüfen

`CHANGELOG.md` bleibt bis zum echten Tag auf `[Unreleased]`. Für die Probe wird
geprüft:

- Alle user-/betriebsrelevanten Änderungen sind enthalten.
- Scope-relevante Einträge tragen **[Scope]**.
- Migrationshinweise und manuelle Betreiberhinweise sind erkennbar.

Der Schnitt in einen Versionsabschnitt erfolgt erst beim echten Release-Tag.

## Schritt 3: Deploy auf leerem System

Auf dem Rehearsal-Server:

```bash
git clone <repo-url> taxtronik
cd taxtronik
./taxtronik deploy
```

Erwartung:

- `doctor` endet ohne `FEHLT`.
- App/Worker/n8n starten.
- Admin-Account wird provisioniert.
- Login und TOTP-Einrichtung funktionieren.
- SMTP-Test-Mail kommt an.

## Schritt 4: Betriebs-Surface prüfen

```bash
./taxtronik ps
./taxtronik logs app --tail 80
./taxtronik logs worker --tail 80
./taxtronik backup
```

Zusätzlich:

- Upload eines harmlosen PDF-Dokuments.
- Download/Preview.
- Rechnungstest, falls Fakturierung im Release betroffen ist.
- n8n-Test-Webhook.
- Risk-Layer-Test, falls aktiviert.

## Schritt 5: Restore-Drill

```bash
DATABASE_URL=<rehearsal-db-url> bash scripts/restore-selftest.sh
```

Oder aus der laufenden Installation das letzte Backup in eine Wegwerf-DB
einspielen. Akzeptanz:

- `pg_restore` erfolgreich.
- Zeilenzahl-Assertions erfolgreich.
- `verify:chain` auf wiederhergestellter DB erfolgreich.

## Schritt 6: Update-/Rollback-Pfad

Wenn ein Vor-Release-Stand vorhanden ist:

1. Alten Stand deployen.
2. Testdaten anlegen.
3. Kandidat per `./taxtronik update` einspielen.
4. Smoke durchführen.
5. `./taxtronik rollback <alte-version>` prüfen, sofern keine neue Migration
   den DB-Stand inkompatibel macht.

Wenn noch kein echtes Release existiert, wird dieser Schritt als trockenes
Verfahren dokumentiert und beim ersten Patch-Release nachgeholt.

## Schritt 7: Ergebnis dokumentieren

Mindestens festhalten:

- Commit-SHA des Kandidaten.
- Datum/Uhrzeit.
- Server/OS/Docker-Version.
- Registry- oder Lokalbuild-Modus.
- Ergebnis Bootstrap.
- Ergebnis Restore-Drill.
- Ergebnis E2E/CI.
- Offene Abweichungen.

## Go/No-Go

Go nur, wenn:

- CI vollständig grün.
- Rehearsal-Bootstrap erfolgreich.
- Restore-Drill erfolgreich.
- SMTP/n8n/Risk-Layer-Konfiguration nachvollziehbar.
- Changelog gepflegt.
- Rollback- oder Restore-Pfad für die konkreten Migrationen beschrieben.
