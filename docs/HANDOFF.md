# Aktuelle Übergabe und Einarbeitung

Diese Seite ist der kurze, dauerhaft gepflegte Einstieg für Personen, die eine
Arbeit am Repository übernehmen. Sie ist kein Sprintbericht und behauptet
keinen bestimmten Release- oder CI-Stand. Den Dokumentationseinstieg nach
Zielgruppe bietet der [Dokumentationsindex](README.md).

## In welcher Reihenfolge einlesen?

1. [Projekt-README](../README.md): Voraussetzungen, lokales Setup und
   Produktivbetrieb.
2. [Funktionsumfang](../FEATURES.md): vorhandene Funktionen und ausdrücklich
   benannte Grenzen des Feature-Katalogs.
3. [Architektur](architecture.md) und [ADRs](adr/README.md): Systemaufbau und
   begründete Architekturentscheidungen.
4. [Entwicklungsverfahren](development/entwicklungsverfahren.md) und
   [Testkonzept](development/testkonzept.md): Änderung, Prüfung und Freigabe.
5. [Fachkatalog](fachkatalog/README.md): steuerliche, rechtliche,
   compliance-relevante und kanzleifachliche Regeln samt Prüfstatus und
   Nachweisen.
6. [Assurance-Modell](assurance/assurance-model.md) und
   [bekannte Grenzen](assurance/known-limits.md): Sicherheitsannahmen,
   Kontrollen und offene Einschränkungen.

Die Dokumentation zur Prüfungsbereitschaft ist eine interne Gap-Analyse und
kein Testat:
[IDW-PS-880-Prüfungsbereitschaft](compliance/idw-ps880-pruefungsbereitschaft.md).

## Lokale Arbeitsumgebung

Voraussetzungen sind Docker, Node.js gemäß `.nvmrc` beziehungsweise
`package.json` und die dort festgelegte pnpm-Version. Das geführte Setup läuft
je nach Umgebung so:

```bash
./scripts/setup.sh
```

```powershell
.\scripts\setup.ps1
```

Danach können Web-App und Worker getrennt gestartet werden:

```bash
pnpm --filter @taxtronik/web dev
pnpm --filter @taxtronik/worker dev
```

Die vollständigen Setup-, Reset- und Diensthinweise stehen im
[Projekt-README](../README.md#entwicklung). Produktivsysteme werden
ausschließlich über die dokumentierte
[Operator-CLI](../README.md#produktivbetrieb) und die
[Betriebsrunbooks](operations/day-2-operations.md) verwaltet.

## Verbindliche Leitplanken für Änderungen

- Vor Änderungen an fachlicher Logik gelten die Regeln in
  [`AGENTS.md`](../AGENTS.md). Betroffene Fachregeln vollständig lesen und ihre
  IDs in Tests und Änderungsdokumentation nennen.
- Fachkatalog, Umsetzungshinweise und Nachweise werden bei verändertem
  Fachverhalten im selben Commit aktualisiert. Nur ein dokumentierter
  Berufsträger darf eine fachliche Freigabe erteilen.
- Verhalten, Bedienung und Betrieb werden im selben Commit in der passenden
  Anwender-, Technik- oder Betriebsdokumentation nachgezogen.
- Neue Datenbankänderungen folgen dem Migrationsverfahren im
  [Entwicklungsverfahren](development/entwicklungsverfahren.md); vorhandene
  Migrationen werden nicht nachträglich umgeschrieben.
- Geheimnisse, lokale Zugangsdaten und personenbezogene Daten gehören weder in
  Übergaben noch in Commits oder Testartefakte.

## Mindestprüfung vor einer Übergabe

Der konkrete Änderungsumfang bestimmt die zusätzlichen Tests. Als
Repository-Basis stehen insbesondere diese Befehle zur Verfügung:

```bash
pnpm format:check
pnpm docs:check
pnpm lint
pnpm typecheck
pnpm test
```

Bei fachlich relevanten Änderungen sind zusätzlich die in `AGENTS.md`
festgelegten Prüfungen auszuführen:

```bash
pnpm fachkatalog:check
pnpm fachkatalog:diff
```

DB-, Betriebs-, Sicherheits- und E2E-Änderungen benötigen die jeweils
passenden zusätzlichen Gates. Maßgeblich sind das
[Testkonzept](development/testkonzept.md) und die CI-Konfiguration; eine lokal
grüne Teilauswahl ersetzt keinen vollständigen CI-Lauf.

## Was eine konkrete Übergabe enthalten muss

- Branch und genauer Commit sowie ein Hinweis auf noch nicht commitierte
  Änderungen (`git status --short`)
- Ziel, getroffene Entscheidungen und bewusst nicht bearbeiteter Umfang
- betroffene Fachregel-IDs und deren fachlicher Prüfstatus
- neue Migrationen, Konfigurationswerte oder betriebliche Schritte
- tatsächlich ausgeführte Tests mit Ergebnis; ausgelassene Gates ausdrücklich
  benennen
- bekannte Grenzen, offene Befunde und nachvollziehbarer nächster Schritt

Historische Foundation- und Iteration-1-Notizen sind separat archiviert:
[Historischer Foundation-Handoff](archive/foundation-handoff-iteration-1.md).
