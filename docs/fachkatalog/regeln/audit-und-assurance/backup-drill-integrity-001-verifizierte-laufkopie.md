---
id: BACKUP-DRILL-INTEGRITY-001
title: Automatische Restore-Drills nur mit vorab verifizierten Dumpbytes ausführen
domain: audit-und-assurance
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Compliance und Verfahrensdokumentation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: Der automatische Drill prüft eine private Laufkopie vollständig gegen Hash und Größe des BackupRecord, bevor pg_restore die Datei lesen darf. Ein vollständiger Infrastruktur- und Wiederanlaufnachweis bleibt gesondert erforderlich.
sources:
  - kind: product_documentation
    citation: Technische Modulbeschreibung Backup und Restore
    path: docs/development/module/backup-restore.md
    checked_at: '2026-10-01'
    primary: true
code_refs:
  - apps/worker/src/jobs/backup-drill.ts
  - apps/worker/src/jobs/backup-drill-file.ts
test_refs:
  - apps/worker/src/jobs/__tests__/backup-drill.test.ts
  - apps/worker/src/jobs/__tests__/backup-drill-file.test.ts
  - apps/worker/src/jobs/__tests__/backup-drill-integrity.test.ts
feature_refs:
  - docs/development/module/backup-restore.md
related_rules:
  - AUDIT-HASH-CHAIN-001
  - ACCESS-TENANT-RLS-001
tags:
  - backup
  - restore
  - integritaet
---

# BACKUP-DRILL-INTEGRITY-001 — Automatische Restore-Drills nur mit vorab verifizierten Dumpbytes ausführen

## Kurzfassung

Ungeprüfter Entwurf: Ein PostgreSQL-Dump enthält ausführbare Anweisungen. Der
automatische Restore-Drill darf ausschließlich eine vollständig gegen den
zugehörigen Datenbanknachweis geprüfte lokale Kopie ausführen. Eine erst nach
dem Restore erkannte Abweichung kann vorausgegangene Wirkungen nicht verhindern.

## Wann gilt die Regel?

Für den automatischen monatlichen Backup-Drill. Die vom Betreiber ausdrücklich
ausgewählte externe Disaster-Recovery-Quelle der Restore-CLI hat einen eigenen
Vertrauens- und Freigabeprozess und wird hier nicht umdefiniert.

## Benötigte Angaben

Erfolgreicher BackupRecord mit S3-Bucket/Key, 32-Byte-SHA-256 und positiver
Bytegröße; ausreichend freier Platz auf einem für den Worker schreibbaren
Backup-Volume; vertrauenswürdige Datenbankreferenz und Laufumgebung.

## Entscheidungslogik

Ein fehlender oder ungültiger Hash-/Größennachweis verhindert den Drill. Das
S3-Objekt wird nur bis zur nachgewiesenen Größe in einen zufälligen privaten
Laufordner geschrieben. Die Datei wird exklusiv angelegt. Erst nach Streamende
und vollständigem Hash-/Größenvergleich erhält pg_restore genau diesen Pfad.
Ein zweiter Abruf aus dem veränderlichen S3-Bucket ist keine zulässige
Ersatzquelle. Jeder Lauf erhält eine eigene, intern erzeugte Datenbankkennung.

## Ausnahmen und Grenzfälle

Speicherplatzmangel, Downloadabbruch, Hashabweichung oder ein zu kurzer/langer
Stream führen zum Fehler, bevor Dumpanweisungen ausgeführt werden. Reguläre
Erfolgs- und Fehlerpfade entfernen die Laufdatei und ihren privaten Ordner.
Ein harter Prozessabbruch kann Reste hinterlassen; diese sind betrieblich nach
Abgleich mit aktiven Läufen zu bereinigen und werden nie ungeprüft fortgesetzt.

## Beispiele

### Normalfall

Der SHA-256 der privaten Kopie stimmt mit dem BackupRecord überein. Erst dann
wird die Wegwerf-DB angelegt, pg_restore ausgeführt und die Auditkette geprüft.

### Grenzfall

Jemand ersetzt das S3-Objekt durch einen gleich großen anderen Dump. Der
SHA-Vergleich schlägt fehl und pg_restore wird nicht gestartet.

## Umsetzung in TaxTronik

`backup-drill-file.ts` koppelt Streaming, Größenlimit, SHA-Vergleich, private
Datei und Cleanup. Unter POSIX trägt der Laufordner Modus 0700 und die Datei 0600. Compose bindet den bestehenden Backup-Hostpfad auch in den Worker ein,
wartet auf dessen Rechteinitialisierung und legt den Spool außerhalb des
64-MB-tmpfs ab. Das Ergebnis wird weiterhin tenantgebunden protokolliert.
Ein äußerer Cleanup-Block versucht den Drop der eigenen Drill-Datenbank auch
bei fehlerhafter Ergebnispersistierung, Auditfehler oder Disconnect-Fehler.

## Bekannte Abweichungen und Grenzen

Diese Regel ist fachlich ungeprüft. Sie garantiert weder die Vertrauenswürdigkeit
eines kompromittierten BackupRecord noch die Isolation eines kompromittierten
Hosts. Der Drill prüft PostgreSQL und Auditdaten, keine vollständige
Wiederherstellung aller Kanzleidateien und externen Dienste. Die Laufkopie
benötigt zusätzlich freien Plattenplatz in Höhe des komprimierten Dumps.

## Fachliche Prüffragen

- Welche betrieblichen Kontrollen sichern BackupRecord und Backup-Volume?
- Wie werden Platzbedarf, harte Abbrüche und verwaiste Laufkopien überwacht?
- Welche weiteren Prüfungen sind für eine belastbare Wiederanlauffreigabe nötig?

## Technische Nachweise

Tests verwenden echte Dateien und Streams. Sie prüfen Byteidentität vor dem
Restorecallback, POSIX-Zugriffsmodi, manipulierte und unvollständige Dumps,
fehlende Nachweise, überlange Streams, Download- und Restorefehler, Cleanup
sowie getrennte Laufverzeichnisse paralleler Aufrufe. Diese Tests sind kein
vollständiger Queue-/Image-/Produktionsdrill.
Die Processor-Regression führt zusätzlich den echten Job und Spool aus:
Bei manipuliertem S3-Inhalt entstehen weder Restore-Prozess noch neue Drill-DB;
der gültige Fall übergibt die verifizierten lokalen Bytes, führt nur einen
S3-Abruf aus und prüft anschließend Verifikation und Cleanup. DB, S3 und
Prozessstart sind dort simuliert.
Zusätzliche Fehlerfälle prüfen den Drop nach Restorefehler mit Auditfehler,
nach Auditfehler beim erfolgreichen Lauf und nach fehlerhaftem Disconnect.
Ein S3-Ergebnis ohne Body wird vor CREATE/Restore verständlich abgewiesen.
