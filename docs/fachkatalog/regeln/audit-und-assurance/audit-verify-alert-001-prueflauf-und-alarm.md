---
id: AUDIT-VERIFY-ALERT-001
title: Audit-Ketten regelmäßig prüfen und Abweichungen alarmieren
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
  status: implemented
  summary: Der tenantweise Prüflauf erkennt Kettenfehler, Spitzenverkürzungen sowie Anker-, Policy- und Laufzeitfehler. Täglich rechnet er nur den Zuwachs ab einem gegen die Kette abgeglichenen Prüf-Checkpoint nach; eine fortsetzbare Vollprüfung ab Genesis folgt frühestens sieben Tage nach der letzten und bei jedem manuellen Lauf. Recovery-Checkpoints grenzen nur den konkret dokumentierten Altbefund ab; neue Fehler bleiben alarmiert und einmal beobachtete Spitzen werden monoton erhalten.
sources:
  - kind: product_documentation
    citation: Technische Modulbeschreibung Audit-Protokollierung, Worker und Admin-Oberfläche
    path: docs/development/module/audit-protokollierung.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: TaxTronik Assurance Model, Audit-Chain und Known-Limits-Prinzip
    path: docs/assurance/assurance-model.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/worker/src/jobs/audit-verify-check.ts
  - apps/web/src/app/staff/(protected)/admin/audit/actions.ts
  - apps/web/src/app/staff/(protected)/admin/audit/audit-chain-status.tsx
  - apps/web/src/app/staff/(protected)/admin/audit/audit-page-state.ts
  - apps/web/src/server/audit/status.ts
  - packages/evidence/src/verify-checkpoint.ts
  - packages/evidence/src/service.ts
  - packages/evidence/src/verify-status.ts
  - packages/evidence/src/index.ts
  - packages/db/prisma/migrations/20261004140000_audit_verify_checkpoint/migration.sql
  - .forgejo/workflows/ci.yml
test_refs:
  - apps/worker/src/jobs/__tests__/audit-verify-check.test.ts
  - apps/web/src/app/staff/(protected)/admin/audit/__tests__/audit-verify-refresh-ui.test.ts
  - apps/web/src/app/staff/(protected)/admin/audit/__tests__/page.test.tsx
  - apps/web/src/server/audit/__tests__/status.test.ts
  - packages/evidence/src/__tests__/verify-checkpoint.test.ts
  - packages/evidence/src/__tests__/verify-checkpoint-db.test.ts
  - packages/evidence/src/__tests__/verify-checkpoint-ci.test.ts
  - packages/evidence/src/__tests__/chain-walk.test.ts
  - packages/db/src/__tests__/audit-verify-checkpoint.test.ts
  - packages/crypto/src/__tests__/audit-checkpoint-key.test.ts
feature_refs:
  - docs/development/module/audit-protokollierung.md
  - docs/assurance/assurance-model.md
related_rules:
  - AUDIT-HASH-CHAIN-001
  - AUDIT-RFC3161-ANCHOR-001
  - AUDIT-ARCHIVE-001
tags:
  - audit
  - verifikation
  - alarm
  - monitoring
---

# AUDIT-VERIFY-ALERT-001 — Audit-Ketten regelmäßig prüfen und Abweichungen alarmieren

## Kurzfassung

Ein täglicher und manuell auslösbarer Worker prüft die Audit-Kette jedes
Kanzlei-Tenants. Täglich gleicht er den gespeicherten Prüf-Checkpoint mit der
Kette ab und rechnet nur den Zuwachs nach; eine Vollprüfung ab Genesis folgt
frühestens sieben Tage nach der letzten abgeschlossenen Vollprüfung und bei
jedem manuellen Lauf. Er erkennt Hash- oder Vorgängerfehler, eine gegenüber dem
letzten erfolgreichen Lauf verkürzte lokale oder externe Spitze, einen nicht zur
Kette passenden Prüf-Checkpoint sowie Fehler bei Versiegelung, Ankerkette und
externer TSA-Policy. Das Ergebnis wird persistiert und bei Abweichungen an
interne Admin-/Partner-Rollen gemeldet.

## Wann gilt die Regel?

Die Regel gilt für Kanzlei-Tenants, die der Worker im geplanten oder gezielten Lauf
verarbeitet. Sie beschreibt technische Erkennung und Benachrichtigung. Prüfung,
Ursachenanalyse, Eskalation, Korrektur und dokumentierter Abschluss eines
Befunds bleiben betriebliche Aufgaben.

## Benötigte Angaben

- vollständige lokale Audit-Kette des Kanzlei-Tenants
- gespeicherte Tagesversiegelungen und Rolling Anchors
- aktuelle TSA- und Trust-Policy
- letzter persistierter Prüfstatus mit bisher größter lokaler und externer ID
- Prüf-Checkpoint des Kanzlei-Tenants: zuletzt geprüfte Kettenposition mit
  Hash, Anzahl geprüfter Einträge, Tagesversiegelungen und Rolling Anchors,
  zuletzt geprüfter Anker, Zeitpunkt der letzten abgeschlossenen Vollprüfung
  sowie Kennung, Ziel und Fortschritt einer laufenden Vollprüfung
- Intervall der Vollprüfung (sieben Tage), Zeitbudget je Lauf (zehn Minuten)
  und Fristen bis zur Meldung einer überfälligen (21 Tage) oder stockenden
  Vollprüfung (drei Tage ohne Fortschritt)
- Empfängerrollen für interne Benachrichtigungen
- bei manuellem Lauf auslösender Mitarbeiter und Kanzlei-Tenant

## Entscheidungslogik

| Befund                                                                                                              | Ergebnis                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kette und Anker entsprechen der Prüfung                                                                             | erfolgreichen Status mit aktuellen monotonen Spitzen speichern                                                                                                                                                                            |
| Prüf-Checkpoint ist authentisch und passt zur gespeicherten Kette                                                   | nur Einträge, Tagesversiegelungen und Rolling Anchors nach dem Checkpoint prüfen; Prüfstand und Befunde nach jedem Abschnitt ohne Kettenbruch speichern                                                                                   |
| Prüf-Checkpoint nicht authentisch (Prüfsumme fehlt oder falsch, Zeitstempel in der Zukunft)                         | Policy-Verstoß „Prüf-Checkpoint ist nicht authentisch … (Manipulationsverdacht)“ melden, Checkpoint verwerfen und Kette im selben Lauf ab Genesis prüfen                                                                                  |
| Siegel- oder Ankerbefund                                                                                            | Befund melden, Prüfung und Prüfstand trotzdem fortsetzen; Befund im Checkpoint halten und in jedem Lauf erneut melden                                                                                                                     |
| Siegel mit Spitze jenseits des Kettenendes                                                                          | wie verifyChain als Siegelbefund melden und zählen; nicht in den Prüfstand übernehmen, sondern in jedem Lauf neu ermitteln                                                                                                                |
| Prüf-Checkpoint fehlt oder wurde verworfen                                                                          | Kette ab Genesis prüfen; der vollständige Durchlauf gilt als Vollprüfung und setzt den Checkpoint                                                                                                                                         |
| Prüf-Checkpoint passt nicht zur gespeicherten Kette                                                                 | Policy-Verstoß „Prüf-Checkpoint passt nicht zur gespeicherten Kette … (Manipulationsverdacht)“ melden, Checkpoint verwerfen und Kette im selben Lauf ab Genesis prüfen                                                                    |
| manueller Lauf oder letzte abgeschlossene Vollprüfung mindestens sieben Tage alt                                    | nach der Zuwachsprüfung Vollprüfung ab Genesis beginnen; eine laufende Vollprüfung je Lauf höchstens zehn Minuten fortsetzen                                                                                                              |
| Vollprüfung bestätigt den bei ihrem Start festgehaltenen Checkpoint nicht                                           | Policy-Verstoß „Vollprüfung bestätigt den Prüf-Checkpoint nicht … (Manipulationsverdacht)“ melden und Prüf-Checkpoints verwerfen; nächster Lauf prüft ab Genesis                                                                          |
| Stand der laufenden Vollprüfung fehlt, gehört zu einer anderen Vollprüfung oder liegt ohne laufende Vollprüfung vor | Policy-Verstoß „… (Manipulationsverdacht)“ melden und Prüf-Checkpoints verwerfen; nächster Lauf prüft ab Genesis                                                                                                                          |
| keine Vollprüfung läuft und die letzte abgeschlossene liegt mehr als 21 Tage zurück                                 | Policy-Verstoß „Vollprüfung überfällig“ melden                                                                                                                                                                                            |
| laufende Vollprüfung ohne Fortschritt seit mehr als drei Tagen                                                      | Policy-Verstoß „Vollprüfung stockt“ melden und Vollprüfung neu beginnen; eine fortschreitende Vollprüfung ist nie überfällig                                                                                                              |
| nachträgliches Siegel oder Anker deckt Eintrag unterhalb des Checkpoints ab                                         | Eintrag einzeln nachrechnen; bei Bruch Kette ab Genesis prüfen und den ersten Bruch melden                                                                                                                                                |
| Hash- oder Vorgängerbruch                                                                                           | wie verifyChain nur den ersten Bruch der Kette melden; er hat Vorrang vor Siegel- und Ankerbefunden                                                                                                                                       |
| Hash-, Link-, Seal-, Anchor- oder Policy-Fehler                                                                     | fehlerhaften Status speichern und offene Warnung erzeugen oder aktualisieren                                                                                                                                                              |
| aktuelle lokale Spitze liegt unter zuvor beobachteter Spitze                                                        | Tail-Truncation melden                                                                                                                                                                                                                    |
| aktuelle externe Spitze liegt unter zuvor beobachteter Spitze                                                       | externe Tail-Truncation melden                                                                                                                                                                                                            |
| Prüflauf selbst schlägt fehl                                                                                        | Fehlerstatus speichern, bisherige Maximalspitzen nicht zurücksetzen                                                                                                                                                                       |
| manueller Lauf ist erfolgreich und die Vollprüfung abgeschlossen                                                    | auslösendem Mitarbeiter ein positives Ergebnis melden                                                                                                                                                                                     |
| Vollprüfung nach dem Lauf noch nicht abgeschlossen                                                                  | Fortschritt melden, keine Abschlussmeldung; offene Bruchmeldungen bleiben bis zu einem abgeschlossenen sauberen Lauf                                                                                                                      |
| paralleler Lauf hat einen authentischen, später geschriebenen und zur Kette passenden Checkpoint fortgeschrieben    | dessen Stand übernehmen und weiterprüfen; kein Lauf wird übersprungen                                                                                                                                                                     |
| Prüf-Checkpoint wird während des Laufs gelöscht, verfälscht oder durch einen älteren Stand ersetzt                  | Policy-Verstoß „Prüf-Checkpoint wurde während des Prüflaufs … (Manipulationsverdacht)“ melden, Checkpoints verwerfen und Kette im selben Lauf ab Genesis prüfen; bei erneutem Eingriff ohne Zwischenstand bis zum Kettenende weiterprüfen |
| Recovery-Checkpoint wird gesetzt                                                                                    | neue Vergleichsbasis dokumentieren, historische Manipulation nicht als repariert erklären                                                                                                                                                 |

## Ausnahmen und Grenzfälle

Ein Recovery-Checkpoint kann nach einem dokumentierten Restore eine neue
Überwachungsbasis setzen. Er ändert weder frühere Audit-Einträge noch frühere
Prüfergebnisse und unterdrückt keine anschließend neu auftretende Verkürzung.
Eine bereits offene Warnung wird aktualisiert, damit parallele Läufe nicht
beliebig viele gleichartige Meldungen erzeugen.

Der Prüf-Checkpoint ist kein Recovery-Checkpoint: Er hält nur fest, bis zu
welcher Position die Kette bereits erfolgreich geprüft wurde, und setzt keine
neue Vergleichsbasis für Befunde. Nur die Owner-Verbindung des Workers schreibt
ihn; die App-Rolle darf ihn lesen, aber nicht anlegen, ändern oder löschen.
Jede Checkpoint-Zeile trägt eine HMAC-SHA256-Prüfsumme über alle Felder
einschließlich Kanzlei-Tenant, Art, Positionen, Hashes, Zähler, Befunde und
Zeitstempel. Der Schlüssel wird per HKDF mit eigenem Info-Label aus dem
vorhandenen Worker-Geheimnis abgeleitet (`SECRET_BOX_KEY`, ohne dieses
`AUTH_SECRET`). Jeder Lauf prüft vor der Verwendung Prüfsumme und Zeitstempel
und gleicht den Checkpoint mit der gespeicherten Kette ab. Ein nicht
authentischer, abweichender oder von der Vollprüfung nicht bestätigter
Checkpoint macht den Lauf als Policy-Verstoß negativ und wird verworfen; ohne
gültigen Checkpoint prüft der Worker ab Genesis. Parallele Läufe schreiben ihn
nur fort, wenn er seit dem Lesen unverändert ist; jeder Schreibvorgang setzt
seinen Schreibzeitpunkt streng nach dem der ersetzten Zeile. Scheitert das
Fortschreiben, übernimmt der Lauf die vorgefundene Zeile nur, wenn sie
authentisch, später geschrieben und zur Kette passend ist, und prüft weiter;
kein Lauf wird übersprungen. Eine während des Laufs gelöschte, verfälschte oder
durch einen älteren Stand ersetzte Zeile ist ein Policy-Verstoß; der Lauf prüft
dann ab Genesis und bei einem erneuten Eingriff ohne Zwischenstand bis zum
Kettenende weiter.

Siegel- und Ankerbefunde stoppen die Prüfung wie bei verifyChain nicht. Der
Checkpoint hält sie bis zu seiner Position, und jeder Lauf meldet sie erneut.
Je Art bleiben höchstens 1.000 Befunde mit den niedrigsten IDs gespeichert;
weitere werden nur gezählt und als Policy-Verstoß ausgewiesen. Zuwachs- und
Vollprüfung speichern damit bei gleichem Kettenstand dieselbe Auswahl. Ein
Siegel, dessen Spitze jenseits des Kettenendes liegt, ist wie bei verifyChain
ein gezählter Siegelbefund; es geht nicht in den Prüfstand ein und wird in
jedem Lauf neu ermittelt, sodass Prüfstand und Checkpoint-Abgleich Siegel
nach derselben Regel zählen.

Die Kennung der laufenden Vollprüfung steht prüfsummengeschützt im
Prüf-Checkpoint. Fehlt ihr Stand, gehört er zu einer anderen Vollprüfung oder
liegt er ohne laufende Vollprüfung vor, etwa wieder eingespielt, ist das ein
Policy-Verstoß; abschließen kann nur eine nach der letzten abgeschlossenen
begonnene Vollprüfung. Eine laufende Vollprüfung ohne Fortschritt seit drei
Tagen meldet den Policy-Verstoß „Vollprüfung stockt“; sie wird verworfen und
neu begonnen. Eine fortschreitende Vollprüfung gilt nie als überfällig, auch
wenn sie bei großen Ketten länger als 21 Tage dauert. Läuft keine
Vollprüfung und liegt die letzte abgeschlossene mehr als das Dreifache des
Intervalls, also 21 Tage, zurück, meldet jeder Lauf den Policy-Verstoß
„Vollprüfung überfällig“. Ergibt die Vollprüfung für bereits
verarbeitete Siegel oder Anker ein anderes Prüfergebnis, etwa nach einer
Änderung des TSA-Trust-Stores, meldet der Lauf die neuen Befunde. Der
Checkpoint wird auf den Stand der Vollprüfung zurückgesetzt, und der nächste
Lauf prüft ab dort erneut bis zur Spitze.

## Beispiele

### Normalfall

Der tägliche Lauf gleicht den Prüf-Checkpoint mit der gespeicherten Kette ab,
rechnet die seit dem Vortag hinzugekommenen Einträge nach, verifiziert neue
Tagesversiegelungen und Anker und beobachtet eine mindestens gleich große
Spitze wie beim Vortag. Der technische Status wird als erfolgreich gespeichert.

### Grenzfall

Nach einem fehlerhaften Restore enthält die Datenbank weniger Audit-Zeilen als
beim letzten erfolgreichen Lauf. Auch wenn die verbliebene Teilkette in sich
korrekt ist, meldet der Worker die verkürzte Spitze.

Wird der Inhalt eines bereits geprüften älteren Eintrags geändert, ohne dass
sich die Checkpoint-Zeile, die Anzahl der Einträge, Tagesversiegelungen und
Anker oder der letzte Anker ändern, bleibt der tägliche Zuwachslauf positiv.
Erst die nächste Vollprüfung meldet den Bruch und verwirft den Checkpoint. Bei
einem konkreten Verdacht kann ein manueller Prüflauf die Vollprüfung sofort
starten.

## Umsetzung in TaxTronik

`audit-verify-check.ts` paginiert Kanzlei-Tenants, prüft je Tenant mit
`verifyChainWithCheckpoints` (`verify-checkpoint.ts`), vergleicht lokale und
externe Maximal-IDs monoton und schreibt Status sowie Notifications.
`actions.ts` startet manuelle Läufe und dokumentiert Recovery-Checkpoints als
eigene Audit-Aktionen.

Die Prüfung läuft in Abschnitten von höchstens 5.000 Einträgen beziehungsweise
250 Rolling Anchors, jeder in einer eigenen begrenzten Owner-Transaktion;
TSA-Antworten werden blockweise geladen. Nach jedem gültigen Abschnitt wird der
Prüf-Checkpoint in `audit_verify_checkpoint` fortgeschrieben. Vor seiner
Verwendung prüft der Worker, ob die Zeile an der gespeicherten Position noch
existiert, ihren gespeicherten Hash reproduziert und dem Checkpoint entspricht,
ob die Anzahl der Einträge, Tagesversiegelungen und Rolling Anchors bis dorthin
übereinstimmt und ob der zuletzt geprüfte Anker unverändert ist. Danach prüft
er nur neuere Einträge, Versiegelungen und Anker; nachträglich angelegte
Versiegelungen oder Anker für ältere Einträge prüft er gegen die einzeln
nachgerechnete Zeile.

Liegt die letzte abgeschlossene Vollprüfung mindestens sieben Tage zurück oder
wurde der Lauf manuell ausgelöst, beginnt nach der Zuwachsprüfung eine
Vollprüfung ab Genesis. Ihr Ziel ist der bei ihrem Start festgehaltene
Checkpoint. Sie läuft je Lauf höchstens zehn Minuten und wird im nächsten Lauf
ab dem gespeicherten Fortschritt fortgesetzt. Am Ziel muss sie Position, Hash,
Anzahl der Einträge sowie der verarbeiteten Tagesversiegelungen und Rolling
Anchors des Checkpoints exakt bestätigen. Das persistierte Ergebnis weist den
Prüfumfang mit Startposition, Zahl der nachgerechneten Einträge, Zeitpunkt der
letzten abgeschlossenen Vollprüfung und Fortschritt einer laufenden
Vollprüfung aus. Solange eine Vollprüfung nach dem Lauf noch nicht
abgeschlossen ist, erhält der Auslöser eines manuellen Laufs nur eine
Fortschrittsmeldung; offene Bruchmeldungen werden erst nach einem
abgeschlossenen sauberen Lauf als gelesen markiert. Alarme, Audit-Aktionen und
die übrigen Benachrichtigungstexte bleiben unverändert; ein Checkpoint-Befund
macht das Ergebnis wie jeder andere Policy-Verstoß negativ. Die checkpointfreie Vollprüfung `verifyChain` bleibt
für CLI, Prüfer-Link und Backup-Drill erhalten. Liegt ein Bruch vor einem
Recovery-Checkpoint, rechnet die Recovery-Teilkettenprüfung die Teilkette ab
diesem Checkpoint weiterhin in jedem Lauf vollständig nach.

Die zentrale Audit-Anzeige wertet für die bernsteinfarbene historische Einordnung
den persistierten `recovered`-Wert zusammen mit dem Checkpoint aus. Ein alter
Checkpoint allein färbt neue Verkürzungsbefunde oder Lauf-Exceptions nicht um;
Exceptions werden mit Fehlerdetails rot dargestellt. Dies ändert keine
Workerentscheidung und behauptet keine separate Prüfung einer Recovery-Teilkette.

## Bekannte Abweichungen und Grenzen

Die Recovery-Teilkettenprüfung ist wieder aktiv. Ein Checkpoint grenzt nur
einen davor dokumentierten Hash-/Link- oder Tail-Befund ab; Lauf-Exceptions,
neue Brüche und neue Spitzenverkürzungen bleiben negativ und erzeugen eine
Admin-/Partner-Warnung. Persistierte Audit-, Anchor- und anchored-Audit-Spitzen
werden nach einem negativen Lauf nicht abgesenkt.

Der tägliche Zuwachslauf rechnet bereits geprüfte Historie nicht erneut nach.
Eine Änderung unterhalb des Prüf-Checkpoints, die weder dessen Zeile noch die
Anzahl der Einträge, Tagesversiegelungen und Rolling Anchors noch den zuletzt
geprüften Anker berührt, erkennt erst die nächste Vollprüfung. Diese beginnt im
ersten täglichen Lauf, in dem die letzte abgeschlossene Vollprüfung mindestens
sieben Tage zurückliegt; weil diese erst nach Laufbeginn abschließt, ist das in
der Regel der achte tägliche Lauf. Zwischen Änderung und Meldung können daher
rund acht Tage zuzüglich der Laufzeit der Vollprüfung liegen, die bei sehr
großen Ketten mehrere Läufe dauern kann. Bis dahin stützt sich ein positiver
Tagesstatus nur auf Zuwachs und Checkpoint-Abgleich. Ein manueller Prüflauf
startet die Vollprüfung sofort.

Die zweite verzögerte Befundklasse betrifft bereits verarbeitete Siegel und
Anker: Ändert sich ihr Prüfergebnis ohne Änderung der Kettenposition, etwa nach
einem Wechsel des TSA-Trust-Stores, einer TSA oder einer geänderten
Token-Spalte, meldet dies ebenfalls erst die nächste Vollprüfung. Bis dahin
werden die bei der ersten Prüfung gefundenen Befunde weiter gemeldet.

Die Prüfsumme schützt die Checkpoints gegen Schreibzugriffe ohne das
Worker-Geheimnis. Wer dieses Geheimnis und zugleich Owner-Rechte an der
Datenbank besitzt, kann authentische, aber falsche Checkpoints schreiben und
damit Befunde in bereits geprüfter Historie bis zu einer Prüfung ohne
Checkpoint verbergen; der Abgleich mit der gespeicherten Kette und die
Ablehnung zukünftiger Zeitstempel begrenzen dies nur. Ein Wechsel von
`SECRET_BOX_KEY` (ohne dieses von `AUTH_SECRET`) macht bestehende Checkpoints
einmalig ungültig: Der nächste Lauf meldet sie als nicht authentisch und prüft
ab Genesis. Ohne das Geheimnis kann ein Owner nur ältere authentische Zeilen
wieder einspielen. Ein einzeln wieder eingespielter Vollprüfungsstand fällt
auf. Spielt er alle drei Zeilen einer laufenden Vollprüfung gemeinsam wieder
ein (Prüf-Checkpoint mit ihrer Kennung, Fortschritt kurz vor dem Abschluss
und Ziel), kann er innerhalb der Dreitagesfrist einmalig ihren Abschluss
vortäuschen; die nächste echte Vollprüfung erkennt eine Manipulation, der
Gewinn ist auf etwa ein Intervall begrenzt. Ersetzt er den Fortschritt der
laufenden Vollprüfung wiederholt durch frühere, weniger als drei Tage alte
authentische Stände derselben Vollprüfung, kann er sie erheblich
verlangsamen, ohne dass „Vollprüfung stockt“ oder „Vollprüfung überfällig“
gemeldet wird. Ein älterer Prüf-Checkpoint allein kann bis zum Abschluss der
dann fälligen Vollprüfung ältere Befunde melden lassen.

Die App-Rolle darf Tagessiegel anlegen. Füllt sie die 1.000 gespeicherten
Siegelbefunde mit ungültigen Siegeln, werden spätere echte Siegelbefunde nur
noch gezählt und nicht mehr einzeln aufgeführt; der Status bleibt negativ.

Die technische Prüfung belegt weder die rechtzeitige menschliche Kenntnisnahme noch eine fachgerechte
Bearbeitung und Schließung des Befunds. Scheduler-, Queue-, Datenbank- oder
Notification-Ausfälle können die Ausführung beziehungsweise Zustellung
verzögern und müssen separat überwacht werden.

## Fachliche Prüffragen

- Welche Rollen müssen einen Fehler erhalten und vertreten können?
- Welche Reaktions- und Eskalationsfristen gelten je Befundart?
- Unter welchen dokumentierten Voraussetzungen darf ein Recovery-Checkpoint
  gesetzt werden?
- Welcher Nachweis ist für Ursachenanalyse und Abschluss eines Alarms
  aufzubewahren?
- Ist eine Erkennungsverzögerung von rund acht Tagen für Änderungen an bereits
  geprüfter Historie vertretbar, oder ist eine häufigere Vollprüfung nötig?
- Sind die Fristen von 21 Tagen bis zur Meldung einer überfälligen und von
  drei Tagen ohne Fortschritt bis zur Meldung einer stockenden Vollprüfung
  angemessen?

## Technische Nachweise

Die Worker-Tests prüfen lokale und externe Spitzenverkürzung, monotone
Persistenz, die zeitliche Checkpoint-Abgrenzung und den Ausschluss von
Lauf-Exceptions aus Recovery. Die Statusmatrix prüft die Anzeige neuer Fehler
trotz altem Checkpoint. Der UI-Test belegt, dass ein angestoßener Prüflauf
seinen Status ohne vollständigen Chain-Walk im Renderpfad aktualisieren kann.
Die gerenderte Seitenregression prüft zusätzlich wartende, exakt zugeordnete
und durch einen neueren parallelen Lauf abgelöste Prüfergebnisse. Sie belegt
die sichtbare Trennung von gefilterter Liste und vollständigem Kettenstatus,
die historische Einordnung nur mit persistierter Recovery sowie weiterhin
sichtbare neue Policy- und Laufzeitfehler trotz altem Checkpoint. Die
Komponentenaufteilung verändert keine Workerentscheidung oder Audit-Aktion.

Die PostgreSQL-Regression der checkpointgestützten Prüfung vergleicht Erstlauf,
Zuwachslauf und eine über mehrere Läufe fortgesetzte Vollprüfung mit
`verifyChain`. Sie belegt die Erkennung einer manipulierten Checkpoint-Zeile,
eines manipulierten Checkpoints oder Vollprüfungsstands, eines unterhalb des
Checkpoints gelöschten Ankers und nachträglicher Siegel über ungültiger oder
manipulierter Historie. Sie zeigt außerdem die bekannte Grenze: Eine
Manipulation unterhalb des Checkpoints bleibt im Zuwachslauf unerkannt und wird
von der Vollprüfung gemeldet. Die Regression läuft im blockierenden
Datenbankjob der CI; ein Workflow-Test sichert diesen Schritt. Der
Komponententest prüft den Zielabgleich der Vollprüfung, der Migrationstest
Rechte, erzwungene RLS und Tenant-Isolation der Checkpoint-Tabelle. Der
Worker-Test belegt Intervall, Zeitbudget und die erzwungene Vollprüfung
manueller Läufe. Der Walker-Test belegt, dass Vollprüfung und
Recovery-Teilkette Brüche identisch melden und die Recovery-Teilkette ihren
bisherigen Prüfumfang behält.

Weitere Regressionen bilden die Befunde des Reviews nach: Ein nachträglich
eingefügtes ungültiges Siegel friert die Prüfung nicht ein, und ein späterer
Kettenbruch wird wie bei verifyChain gemeldet; ein Siegel mit niedriger ID
führt zum Policy-Verstoß und zu einem vollständigen Genesis-Walk bis zur
Spitze ohne falsche Spitzenverkürzung; ein Zuwachs über mehrere Abschnitte mit
frühem Siegel- und Ankerbefund entspricht verifyChain in zwei Folgeläufen. Sie
belegen außerdem die Ablehnung ohne Schlüssel veränderter, kopierter oder in
die Zukunft datierter Checkpoints, den Kettenabgleich eines mit Schlüssel
gefälschten Checkpoints, Befund und Neustart einer stehenden Vollprüfung sowie die
Übernahme des Stands eines parallel überholenden Laufs ohne Überspringen. Der
Schlüsseltest belegt die HKDF-Ableitung mit eigenem Info-Label; der
Worker-Test die Fortschrittsmeldung manueller Läufe.

Die Regressionen des Nachreviews belegen: Ein während des Laufs gelöschter,
verfälschter oder durch einen älteren authentischen Stand ersetzter
Checkpoint ist ein Policy-Verstoß, und der Lauf meldet trotzdem einen Bruch
jenseits seines ersten Abschnitts. Ein gelöschter Stand der laufenden
Vollprüfung ist ein Policy-Verstoß, nach dem der nächste Lauf die
Manipulation ab Genesis findet. Eine über die 21-Tage-Grenze hinaus
fortschreitende Vollprüfung meldet nichts, eine seit drei Tagen stehende
„Vollprüfung stockt“, und ohne laufende Vollprüfung wird eine überfällige
gemeldet. Ein Siegel mit Spitze jenseits des Kettenendes und
eine abgeschnittene versiegelte Spitze führen zu keinem dauerhaften
Checkpoint-Befund und entsprechen danach verifyChain. Ein wieder
eingespielter Vollprüfungsstand schließt keine Vollprüfung ab. Bei mehr als
1.000 Befunden speichern Zuwachs- und Vollprüfung dieselbe Auswahl, und die
Vollprüfung schließt ab; ein Komponententest belegt die
reihenfolgeunabhängige Auswahl.
