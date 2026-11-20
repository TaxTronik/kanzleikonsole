# Nachprüfung der CVP-Aufgaben vom 20. November 2026

Diese Nachprüfung arbeitet die sieben „Aufgaben für Claude im CVP-Modus“ aus
der [Vollprüfung vom selben Tag](2026-11-20-vollpruefung.md) ab. Geprüft wurde
der lokale Arbeitsbaum einschließlich der noch nicht committeten Änderungen
der Vollprüfung (Git-Baumkennung `2691d87b3e45aad1198c7f3db004a64564f40805`).
Für den gemischten Betrieb kam zusätzlich der Commit `9b67b775` als „alte“
Version hinzu.

Alle Läufe fanden in einer isolierten Linux-Umgebung statt: Node 24.22.3,
PostgreSQL 18 mit allen 292 Migrationen, SeaweedFS 4.41 mit Object Lock,
Redis 7 und Traefik 3.7.9. Die Basisprüfung `packages/db` bestand 967 von
967 Tests, der Abgleich mit den kanonischen SQL-Quellen war grün. Es gab nur
synthetische Daten, keinen Zugriff auf Kanzleiakten, keine Produktivsysteme
und keinen Push. Die Prüfprogramme liefen auf einer Kopie. Die Befunde 1 und 2
sind inzwischen behoben (siehe [Behebung](#behebung)). Prüfprogramme und Rohprotokolle liegen lokal unter
`.codex-run/cvp-nachpruefung-20261120/`.

## Zusammenfassung

| Nr. | Befund                                                                                                                                                                                                           | Einordnung                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | Ein Retag senkt `document.retention_until` einer älteren GoBD-Akte, deren Frist eine spätere Version bereits angehoben hatte (2033 → 2029). Der Lock der älteren Version bleibt bei 2033.                        | behoben                                                   |
| 2   | Nach dem Zurückspielen eines älteren Redis-Standes ist eine abgemeldete Sitzung wieder gültig, auf alter und neuer Instanz. Runbook und Operator-CLI kennen keinen Schritt dagegen.                              | behoben (Betreiberkommando)                               |
| 3   | Gemischter Betrieb alt/neu: Eine Wiederanmeldung, die eine alte Instanz in der Widerrufssekunde ausstellt, wird auf beiden Instanzen abgewiesen.                                                                 | fail-closed, Bedienfehler wie vor der Korrektur           |
| 4   | Rechercheergebnisse, die eintreffen, während die beauftragende Person keine Sicht hat, erhalten nie einen Hinweis. Wer die Markierung neu übernimmt, erhält keine Hinweise. Neue Callback-ID → zweites Ergebnis. | fachliche Entscheidung offen                              |
| 5   | Die GwG-Warteschlange zeigt einen Beleg ohne Aufbewahrungsende als fällig, die Aktion lehnt ihn ab.                                                                                                              | Unstimmigkeit, ohne Löschfolge                            |
| 6   | Die Auslagenposition im StBVV-Rechnungsentwurf trägt den internen Schlüssel `ELECTRONIC_DOCUMENTS` statt Bezeichnung und Vorschrift.                                                                             | Darstellungsfehler; § 9 Abs. 2 StBVV fachlich zu bewerten |
| 7   | Die BWA-Steuerschätzung belegt den Hebesatz mit 400 % vor. Die Regel setzt einen manuell übergebenen Hebesatz voraus.                                                                                            | Konflikt Regel/Code, nicht still aufgelöst                |

Die Rechenwerte für StBVV, BWA-Steuerschätzung, Jahresfristen und
Einspruchsfristen stimmen in allen unabhängig durchgerechneten Fällen mit dem
Code überein. Abweichungen betreffen Vorbelegungen, Darstellung und
Ortsbezug. Die Berliner Jahresgrenze verhält sich in Fristrechnung,
Lock-Verlängerung und Löschpfaden wie in der Vollprüfung beschrieben.

## Aufgabe 1: Historische GoBD-Version

**Fristanker je Weg.** Beim ursprünglichen Upload ist der Anker der Zeitpunkt
der Vorbereitung (`uploadNow`, `packages/storage/src/service.ts`), der in keiner
Spalte steht; `document.created_at` entsteht erst beim Commit. Bei der
Höherstufung (Retag) ist der Anker `document.created_at`. Bei der Ausgabe aus
Mandantenangaben ist es `client_assistance_revision.occurred_at` aus dem
hashgebundenen Snapshot. Die Versions-ID steht in jedem Weg in
`document_version.storage_version_id`; die Ausgabe bindet die exakte Version
zusätzlich über `client_assistance_output.document_version_id`. Für Altbestand
ist die Pflicht nicht garantiert, weil der CHECK
`document_version_locked_storage_version_check` als `NOT VALID` angelegt ist.

**Befund 1 (Retag senkt das Aufbewahrungsende).** Eine GoBD-Vertragsakte von
2020 mit zweiter geschützter Version und angehobenem Aufbewahrungsende
2033-01-01 wurde von 6 auf 8 Jahre umklassifiziert. Ergebnis gegen PostgreSQL
mit dem echten Retag-Service: Version 3 angehängt, Anker 2020-02-10,
`document.retention_until` danach 2029-01-01. Die Route für neue Versionen hebt
nur an, der Retag überschreibt (`apps/web/src/server/documents/retag.ts`).
Automatisch gelöscht wird dadurch nichts, weil kein Anwendungspfad GoBD-Versionen
nach diesem Feld auswählt. Dokumentansicht und Offboarding-Übersicht zeigen aber
ein Stichdatum, das vier Jahre vor dem Lock der zweiten Version liegt. Betroffen
ist `DOC-RETENTION-CLASS-001`.

**Löschpfade.** Kein Anwendungspfad wählt eine referenzierte GoBD-Version aus.
Die GwG-Vernichtung filtert auf `GWG_EVIDENCE`; ein Wechsel GoBD → GwG ist
gesperrt. Der Aufräumjob `storage-orphan-cleanup` prüft Bezüge unabhängig von
`deleted_at`. Gegenprobe im isolierten SeaweedFS mit einem ausgeblendeten
GoBD-Dokument, dessen COMPLIANCE-Lock bereits abgelaufen war, und einer offenen
Speicherabsicht: Der Job markierte sie als `REFERENCED`, das Objekt blieb
erhalten. Eine gleichartige Absicht ohne Bezug wurde gelöscht.

**Verhalten des Speichers (SeaweedFS 4.41).**

- Ein PUT mit Stichtag in der Vergangenheit wird mit HTTP 400 abgewiesen. Ein
  Retag oder eine Revisionsausgabe mit sehr altem Anker scheitert dadurch
  geschlossen, statt ohne Lock zu speichern.
- COMPLIANCE lässt sich weder mit Bypass löschen noch verkürzen noch auf
  GOVERNANCE umstellen. Ein DELETE ohne Versions-ID legt nur einen Delete Marker
  an; die geschützte Version bleibt lesbar.
- Nach Ablauf des Locks ist die Version ohne Bypass löschbar. Ab dann schützt
  sie nur noch die Datenbank. Eine abgelaufene Frist lässt sich nachträglich
  wieder verlängern; das trägt Schritt 3 der Bestandsprüfung im
  [Dokumentenarchiv](../development/module/dokumentenarchiv.md#jahreswechsel-und-bereits-gespeicherte-schutzfristen).
- Das Löschen einer nicht vorhandenen Versions-ID meldet Erfolg.
  `deleteObjectVersion` prüft anschließend nur, dass diese ID fehlt. Eine
  falsch gespeicherte ID würde die echte Version also nicht finden.

## Aufgabe 2: GwG-Beleg mit TCMS-Verweis

Geprüft wurde die echte Aktion `confirmGwgDeletionAction` mit echter
Warteschlange, Datenbank-Claim und `deleteObjectVersion` gegen den
GOVERNANCE-Bucket. Ersetzt waren nur Anmeldung, Cache und Logger.

| Fall                                                         | Warteschlange | Erster schreibender Schritt                  | Beobachtete Sperre                                              |
| ------------------------------------------------------------ | ------------- | -------------------------------------------- | --------------------------------------------------------------- |
| Früherer TCMS-Nachweis, beide Fristen abgelaufen, Lock aktiv | fällig        | Vormerkung mit Audit, committet              | S3 403 ohne Bypass; Fehler gespeichert, Beleg bleibt vorgemerkt |
| derselbe Fall nach Ablauf des Locks                          | fällig        | –                                            | Wiederholung löscht ohne Bypass; Beleg vernichtet               |
| GwG ohne TCMS-Verweis, Frist abgelaufen, Lock ein Jahr       | fällig        | Vormerkung mit Audit                         | Bypass übersteuert GOVERNANCE; Version gelöscht                 |
| Früherer TCMS-Nachweis, Steuerfrist bis 2030                 | nicht fällig  | keiner                                       | Aktion lehnt mit Steuerfrist-Text ab                            |
| Mandatsende 2023                                             | nicht fällig  | keiner                                       | Aktion lehnt ab                                                 |
| Laufendes Mandat mit Feststellung                            | nicht fällig  | Vormerkung in der Transaktion, zurückgerollt | Datenbank-Claim lehnt ab; nichts bleibt geschrieben             |
| Aufbewahrungsende fehlt                                      | **fällig**    | keiner                                       | Aktion lehnt ab (Befund 5)                                      |

Der Lock-Verlängerungsjob `gwg-object-lock-extend` lief ebenfalls live. Belege
mit Anlage 31.12.2019 22:59:59,999 UTC und 23:00 UTC erhielten
GOVERNANCE-Locks bis 2030-01-01 bzw. 2031-01-01, also nach Berliner Jahr. Ein
bereits bis 2040 gesetzter Lock blieb unverändert.

Das Übersteuern des GOVERNANCE-Locks bei Belegen ohne TCMS-Verweis ist im Code
ausdrücklich so vorgesehen. Für diese Belege ist der Speicher damit keine
zweite Schutzlinie; die Fristprüfung liegt allein in Aktion und Claim.

## Aufgabe 3: Eigenständige Sollwerte

Die Sollwerte wurden aus den Primärquellen abgeleitet (gesetze-im-internet.de,
AEAO zu § 108 AO 2026, LStH 2025, Feiertagsgesetze Berlin, Brandenburg und NRW)
und mit den Funktionen verglichen, die Oberfläche, Rechnungsentwurf und
Fristeintrag verwenden.

- **StBVV.** Dateipauschale je Arbeitsgang (4 + 2 Dateien: 5,00 und 3,00 Euro;
  6 Dateien: 5,00 Euro), Grenzfälle, Scan-Mindestbetrag, Postpauschale an
  und unter der Kappung sowie ein gemischter Entwurf mit 550,97 Euro brutto:
  alle Fälle stimmen. Der Rechnungsentwurf prüft das Brutto gegen den
  gespeicherten Nachweis.
- **BWA-Steuerschätzung.** Vollständige Jahre 2025 und 2026, Teiljahre,
  abweichendes Wirtschaftsjahr, Hebesatzgrenzen und drei durchgerechnete Fälle
  (Einzelunternehmen 2025 und 2026, GmbH) stimmen.
- **Fristen.** Jahreserklärungen 2019 bis 2025 mit und ohne Berater, Berlin
  08.05.2025, Brandenburg 08.05.2025, 31.10.2017 bundesweit und in NRW sowie
  die Einspruchsfristen zu den Versandtagen 15.04.2025 und 04.05.2025 und zum
  Wechsel der Bekanntgabefiktion am 31.12.2024/01.01.2025 stimmen.

Abweichungen und Konflikte:

- **Befund 6.** Die Auslagenposition im Rechnungsentwurf lautet
  `Auslagen · {Angelegenheit} · ELECTRONIC_DOCUMENTS · {Freitext}`
  (`packages/tax/src/stbvv/calculator.ts`, `apps/web/src/server/stbvv/service.ts`).
  Gebührenzeilen nennen Vorschrift und Quelle, die Auslagen nicht.
- **Befund 7.** `tax-estimator-card.tsx` belegt den Hebesatz mit 400 % vor
  und weist darauf hin. `BWA-TAX-ESTIMATE-001` setzt einen manuell übergebenen
  Hebesatz voraus. Ohne Eingabe aus der Akte erscheinen damit Beträge.
- **Abweichendes Wirtschaftsjahr.** Die Vollprüfung beschreibt die Zuordnung
  zum Endjahr als Fehler. Für Gewerbetreibende ordnen § 4a Abs. 2 Nr. 2 EStG,
  § 7 Abs. 4 KStG und § 10 Abs. 2 GewStG den Gewinn aber gerade dem Endjahr zu.
  Die jetzige Unterdrückung ist eine Produktentscheidung, keine Rechtsfolge.
- **Feiertagsort der Jahresfristen.** Fristeinträge verwenden die
  Steuerregion der Kanzlei, nicht den Sitz des Finanzamts. Beispiel: VZ 2021
  ohne Berater, Kanzlei in Brandenburg, Finanzamt in Berlin ergibt 01.11.2022
  statt 31.10.2022. Das ist in `TAX-DEADLINE-WORKDAY-001` als Grenze
  dokumentiert.
- Fristeinträge entstehen nur für heute bis +90 Tage. Für die Jahre 2019 bis
  2024 gibt es deshalb keinen Eintrag aus der Oberfläche zum Vergleich.
  Bescheide mit nur behauptetem Versand („CLAIMED“) erhalten keinen
  Kontrolltermin im Fristenkontrollbuch.

Für den Vergleich wurden die Funktionen und Adapter der Oberfläche aufgerufen;
eine Bedienung im Browser fand für Aufgabe 3 nicht statt.

## Aufgabe 4: Recherchehinweise und Zuständigkeit

**Zu klären mit der verantwortlichen Person.** Ob bereits beauftragte
Rechercheergebnisse nach der Archivierung als eigener Systemeingang zur Akte
gehören, bleibt eine fachliche Entscheidung (`RISK-ARCHIVE-SNAPSHOT-001`). Der
nachgewiesene Ablauf speichert eine späte Antwort als eigenes Ergebnis mit
Systemereignis, ohne Archivprüfung.

**Matrix.** Mandat im Modus OPEN, nicht vertraulich, Analyse vertraulich,
Markierung M1 bei U, M2 bei V. U hat alle Aufträge gestellt.
„Stellvertretung“ ist hier die Mandatsrolle `VERTRETER`; sie gewährt laut
`ACCESS-CLIENT-MODE-001` keinen Zugriff.

| Zustand             | U sieht                      | Neue Hinweise                  |
| ------------------- | ---------------------------- | ------------------------------ |
| U Vertreter, M1 → U | R1@M1                        | R1 erhält einen, R2@M2 keinen  |
| U Hauptbearbeiter   | R1, R3, R4 (R2 fehlt weiter) | R3@M1 und R4@M2 erhalten einen |
| wieder Vertreter    | R1, R3, R5 (R4 ausgeblendet) | R5@M1 einen, R6@M2 keinen      |
| M1 → V              | nichts; Gelesen-Markierung 0 | R7@M1 keinen                   |
| M1 zurück → U       | R1, R3, R5 wieder ungelesen  | –                              |

V und das Administratorkonto W sahen in keinem Zustand einen dieser
Hinweise.

- Bestehende Hinweise werden beim Lesen geprüft und erscheinen in beiden
  Richtungen wieder.
- Neue Hinweise werden beim Eingang einmalig angelegt. Fehlt in diesem
  Moment die Sicht, entsteht auch später keiner (R2, R6, R7).
- Hinweise gehen immer an die beauftragende Person, nie an die aktuell für
  die Markierung zuständige Person.
- Eine zweite Zustellung desselben Auftrags mit neuer Callback-ID ergibt ein
  zweites Ergebnis und einen zweiten Hinweis. Nur dieselbe Callback-ID ist
  idempotent.

## Aufgabe 5: Kalte Wiederherstellung

Die Wiederholung unter den tatsächlichen betrieblichen Voraussetzungen und die
Abstimmung mit dem Betreiber stehen aus. Sie brauchen den Betreiber, die
Offsite-Kopie und die offline verwahrten Schlüssel.

Stand nach Code und Runbook:

- `backup-full` verschlüsselt die gesamte Nutzlast einschließlich `.env` an
  `BACKUP_AGE_RECIPIENT`. Die age-Identität liegt laut Runbook offline.
- Der private Signaturschlüssel des Manifests (`BACKUP_MANIFEST_PRIVATE_KEY_FILE`)
  muss auf dem Produktivhost liegen. Offline liegt nur der öffentliche Schlüssel.
- Der Offsite-Upload verlangt Versionierung, COMPLIANCE und mindestens 90 Tage
  Standardfrist und prüft je Datei Größe, Modus, Stichtag und Versions-ID.
- Das Runbook führt `redis_data` nur als „BullMQ-Queues“. Tatsächlich enthält
  es auch Sitzungswiderrufe, TOTP-Wiederholschutz und Anmeldesperren (siehe
  Aufgabe 7).

Lokal wurde der versionstreue Teil wiederholt. Das isolierte SeaweedFS wurde
gestoppt, sein Datenvolume wie in `backup-full` als `tar.gz` gesichert und in
ein leeres neues Volume entpackt. Verglichen wurden alle 16 Einträge der
Buckets `gobd` und `gwg` vor und nach der Rehydrierung: 15 Versionen und ein
Delete Marker, davon 12 mit Datenbankbezug, darunter ein ausgeblendetes
GoBD-Dokument und GwG-Belege mit Stichtagen 2030, 2031 und 2040. Alle 16
stimmten in Versions-ID, SHA-256 der Bytes, Lock-Modus, Stichtag, Delete Marker,
aktueller Version und Datenbankbezug überein. Das wiederhergestellte System
lehnte Löschen und Verkürzen einer GOVERNANCE-Version ohne Bypass mit HTTP 403
ab, die Bucket-Standards blieben erhalten. Echte Offsite-Kopie, age-Entschlüsselung
und Produktivschlüssel waren nicht Teil dieses Laufs.

Für den Betreiber: Verwahrort und Zugriffsberechtigte der age-Identität, des
öffentlichen Manifest-Schlüssels und der Offsite-Zugangsdaten getrennt
nachweisen. Klären, wer den privaten Signaturschlüssel auf dem Host lesen kann.
Den Drill nach Abschnitt 7 des Runbooks mit einer echten Offsite-Version
durchführen und dabei je ausgewählter historischer Version dieselben fünf
Merkmale vergleichen.

## Aufgabe 6: Messung über die Proxy-Strecke

Die Strecke entsprach der verwalteten Traefik-Route aus `scripts/ops/traefik.sh`:
Traefik 3.7.9 mit TLS, Buffering-Middleware, Standardtransport und eigenem
Login-Router. Abweichend davon gab es ein selbstsigniertes Zertifikat statt
ACME und ein JSON-Accesslog für die Messung. Dahinter lief das Web-Image des
Arbeitsstands mit `TRUST_PROXY_REQUIRED=true`, einem Proxy-Hop und
`KEEP_ALIVE_TIMEOUT=95000`, dazu der Worker. Datenbestand: 10.004 Mandanten und
50.001 Anforderungen wie in der Vollprüfung. Gemessen wurden die sieben
bekannten Routen über 15 Minuten mit 12 Sekunden Pause. In den Minuten 4 und 9
lief jeweils eine `pg_dump`-Sicherung der Datenbank; beide dauerten unter einer
Sekunde (3,4 MB).

| Messpunkt                          | Ergebnis                                        |
| ---------------------------------- | ----------------------------------------------- |
| Client: gültige Antworten          | 511 von 511, keine Socketfehler                 |
| Client: Median / 95. Perzentil     | 47 ms / 133 ms                                  |
| Langsamste Route                   | Anforderungssuche, Median 131 ms                |
| Proxy: Status                      | 511-mal 200, kein 5xx                           |
| Proxy: Upstream-Dauer Median / p95 | 42,8 ms / 129,3 ms                              |
| Proxy: Eigenanteil Median          | 0,16 ms                                         |
| Jobübersicht                       | keine fehlgeschlagenen Jobs, Ankerjob minütlich |
| Älteste unverankerte Auditspitze   | höchstens eine Minute offen                     |

Eine fünfminütige Gegenprobe mit dem früheren Node-Wert von 5 Sekunden
Leerlaufzeit ergab ebenfalls 175 von 175 gültigen Antworten. Bei 12 Sekunden
Pause schließt die Anwendung die Verbindung lange vor dem nächsten Abruf; das
Wettlaufrisiko an der Leerlaufgrenze erfasst dieses Muster daher nicht. Die
Messung belegt eine fehlerfreie Strecke mit Reserve, keine Kapazitätsgrenze. Die
Sicherungen waren bei diesem Bestand zu kurz, um die Jobübersicht zu belasten.
Die produktiven Zeitlimits der einzelnen Installationen bleiben vor Ort zu
prüfen.

## Aufgabe 7: Rolling Update und Sitzungen

Zwei Webinstanzen liefen mit gemeinsamem PostgreSQL und Redis: „alt“ aus
`9b67b775` (Sekundenstempel) und „neu“ aus dem Arbeitsstand
(Millisekundenstempel, Redis-Uhr).

| Ablauf                                                         | alt        | neu        |
| -------------------------------------------------------------- | ---------- | ---------- |
| P vor dem Update auf alt angemeldet                            | gültig     | gültig     |
| Q nach dem Update auf neu angemeldet                           | gültig     | gültig     |
| P über neu abgemeldet, alte Sitzung                            | abgewiesen | abgewiesen |
| P 14 ms später über alt neu angemeldet                         | gültig     | gültig     |
| Q über alt abgemeldet, Wiederanmeldung über neu nach 12 ms     | abgewiesen | gültig     |
| Abmeldung und Wiederanmeldung auf neu nach 7 ms                | gültig     | gültig     |
| Abmeldung und Wiederanmeldung auf alt nach 6 ms (**Befund 3**) | abgewiesen | abgewiesen |
| Wiederanmeldung auf alt nach 1,5 s                             | gültig     | gültig     |

Eine Sitzung im Sekundenformat bleibt auf der neuen Instanz für die gesamte
Widerrufssekunde gesperrt; das ist so vorgesehen. Die alte Instanz vergleicht
weiter sekundengenau. Alle Abweichungen enden geschlossen. Das Produkt-Deployment
ersetzt den einzigen App-Container (`compose up -d --force-recreate`); gemischter
Betrieb entsteht vor allem bei einem Rollback.

**Befund 2 (Redis-Restore).** P und Q meldeten sich an. Danach wurde ein
Redis-Snapshot gezogen und P abgemeldet; der Widerruf stand in Redis, die
Sitzung war auf beiden Instanzen abgewiesen. Nach dem Zurückspielen des
Snapshots war P's abgemeldete Sitzung auf beiden Instanzen wieder gültig.

- Begrenzung: die absolute Lebensdauer von 24 Stunden. Ein älterer Stand
  belebt nur Sitzungen, die noch keine 24 Stunden alt sind.
- Weiterhin gesperrt bleiben deaktivierte Konten und alles, was die
  Datenbank über `authRevision` oder Portalzustände sperrt.
- Ein Failover auf ein Replikat ohne die letzten Schreibvorgänge wirkt
  gleich (aus dem Code abgeleitet, nicht getestet).
- Es gibt keinen globalen Widerrufsstichtag, kein Kommando „alle Sitzungen
  sperren“ und keinen Schritt im Runbook. Bis dahin bleibt Betreibern nur die
  Rotation von `AUTH_SECRET` nach dem dokumentierten Notfallverfahren.

Der Portalprofilwechsel wurde nur im Code geprüft: Der Wechsel übernimmt
Ausstellungszeit und Ursprungskontakt; die alte Version verliert dabei den
Millisekundenstempel.

## Behebung

**Befund 1.** Der Retag verlängert `document.retention_until` nur noch, wie die
Route für neue Versionen. Der neue Fall in
`apps/web/src/server/documents/__tests__/retag-db.test.ts` gegen PostgreSQL
belegt, dass die Höherstufung 6 → 8 Jahre das Ende 2033 nicht auf 2029 senkt
(`DOC-RETENTION-CLASS-001`).

**Befund 2.** Jede Sitzungsprüfung liest neben dem persönlichen Widerruf den
globalen Stichtag `revoke:all` in derselben Redis-Abfrage und verwendet den
späteren Wert. Das neue Kommando `./taxtronik revoke-all-sessions` setzt ihn mit
wörtlich demselben monotonen Lua-Skript auf die Redis-Serverzeit und bestätigt
nur nach belastbarem Nachlesen. Das
[Desaster-Recovery-Runbook](../operations/disaster-recovery.md#redis-stand-und-sitzungen)
schreibt den Schritt nach jedem Zurückspielen von `redis_data` und nach jedem
Failover vor. Belege: Unit-Tests in
`packages/crypto/src/__tests__/session-revocation.test.ts`, der Integrationsfall
in `apps/web/src/server/auth/__tests__/revocation.redis.test.ts` gegen ein
echtes Redis und `scripts/tests/ops-sessions.test.sh`
(`ACCESS-TENANT-RLS-001`). TOTP-Wiederholschutz und Anmeldesperren stellt das
Kommando nicht wieder her.

## Offene Entscheidungen

1. Recherchehinweise: Nachtrag bei wiederhergestellter Sicht, Empfang durch die
   für die Markierung zuständige Person, Idempotenz je Auftrag statt je Callback.
2. Späte Rechercheergebnisse nach Archivierung (Berufsträger).
3. StBVV-Auslagentext und Hebesatz-Vorbelegung (Befunde 6 und 7).
4. Wiederholung der kalten Wiederherstellung mit dem Betreiber (Aufgabe 5).
