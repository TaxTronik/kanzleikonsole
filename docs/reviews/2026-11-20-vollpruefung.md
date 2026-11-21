# Vollprüfung der Kanzleikonsole vom 20. November 2026

**Nachtrag vom 21. November 2026.** Die Vertragsprüfung gegen den neueren
TCMS-Quellstand und der Vergleich der ClamAV-Images haben eigene Nachweise.
[Nachprüfung für TCMS und Imagepflege](2026-11-21-tcms-integration-und-imagepflege.md)

Höchste Priorität hat der Bestandsschutz am Jahreswechsel. Bei Ereignissen
zwischen 23:00 und 24:00 UTC am 31. Dezember konnten einige Pfade den
Fristbeginn dem falschen Kalenderjahr zuordnen und
Unterlagen ein Jahr zu früh zur Vernichtung auswählen. Die Softwarekorrektur
und die beiden Datenbankmigrationen sind vorbereitet. Vor einer produktiven
Freigabe sind die bereits gespeicherten Versionen und ihre tatsächlichen
Schutzfristen gesondert zu prüfen. [Bestandsprüfung für die Kanzlei](../development/module/dokumentenarchiv.md#jahreswechsel-und-bereits-gespeicherte-schutzfristen).

Der Prüfstand umfasst den lokalen Arbeitsbaum mit den bei Beginn vorhandenen
Änderungen. Während der Prüfung wechselte der Checkout von `ed8ead2d` auf
`9b67b775` (Prettier 3.10.1). Für die Linux-Läufe wurden eigene Quellstände
aus einem separaten Git-Index exportiert. An den angeschlossenen PostgreSQL-,
Redis-, MailHog-, ClamAV-, SeaweedFS- und Tax-CMS-Diensten lagen ausschließlich
synthetische Daten. Es gab keinen Zugriff auf Kanzleiakten und keine
Produktivmigration. Der Arbeitsstand wurde weder veröffentlicht noch nach
Forgejo gepusht. Die dokumentierten CI-Befehle wurden lokal ausgeführt.
Ein gehosteter CI-Lauf für diesen Änderungsstand steht aus.

**Nachtrag vom 21. November 2026.** Der am Jahreswechsel festgestellte
Unterschied zwischen UTC und Berliner Kalenderdatum betraf auch Vorbelegungen
und Feldgrenzen in der Oberfläche. Der damalige Wiedervorlagentest leerte das
Fälligkeitsfeld, bevor er den vorgeschlagenen Tag geprüft hatte. Die Folgeprüfung
dokumentiert die betroffenen Einstiege und ihre einzelnen Nachweise.
[Checkliste zum Berliner Kalendertag](2026-11-21-berliner-kalendertag.md)

## Sicherheit und Bedienabläufe

- **Mandantentrennung.** Der privilegierte Zugriff auf einen einzelnen Mandanten
  berücksichtigt den Kanzlei-Tenant. Für Mandanten und Anforderungen verwenden
  Ansicht und CSV dieselben Zugriffs- und Suchfilter sowie eine eindeutige
  Sortierung. Der Browsertest meldet einen Fremdzugriff nur dann als verweigert,
  wenn er die konkrete geschützte Ressource mit einer gültigen Sitzung aufruft
  und ihre Daten verborgen bleiben. [Browsertests zur Mandantentrennung](../../apps/e2e/tests/07-compliance.spec.ts).
- **Archivierte Risikoprofile.** Die manuellen Schreibpfade prüfen Archivstatus
  und aktuelle Berechtigung unter derselben Datenbanksperre wie die Änderung.
  Das gilt auch, wenn zwischen Auswahl und Speichern ein zweiter Mitarbeiter
  das Profil archiviert. Ein bereits begonnener Dateiupload durchläuft die
  Prüfung nochmals. Der Test eines vor der Archivierung bereits angenommenen
  Auftrags zeigte, dass eine später eingehende Antwort einmalig als eigenes
  Ergebnis gespeichert und als Systemereignis protokolliert wird. Beim
  wiederholten Eingang blieben Analyse, Markierung und Prüfsumme der
  archivierten Version unverändert. Ob die Kanzlei solche Antworten im
  Archiv generell annehmen soll, bleibt eine fachliche Entscheidung.
- **Vertrauliche Recherchehinweise.** Wer einen Mandanten weiterhin sehen
  durfte, konnte in der Glocke noch Titel und Quellen einer Recherche lesen,
  obwohl die konkrete vertrauliche Markierung inzwischen einer anderen
  Person zugewiesen war. Bei neuen Hinweisen und beim Lesen vorhandener
  Hinweise gilt jetzt die Berechtigung für das konkrete Ergebnis. Auf
  einer echten PostgreSQL-Verbindung mit der Anwendungsrolle wurden auch
  Zähler, Liste, Gelesen-Markierung und weiterhin zulässige Zustellungen
  geprüft. Bei 1.000 Hinweisen anderer Typen wurde die zusätzliche
  Sichtbarkeitsfunktion kein einziges Mal ausgeführt. Bei zwei passenden
  Ergebnishinweisen waren es zwei Aufrufe. [Regel zu Benachrichtigungsempfängern](../fachkatalog/regeln/mandat-und-zugriff/access-notification-recipient-001-benachrichtigungsscope.md).
- **Sofortige Wiederanmeldung.** Im Browserprotokoll folgte 662 ms nach
  der Abmeldung eine erfolgreiche neue Anmeldung. 41 ms später entfernte
  die Anwendung deren Sitzung wieder. Der Widerruf in Redis hatte
  Millisekundengenauigkeit, das neue Sitzungstoken nur Sekundengenauigkeit.
  Neue Mitarbeiter- und Portalsitzungen behalten den ursprünglichen
  Anmeldezeitpunkt jetzt auch in Millisekunden. Ausstellung, Widerruf und
  Prüfung verwenden dieselbe Redis-Uhr. Die Gegenproben umfassen einen um
  750 ms nachlaufenden Webserver und Webprozesse mit unterschiedlichen
  Uhren. Ein exakt gleichzeitiger
  Widerruf greift weiterhin. Bei Bestandssitzungen mit Sekundenwert bleibt
  die gesamte Widerrufssekunde gesperrt. Die Gegenproben umfassen beide
  Oberflächen und die Werte eine Millisekunde vor, auf und nach dem Widerruf.
  [Zeitvergleich](../../packages/crypto/src/session-revocation.ts), [Nachweis der Sitzungsbindung](../../apps/web/src/server/auth/session-issued-at.ts).
- **Bedienung.** Verschachtelte Dialoge geben den Tastaturfokus zurück.
  Einstellungen warnen bei ungesicherten Änderungen. Im Ordnerdialog lassen
  sich fehlgeschlagene Dateien eines Sammelvorgangs einzeln nachholen.
  Gespeicherte Filteransichten aus zwei Tabs bleiben erhalten. Bei erschöpfter
  Speicherquote bleibt die Auswahl im laufenden Tab nutzbar. Die lokale
  GwG-Ausweisvorschau gibt ihren Bildspeicher beim Schließen frei. Lange
  Tabellenblätter haben eine begrenzte Vorschau. Die Browsernachweise
  verwenden unter anderem die Tastatur, schmale Fenster und parallele Tabs.
- **Laufzeit und Lieferkette.** Docker übernimmt lokale Zugangsdaten,
  Sicherungsschlüssel und Modellcaches auch aus verschachtelten Ordnern
  nicht in den Build-Kontext. Eine echte `COPY`-Probe prüfte elf ausgeschlossene
  Marker und zwei erlaubte Dateien. Zwei pnpm-Advisoryläufe für Produktion und
  gesamten Paketgraphen meldeten keine bekannten Schwachstellen. Gitleaks
  fand bei 1.144 untersuchten Commits keinen Treffer. Die zehn Kontrollfälle
  der Allowlist bestanden. Diese Prüfungen haben jeweils ihre eigene Reichweite.
- **Alpine-Pakete.** Beide zunächst gebauten Images enthielten
  `zlib 1.3.2-r1`. Alpine führt den Fix für CVE-2026-4738 in Version
  `1.4-r0`. Der aktuelle Basis-Digest enthielt noch die ältere Fassung.
  Die Dockerfiles verlangen daher die korrigierte Mindestversion. Das
  signierte x86-64-Paket enthält die Laufzeitbibliothek und keine
  Installationsskripte. Die veröffentlichte Fehlerbeschreibung betrifft
  einen GDAL-Beitrag. Ein erreichbarer Fehler im Kanzlei-Webprozess wurde
  hieraus nicht abgeleitet. [Alpine-Sicherheitseintrag](https://security.alpinelinux.org/vuln/CVE-2026-4738), [Alpine-Paket](https://pkgs.alpinelinux.org/package/v3.23/main/x86_64/zlib).

## Betrieb, Schnittstellen und Wiederherstellung

- Datenbank-Dumps entstehen in privaten temporären Dateien. Fehler beim
  Schreiben, Prüfen oder Veröffentlichen erreichen den aufrufenden Job.
  Ein abgebrochener Bucket-Export erhält kein Erfolgsmanifest. Der
  TCMS-Zeitplan erhält fremde Cronjobs auch bei Lesefehlern oder
  unvollständigen Markierungen. Installation, Wiederholung, Entfernung
  und die Behandlung einer beschädigten Markierung liefen gegen eine echte
  Debian-Crontab eines isolierten Benutzers.
- Beim ersten Datenbank-Restore stimmten die Zeilenzahlen, aber die
  Audit-Tabelle war leer. Der Selbsttest meldete dennoch eine intakte
  Auditkette und verwendete einen festen Datenbanknamen, den er vorab
  löschte. Jetzt erzeugt jeder Lauf sein eigenes Ziel. In PostgreSQL 18.7
  bestätigten zwei parallele Restores die richtige Quellspitze zweier echt
  verketteter Ereignisse und wiesen eine falsche Spitze ab. Ein absichtlich
  kollidierendes CREATE erhielt SQLSTATE 42P04. Die bereits vorhandene
  Datenbank behielt ihre OID. Der Test einer leeren Quelle weist den
  fehlenden Kettennachweis aus. [CI-Roundtrip](../../scripts/ci/restore-roundtrip.sh),
  [Restore-Selbsttest](../../scripts/restore-selftest.sh).
- Der Operator bestätigte auch ein korrekt signiertes und entschlüsselbares
  Vollbackup mit leerem Datenbankordner als vollständig. Die Inhaltsprüfung
  verlangt jetzt Haupt- und n8n-Dump. Bei drei aktuellen und älteren gültigen
  Formaten stimmten nach echter age-Entschlüsselung die Dumpbytes, ihre
  PostgreSQL-Inhaltsverzeichnisse, die drei Testvolumen und die synthetische
  Konfiguration. Fünf gültig signierte unvollständige Varianten wurden
  abgewiesen. Die äußere Signaturprüfung bleibt separat möglich.
- Im isolierten Compose-Stack wurden PostgreSQL und n8n logisch gesichert.
  Nach dem Anhalten der Schreibdienste entstanden kalte Sicherungen der
  SeaweedFS-, Redis- und n8n-Volumes. Beide Datenbanken wurden in ein
  neues PostgreSQL-Volume zurückgespielt und die drei anderen Archive in
  neue benannte Volumes entpackt. Nach dem Wiederanlauf stimmten die
  Marker beider Datenbanken, der Redis-Schlüssel, die n8n-Datei sowie
  Inhalt, Versions-ID und COMPLIANCE-Datum zweier Fassungen desselben
  S3-Schlüssels. Web, Worker und Infrastruktur wurden wieder betriebsbereit.
  Externer Offsite-Speicher, Traefik-Zertifikate und produktive Zugangsdaten
  waren in diesem Testaufbau nicht enthalten.
- Die Probe deckte einen Fehler im Release-Test auf. Der S3-Dienst war
  erreichbar und der Stack meldete Bereitschaft, obwohl die Schutz-Buckets
  noch fehlten. Der erste geschützte Schreibvorgang erhielt HTTP 400.
  Der Release-Test führt jetzt die reguläre Bucket-Initialisierung vor dem
  Start von Web und Worker aus. Derselbe geschützte Schreibvorgang und die
  spätere Wiederherstellung seiner Versionen gelangen anschließend.
- Ein zweiter Fehler betraf den Abbruch bei bereits belegter Umgebung.
  Der frühere Release-Test kündigte seinen Abbruch an und rief danach
  trotzdem `compose down -v` und die Image-Bereinigung auf. Das ließ
  sich auch bei einer fehlgeschlagenen Docker-Bestandsabfrage beobachten.
  Beide Vorprüfungen laufen jetzt vor dem ersten Containerstart und vor
  der Registrierung der Bereinigung. Jeder Aufruf erhält einen eigenen
  Projektnamen und eigene Image-Tags. Bei der Gegenprobe an einem echten,
  isolierten Docker-Daemon behielten der vorhandene Testcontainer seine ID
  und dessen Volume seinen ursprünglichen Inhalt. [Regressionstest](../../scripts/release/tests/smoke-preflight.test.mjs).
- Unter hoher Datenträgerlast meldete ein früher Lauf beim Quittieren
  eines `audit-anchor`-Jobs eine verlorene BullMQ-Sperre. Der Worker prüft
  fällige Spitzen erneut. Eine zusätzliche PostgreSQL-Sperre und zwei
  Eindeutigkeitsschlüssel schützen die persistierte Ankerkette. Ob die
  externe Zeitstempelstelle einen konkreten Aufruf mehrmals erhält, lässt
  sich daraus nicht ableiten. Die Jobübersicht markiert fehlende Erfolge
  nach 30 Sekunden, der Betriebsalarm prüft wiederholt unverankerte
  Ereignisse. Eine externe Überwachung bleibt für den vollständigen
  Worker-Ausfall erforderlich.
- Die zehn Speicherprüfungen liefen gegen SeaweedFS und ClamAV. Sie
  bestätigen die fünf Buckets, beide Lock-Modi, einen Schreib-/Lese-/
  Löschvorgang im allgemeinen Bucket, die Erkennung der EICAR-Testdatei
  und den Scan einer Datei mit 25 MiB. Der Bereitschaftstest für den
  Scanner erwartet die tatsächliche ClamAV-Antwort.
- Die gepinnte Tax-CMS-Version lief als separater Dienst mit PostgreSQL.
  14 Vertragstests sowie 27 Tests der angebundenen Oberflächen und Aktionen
  bestanden. Die korrigierte Testauswahl für eine bearbeitbare Kontrolle
  wurde auf demselben Datenbestand wiederholt. Drei XRechnungs-Beispiele
  einschließlich Storno und Reverse Charge erhielten im KoSIT-Validator
  das Ergebnis `ACCEPTABLE`. Fünf Redis-Integrationstests prüften die
  Einmaleinlösung eines Anmeldetickets, die Reihenfolge des Sitzungswiderrufs
  und den gemeinsamen Zeitbezug.
- Die reguläre Mitarbeiteranmeldung lief zusätzlich über einen lokalen
  HTTPS-Proxy mit vom Testbrowser als vertrauenswürdig eingestuftem
  Zertifikat. TOTP war verpflichtend. Der Browser richtete den zweiten
  Faktor ein, bestätigte die Recovery-Codes und öffnete das geschützte
  Profil mit einem `Secure`- und `HttpOnly`-Host-Cookie. Nach dem Logout
  verlor auch ein zweiter Browserkontext mit der zuvor gültigen Sitzung
  den Profilzugriff. Die erneute Anmeldung mit frischem TOTP gelang.
- Die Signal-Provisionierung prüft Modell und Engine vor dem atomaren
  Wechsel. Mit der gepinnten nativen Engine b9986 lud ein unprivilegierter
  Linux-Prozess das 6.253.884.064 Byte große Modell und beantwortete eine
  lokale Inferenzanfrage. Das eigentliche externe Signal-Produktionsimage
  stand für diesen Test nicht zur Verfügung.

## Technischer Prüfumfang

| Prüfstrecke                 | Beobachtetes Ergebnis                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Linux-Installation          | Node 24.22.3 und pnpm 12.20.0. Installation von 20 Workspaces mit leerem `node_modules`, neuem leerem Store, `--frozen-lockfile --prod=false` und aktivierten Installations-Hooks.                                                                                                                                                                                       |
| Unit-Tests und Typen        | 8.798 bestandene Tests in allen 16 CI-Aufgaben außerhalb der DB-Matrix, ohne Cachetreffer. 19 Paket-Typechecks sowie der separate Skript-Typecheck bestanden.                                                                                                                                                                                                            |
| Bedingte Webtests           | 44 Fälle waren im Unit-Lauf deaktiviert. Fünf Redis-Fälle und 27 Tax-CMS-Oberflächenfälle liefen separat mit Diensten. Die zwölf weiteren optionalen TCMS-Sicherheits-Livefälle wurden nicht ausgeführt.                                                                                                                                                                 |
| PostgreSQL                  | Je 967 von 967 Pakettests auf einer frisch migrierten Datenbank, nach dem Upgrade von `v0.2.1` und nach Reparatur historischer Migrationsprüfsummen. Der letzte Lauf nutzte PostgreSQL 18 auf einem temporären RAM-Dateisystem. Zusätzlich 299 Web-, 43 Evidence-, 128 Worker-, drei Mail- und sieben Mandatsfälle. Schema-Drift, RLS und Fremdschlüsselindizes geprüft. |
| Release-Images              | Web und Worker lokal gebaut. Trivy 0.71.0 untersuchte den Betriebssystem- und Node-Paketbestand der beiden unveränderlichen Images. Der Datenstand vom 20.11.2026 um 13:11 UTC ergab keine gemeldeten HIGH-/CRITICAL-Schwachstellen. Die CycloneDX-Stücklisten enthalten 156 bzw. 364 Komponenten.                                                                       |
| Reproduzierbarer Ordnerlauf | Beim Prüfen der Zielordner für 40 ausgewählte aus 1.000 Geschwisterordnern sank die Medianlaufzeit in je 24 Messungen von 67,015 auf 0,060 ms. Das 95. Perzentil sank von 72,325 auf 0,071 ms. Gemessen wurde die Berechnung gültiger Ziele, ohne Browserrendering.                                                                                                      |
| Listen und CSV              | 10.004 Mandanten, 50.001 Anforderungen. Die jeweils ersten 100 sichtbaren Zeilen stimmten in Inhalt und Reihenfolge mit dem Export überein. Alle 100 bzw. 5.500 gefilterten Exporttreffer wurden geprüft. Bei 50.001 Anforderungen enthielt der ungefilterte CSV-Export 10.000 Zeilen und den vorgesehenen Kürzungshinweis.                                              |

Die ungefilterte Chromium-Suite bestand auf dem finalen Web-Image und einer
frisch migrierten Datenbank mit **238 von 238 Tests** in 7,3 Minuten.
Playwright erkannte 30 Spec-Dateien und führte den Lauf mit einem Worker
und ohne automatische Wiederholungen aus. Der zuvor fehlgeschlagene Ablauf
mit sofortiger Wiederanmeldung bestand außerdem drei einzelne Läufe auf
einer separaten Datenbank.

Die abschließend gebauten Images tragen die lokale Git-Baumkennung
`6743843c6f468ebba72317e46cd42df1f134439d`. Für den isolierten zweiten
Docker-Daemon wurden Plattformmanifest und sämtliche Image-Layer nach der
Übertragung verglichen. Der reguläre Stacklauf bestätigte die konkreten
Image-IDs, das Revisionslabel und die Bereitschaft von Web und Worker.
Der Vergleich von 2.698 Programm-, Paket-, Infrastruktur- und Skriptdateien
mit dem Linux-Export ergab keine Abweichung. Nach dem Build änderten sich
noch Browser-Testhelfer und Dokumentation. Der Prüfstand ist unveröffentlicht.

Die Simulationen verwendeten getrennte PostgreSQL-Instanzen oder eigene
Datenbanken. Beim parallelen Imagebau und beim Entpacken von Containern
kam es zu Zeitüberschreitungen in verschiedenen Test-Fixtures. Die grünen
Zahlen stammen aus tatsächlich bestandenen Gesamtläufen. Die ursprünglichen
Fehlprotokolle sind im lokalen Prüfordner erhalten. Die Zeitlimits der
Testkonfiguration wurden beibehalten.

Ein späterer Gesamtlauf zeigte drei zusammenhängende Fehler, als die
Browserdatenbank einen eigenen Namen erhielt. Der Webserver schrieb in
die konfigurierte Datenbank. Vier SQL-Helfer verwendeten unabhängig davon
den Standardnamen `taxtronik`. Eine eindeutig benannte Testvorlage fand
sich bei der Gegenabfrage genau einmal in dieser zweiten, ebenfalls
isolierten Datenbank und fehlte im vorgesehenen Ziel. Das betraf auch
die unabhängigen Prüfungen von hochgeladenen Dokumenten und Auditzeilen.
Der gemeinsame SQL-Helfer verwendet jetzt das festgelegte Datenbankziel,
prüft es gegen die Anwendungs-URL und bricht bei Widerspruch vor der
ersten Abfrage ab. Ein SQL-Fehler löst keine erneute Ausführung über einen
anderen Zugang aus. Sechs Konfigurationsfälle prüfen diese Zuordnung.
[SQL-Helfer und Regressionen](../../apps/e2e/unit/postgres.test.ts).

### HTTP-Dauermessung

Sieben authentifizierte Abrufe wechselten zwischen Dashboard, Suchergebnis,
erster und hundertster Listenseite. Jede Messung prüfte den HTTP-Status und
das ausgelieferte HTML auf den Hauptinhalt und auf Fehler- oder
Weiterleitungsseiten. Zwischen den Serien lagen zwölf Sekunden. Die Laufzeiten
enthalten das Lesen des vollständigen HTML. Die drei Stände liefen unter
wechselnder Hintergrundlast auf derselben Maschine.

| Prüfstand                    |  Dauer | Gültige Antworten / Versuche | Median | 95. Perzentil | RSS des Webprozesses |
| ---------------------------- | -----: | ---------------------------: | -----: | ------------: | -------------------: |
| Ausgangsstand                | 30 min |                    927 / 931 |  55 ms |        170 ms |          456–632 MiB |
| Zweiter Stand                | 80 min |                2.429 / 2.443 |  53 ms |        160 ms |          441–626 MiB |
| Vier gleichzeitige Sitzungen | 48 min |                6.008 / 6.034 |  59 ms |        191 ms |          444–843 MiB |

Die Perzentile beziehen sich auf die gültigen Antworten. Bei den übrigen
Abrufen meldete der Client einen Transportfehler. In einer 23-minütigen
Gegenprobe am selben Server meldete Node bei wiederverwendeten Verbindungen
dreimal `UND_ERR_SOCKET` mit `other side closed` (725 von 728 erfolgreich).
Mit `Connection: close` gelangen alle 728 Versuche. Bei einem
Server-Leerlaufzeitlimit von 65 Sekunden gelangen alle 679 Versuche in
20 Minuten. Zwei NGINX-Gegenproben mit unterschiedlicher upstream-Leerlaufzeit
lieferten in je 15 Minuten jeweils 504 von 504 gültigen Antworten.

Mit dem neuen Compose-Standard von 95 Sekunden gelangen im separaten
15-Minuten-Lauf alle 497 Abrufe. Der Median betrug 40 ms und das 95. Perzentil 150 ms. Nach Ende der vier gleichzeitigen Sitzungen
ging der residente Speicher des beobachteten Webprozesses von rund
820 auf rund 490 MiB zurück. Die Messung erfasst weder eine
Kapazitätsgrenze noch das Verhalten über mehrere Betriebstage.

Nach den Änderungen am Sitzungswiderruf und an der Sichtbarkeit der
Benachrichtigungen lief dieselbe Prüfung nochmals gegen das endgültige
Web-Image mit allen 292 Migrationen, 10.004 Mandanten und 50.001
Anforderungen. Alle 476 Abrufe in 15 Minuten lieferten gültiges HTML.
Median und 95. Perzentil lagen bei 47 und 161 ms, der Speicherverbrauch
des Webprozesses bei 413 bis 568 MiB.

Mit 95 Sekunden läuft die
Verbindung hinter den üblichen Proxyvorgaben länger auf dem Anwendungsserver.
Die produktiven Traefik-Strecken der einzelnen Installationen müssen mit
ihren tatsächlichen Zeitlimits beurteilt werden.
[Next.js zum Timeout hinter Proxys](https://nextjs.org/docs/app/api-reference/cli/next#configuring-a-timeout-for-downstream-proxies), [NGINX-Upstream-Konfiguration](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#keepalive_timeout), [Traefik-Konfiguration](https://doc.traefik.io/traefik/v3.7/reference/install-configuration/configuration-options/).

## Fachprüfung

Das größte fachliche Risiko betraf die vorzeitige Vernichtung und Redaktion.
Um 23:00 UTC am 31. Dezember beginnt in Deutschland bereits das neue Jahr.
Ein Teil der Fristrechnung verwendete an dieser Grenze das Vorjahr. Damit
konnten eine Datei, ein GwG-Prüffall oder die personenbezogenen Angaben
eines beendeten Mandats ein Jahr zu früh zur Vernichtung oder Redaktion
anstehen.

### Aufbewahrung, GwG und personenbezogene Mandatsdaten

Die korrigierten Pfade bestimmen das Jahr des Ankers in `Europe/Berlin`.
Die bestehende technische Freigabe erfolgt am 1. Januar um 00:00 UTC.
Im älteren Mandatsendepfad ist der Anker der tatsächliche Zeitpunkt der
Bedienhandlung. Beim Offboarding übernimmt die Anwendung ein bestätigtes
Kalenderdatum als 00:00 UTC. Bei Dokumenten verwendet sie je nach Ablauf den
Uploadzeitpunkt, die ursprüngliche Anlage bei einer Höherstufung oder den
Zeitpunkt der gebundenen Revision bei einer Ausgabe aus Mandantenangaben.
Der fachlich maßgebliche Anlass muss aus der jeweiligen Akte hervorgehen.
[§ 147 Abs. 3 und 4 AO](https://www.gesetze-im-internet.de/ao_1977/__147.html),
[§ 14b Abs. 1 UStG](https://www.gesetze-im-internet.de/ustg_1980/__14b.html),
[§ 66 StBerG](https://www.gesetze-im-internet.de/stberg/__66.html).

| Gespeicherter Zeitpunkt     | Deutscher Kalendertag | Produktstichtag bei 5 Jahren | Bei 8 Jahren | Bei 10 Jahren |
| --------------------------- | --------------------- | ---------------------------- | ------------ | ------------- |
| 31.12.2026 22:59:59,999 UTC | 31.12.2026            | 01.01.2032                   | 01.01.2035   | 01.01.2037    |
| 31.12.2026 23:00:00 UTC     | 01.01.2027            | 01.01.2033                   | 01.01.2036   | 01.01.2038    |

JavaScript und PostgreSQL lieferten beide Tabellenzeilen übereinstimmend.
Die SQL-Prüfung verwendete Sitzungen in UTC, Los Angeles und Kiritimati.
16.884 weitere JavaScript-Vergleiche an Jahreswechseln von 1900 bis 2100
prüften, ob die Einzelfrist und der Suchfilter dieselben Fälle als fällig
erkennen. Die beiden Migrationen entsprechen ihren sieben kanonischen
Funktionen. Bei den sechs ersetzten Funktionen blieben Signaturen, Rechte und
Sicherheitsattribute erhalten. Der Abgleich von sieben betroffenen Tabellen
ergab dieselben Zugriffsregeln für Datenbankzeilen. [Migration für die Aufbewahrung](../../packages/db/prisma/migrations/20261120120000_berlin_retention_year/migration.sql), [Migration für die Redaktion](../../packages/db/prisma/migrations/20261120120100_berlin_mandate_redaction/migration.sql).

Der Bestandsabgleich erhöht berechenbare, zu kurze Stichtage für GwG-Belege
mit aktuellem oder früherem TCMS-Nachweisverweis. Ein fehlender Stichtag
sperrt weiterhin die Vernichtung. Vorgemerkte Fälle durchlaufen beim
Vernichtungsversuch erneut die Fristprüfung. Die Anwendung behält beim
Ausblenden und Höherstufen gebundene GoBD-Versionen. Bereits physisch
vernichtete Inhalte und fehlende historische Anker lassen sich mit der
Migration nicht rekonstruieren. Bestehende COMPLIANCE-Locks regulärer
GoBD-Versionen müssen im produktiven Speicher versionsgenau geprüft werden.
Eine solche Bestandsprüfung war nicht Teil des isolierten Testlaufs.
Im isolierten SeaweedFS wurden acht regulär hochgeladene und von ClamAV
gescannte Versionen vor und nach dem Jahreswechsel anhand ihrer konkreten
Versions-ID ausgelesen. Für alle acht stimmten Modus und Datum. Sechs
Verlängerungen auf die zehnjährige Frist wurden dauerhaft übernommen.
Erneute Anforderungen und frühere Zieldaten verkürzten bestehende Sperren
nicht.
Betroffene Regeln sind `DOC-RETENTION-CLASS-001`, `DOC-OBJECT-LOCK-001`,
`GWG-RETENTION-DESTRUCTION-001`, `TCMS-NACHWEIS-001`,
`DSGVO-MANDATE-ANONYMIZATION-001`, `POA-SIGNER-RETENTION-001` und
`CLIENT-MANDATE-LIFECYCLE-001`. [Anleitung zur Bestandsprüfung](../development/module/dokumentenarchiv.md#jahreswechsel-und-bereits-gespeicherte-schutzfristen).

Das Initialisierungsskript bezeichnete zehn Jahre Aufbewahrung für
GwG-Unterlagen pauschal als unzulässig. Das widersprach dem Katalog und
dem Wortlaut des § 8 Abs. 4 GwG. Der Kommentar benennt jetzt die
fünfjährige Standardkonfiguration des Buckets. Für eine konkrete Version
gelten der einschlägige Fristbeginn und die besonderen Aufbewahrungspflichten.
Die Behandlung doppelt verwendeter Unterlagen bleibt eine der unten
aufgeführten Fragen an die Berufsträger. [§ 8 Abs. 4 GwG](https://www.gesetze-im-internet.de/gwg_2017/__8.html), [Initialisierung der Schutz-Buckets](../../infra/scripts/init-storage.sh).

### Gebühren, Fristen und Steuerschätzung

- **`STBVV-CALCULATION-001`** Der Rechner sperrte einen zweiten dokumentierten Arbeitsgang für elektronische Dateien in derselben Angelegenheit. VV 7000 Nr. 2 begrenzt die Dateipauschale je Arbeitsgang. Vier und zwei Dateien in zwei Arbeitsgängen ergeben im Test 5,00 und 3,00 Euro. Sechs Dateien in einem Arbeitsgang ergeben 5,00 Euro vor einem gegebenenfalls höheren Scan-Mindestbetrag. Der erneute Import der vier amtlichen HTML-Anlagen ergab dieselben 277 Tabellenstufen und vier Quellenhashes. [§ 17 StBVV](https://www.gesetze-im-internet.de/stbgebv/__17.html), [VV 7000 RVG](https://www.gesetze-im-internet.de/rvg/anlage_1.html), [Tabellen- und Berechnungstests](../../packages/tax/src/stbvv/calculator.test.ts).

- **`TAX-DEADLINE-ANNUAL-001`** Für beratene kalenderjährige Jahreserklärungen 2019 fehlte die besondere Frist. Die vier Regelfälle ESt, KSt, GewSt und USt ergeben jetzt den 31.08.2021. Ohne beauftragte Erstellung ergibt sich im Regelfall der 31.07.2020. Vorhandene Fristeneinträge bedürfen bei abweichenden Ankern einer eigenen Aktenprüfung. [Art. 97 § 36 EGAO](https://www.gesetze-im-internet.de/aoeg_1977/art_97__36.html), [§ 149 AO](https://www.gesetze-im-internet.de/ao_1977/__149.html).

- **`TAX-DEADLINE-WORKDAY-001`** Der Kalender fehlte bei einzelnen historischen und einmaligen Feiertagen. Beispiele sind der 08.05.2025 in Berlin und der bundesweite 31.10.2017. Ein Berliner Fristende am 08.05.2025 verschiebt sich auf den 09.05.2025. In Brandenburg bleibt derselbe Donnerstag ein Werktag. Landeszugehörigkeit, Einführung und einmalige Geltung sind in den Nachweisen getrennt erfasst. [Regel mit Landesquellen und Testverweisen](../fachkatalog/regeln/fristen-und-bescheide/tax-deadline-workday-001-werktagsverschiebung.md).

- **`BWA-TAX-ESTIMATE-001`** Die Ertragsteuerschätzung verwendete auch bei Teilperioden und abweichenden Wirtschaftsjahren das Endjahr. Zahlen werden jetzt nur für vollständige Kalenderjahre 2025 und 2026 innerhalb des Modellumfangs ausgegeben. Ein fehlender erforderlicher Hebesatz unterdrückt die Beträge und die Summe. Die obere Eingabegrenze von 900 Prozent ist eine Modellgrenze. Der Browsernachweis prüft unter anderem leere und anschließend korrigierte Eingaben. [BWA-Regel und Bereichsgrenzen](../fachkatalog/regeln/bwa-und-planung/bwa-tax-estimate-001-vereinfachte-steuerschaetzung.md), [§ 23 KStG](https://www.gesetze-im-internet.de/kstg_1977/__23.html), [§ 16 GewStG](https://www.gesetze-im-internet.de/gewstg/__16.html).

- **`INV-DUE-OVERDUE-001`** Kanzlei- und Portalansicht markierten versendete Korrekturbelege nach ihrem Datum als überfällig. Die Ansichten berücksichtigen jetzt denselben Stornobezug wie der zuständige Worker. [Regel und Anzeigenachweise](../fachkatalog/regeln/rechnungen/inv-due-overdue-001-ueberfaelligkeitsstatus.md).

**BWA-Projektion.** Ein ADDISON-Import mit 60.000 Euro Halbjahresumsatz
und 400.000 Euro für November 2026 bis Februar 2027 ergab im Dashboard
eine Jahreserwartung von 1,2 Millionen Euro für 2026. Die lineare
Hochrechnung verwendet jetzt allein die geeignete Halbjahresperiode und
zeigt 120.000 Euro. Liegt ausschließlich die Periode über den Jahreswechsel
vor, entfällt die lineare Hochrechnung. Ein weiterer Test prüft den
Jahreswechsel vom 31.12.2026 auf den 01.01.2027 in der gerenderten
Überschrift unmittelbar vor und ab Berliner Mitternacht. [Regel BWA-PROJECTION-001](../fachkatalog/regeln/bwa-und-planung/bwa-projection-001-szenariorechnung.md), [Dashboard-Nachweis](../../apps/web/src/components/bwa/__tests__/dashboard-projection.test.tsx).

**Einspruchsfrist und Rechnungsstorno.** Für den Inlandsversand am
15.04.2025 in Niedersachsen ergibt der geprüfte Regelfall die Bekanntgabe am
22.04. und das Fristende am 22.05.2025 am Behördensitz in NRW. Für den
Versand am 04.05.2025 nach Berlin sind es nach dem dortigen einmaligen
Feiertag der 09.05. und nach Pfingstmontag der 10.06.2025. Für 20.000
synthetische Rechnungen mit drei Positionen zu 19, 7 und 19 Prozent und centgenauen Beträgen
stimmten gruppierte USt und Brutto mit einer unabhängigen Ganzzahlrechnung
überein. Alle Vollstornos invertierten diese Beträge. Bei Zahlung vor
Vollstorno dokumentiert die Anwendung den Rückzahlungsbedarf und hält die
Zeiteinträge am Original. Die tatsächliche Rückzahlung ist ein gesonderter
Vorgang. [Einspruchsnachweis](../../packages/tax/src/__tests__/legal-assessments.test.ts), [DB-Test zur Zahlung und Stornierung](../../apps/web/src/server/invoicing/__tests__/invoice-concurrency-db.test.ts).

Weitere Regressionstests prüfen die Berliner Zeitumstellung, unmögliche
Kalendertage in manuellen Erfassungen und den Monatswechsel in Kanzlei- und
Steuerkalender. Ein Termin in der ausgefallenen Stunde des Frühjahrs wird
abgewiesen. Beim Bearbeiten einer bestehenden doppelt vorkommenden
Herbststunde bleibt der bereits gespeicherte Zeitpunkt erhalten, wenn die
angezeigte Minute unverändert übernommen wird. [Änderungsnachweise zu den Fachregeln](../fachkatalog/AENDERUNGEN.md).

### Reichweite des Fachkatalogs

Der geprüfte Katalog enthält 87 aktive und acht reservierte Regel-IDs. Keine
Regel ist als historisch ausgewiesen. Die technischen Umsetzungsangaben
lauten 32-mal „umgesetzt“ und 55-mal „teilweise umgesetzt“. Alle 87 fachlichen
Prüfstatus lauten `unreviewed`. Zu jeder aktiven Regel existiert mindestens
eine referenzierte Testdatei, die ihre ID nennt. In der Bestandsaufnahme
wurden 896 Testverweise auf 602 unterschiedliche Dateien, 1.250 Codeverweise
auf 839 Dateien sowie 158 Verweise auf 46 Funktionsbeschreibungen geprüft.
Diese Zahlen messen die Verknüpfung des Katalogs mit dem Bestand. Wie weit
ein Test fachlich trägt, hängt vom jeweiligen Testfall ab.

80 Regeln weisen weder Gültigkeitsbeginn noch -ende aus, sechs nur einen
Beginn. Das einzige begrenzte Fenster, `BWA-TAX-ESTIMATE-001`, endet am
31.12.2026. Am Prüfungstag war kein ausgewiesenes Gültigkeitsfenster
abgelaufen. Die geprüften Quellenverweise tragen Prüfdatumsangaben zwischen
23.08. und 20.11.2026. Eine Berufsträgerfreigabe steht bei sämtlichen Regeln
aus. [Katalog und Status je Regel](../fachkatalog/INDEX.md).

### Aufgaben für Claude im CVP-Modus

1. Verfolge für eine historische GoBD-Version den ursprünglichen Upload,
   ein späteres Retag und eine rückwirkende Revisionsausgabe. Belege je
   Weg, aus welcher Spalte der Fristanker stammt, ob die konkrete
   Versions-ID rekonstruierbar ist und welche Löschpfade die Version
   sehen. Führe die Gegenprobe im isolierten Speicher auch mit einem
   ausgeblendeten Dokument und einem bereits abgelaufenen Alt-Lock aus.
2. Vergleiche bei einem GwG-Beleg mit freigegebenem TCMS-Verweis Auswahl
   in der Warteschlange, Datenbank-Vormerkung, Fristprüfung vor dem Löschen
   und GOVERNANCE-Lock derselben Version. Variiere Mandatsende,
   Feststellungsdatum, fehlendes Aufbewahrungsende und einen bereits
   früher gesetzten längeren Lock. Dokumentiere pro Fall den ersten
   schreibenden Schritt und die beobachtete Sperre.
3. Leite eigenständige Sollwerte für StBVV-Arbeitsgänge, BWA-Teiljahre
   und ausgewählte historische Fristenden aus den verlinkten Quellen ab.
   Vergleiche mit der normalen Benutzeroberfläche und dem erzeugten
   Rechnungsentwurf bzw. Fristeintrag. Kennzeichne Fragen, bei denen ein
   Aktenmerkmal oder eine fachliche Entscheidung fehlt.
4. Kläre mit der verantwortlichen Person, ob bereits beauftragte
   Rechercheergebnisse nach Archivierung als eigener Systemeingang zur
   Akte gehören. Vergleiche die gewählte fachliche Vorgabe mit dem
   nachgewiesenen Ablauf. Prüfe für bestehende und neue Hinweise zusätzlich
   den Wechsel zwischen Stellvertretung und direkter Zuständigkeit an zwei
   verschiedenen vertraulichen Markierungen desselben Mandanten.
5. Wiederhole die kalte Wiederherstellung unter den tatsächlichen
   betrieblichen Voraussetzungen. Prüfe mit dem Betreiber die getrennte
   Verfügbarkeit der age-Identität, des Signaturprüfschlüssels und der
   Offsite-Kopie. Vergleiche für ausgewählte historische Versionen
   Datenbankreferenz, Dateihash, Versions-ID, Lock-Modus und Stichtag.
6. Messe die sieben Listen-/Dashboardabrufe an einer produktionsgleichen
   Proxy-Strecke mit synthetischen Daten. Erfasse Client-Socketfehler,
   Proxy-Status, Antwortzeit und Laufzeit des Anwendungsrequests getrennt.
   Kontrolliere bei gleichzeitigen Sicherungen auch die Jobübersicht und
   die älteste unverankerte Auditspitze.
7. Prüfe ein rollendes Update mit einer schon vor dem Update angemeldeten
   Person und einer neu angemeldeten Person. Verfolge beide Sitzungen auf
   zwei Webinstanzen durch Abmeldung, erneute Anmeldung und Portalprofilwechsel.
   Halte fest, wie Betreiber bei einem Redis-Failover oder dem Zurückspielen
   eines älteren Redis-Backups die bisherigen Sitzungswiderrufe erhalten
   oder vorhandene Sitzungen erneut sperren.

### Fragen an die zuständigen Berufsträger

- **Doppelfunktion von Unterlagen.** Wie soll die Kanzlei einen zugleich
  steuerlich benötigten GwG-Nachweis behandeln, wenn die Zehnjahresgrenze
  erreicht ist? Welche Tatsachen und getrennten Ausfertigungen tragen einen
  fortbestehenden Steuerzweck? § 8 Abs. 4 Satz 1 GwG berücksichtigt längere
  gesetzliche Pflichten. Satz 2 bestimmt die äußerste Vernichtungsfrist
  der GwG-Aufzeichnungen. Die technische Produktregel wartet derzeit auf
  den Ablauf beider Fristen. [§ 8 Abs. 4 GwG](https://www.gesetze-im-internet.de/gwg_2017/__8.html), [§ 147 Abs. 3 AO](https://www.gesetze-im-internet.de/ao_1977/__147.html).
- **Bestand und Sonderfristen.** Welches Ereignis belegt bei jedem
  Dokumenttyp den Fristbeginn? Wie erkennt die Kanzlei offene Verfahren,
  beaufsichtigte Institute mit zehnjähriger Buchungsbelegfrist sowie
  abweichende Herausgabe- oder Beweispflichten vor der Redaktion?
  [§ 257 Abs. 4 und 5 HGB](https://www.gesetze-im-internet.de/hgb/__257.html), [§ 66 Abs. 2 und 4 StBerG](https://www.gesetze-im-internet.de/stberg/__66.html).
- **Abrechnung.** Welcher Beleg trennt zwei selbständige elektronische
  Überlassungen, wann greift der Scan-Mindestbetrag und welche Gebühren
  bilden die Grundlage einer Postpauschale, wenn derselbe Entwurf manuell
  eingetragene RVG- oder vereinbarte Gebühren enthält? Wie dokumentiert die
  Kanzlei die Rechtsstandsauswahl für frühere Aufträge? [§ 16 StBVV](https://www.gesetze-im-internet.de/stbgebv/__16.html), [§ 17 StBVV](https://www.gesetze-im-internet.de/stbgebv/__17.html), [§ 41 StBVV](https://www.gesetze-im-internet.de/stbgebv/__41.html).
- **Wirtschaftsjahr und individuelle Termine.** Welche abweichenden
  Wirtschaftsjahre, landwirtschaftlichen Veranlagungen, Vorabanforderungen
  und Einzelverlängerungen sollen fachlich modelliert werden? Welche
  Eingaben und Nachweise müssen dafür vorliegen? Bis zur Entscheidung
  bleiben individuelle Termine in der organisatorischen Fristenkontrolle
  und Teiljahre außerhalb der BWA-Steuerschätzung. [§ 4a EStG](https://www.gesetze-im-internet.de/estg/__4a.html), [§ 7 KStG](https://www.gesetze-im-internet.de/kstg_1977/__7.html), [§ 149 AO](https://www.gesetze-im-internet.de/ao_1977/__149.html).
