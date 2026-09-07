# Wiedervorlagen als Tickets — technische Abnahme vom 7. September 2026

Ausgangsstand: `8e1a0e49402a45294e9aa8dc89ca27ea5c2b98c2` auf `main`.
Die Umsetzung folgt der bestätigten Produktidee: eigenständige Aufgaben,
dauerhafte Nummern und Zusammenhänge sowie ein lesbares Archiv. Die Prüfungen
verwenden ausschließlich lokale Dienste und synthetische Daten.

## Umsetzung

- Jede Wiedervorlage erhält eine unveränderliche Nummer innerhalb ihrer
  Kanzlei. Datenbanktrigger erfassen auch Recherchedelegation und Telefonnotizen;
  vorhandene UUID-Links bleiben gültig. Die neue Migration vergibt Nummern
  deterministisch nach Anlagezeit und ID und übernimmt eindeutige Rechercheherkunft.
- Ausdrückliche Erwähnungen wie `#123` in neuen Beschreibungen und Kommentaren
  erzeugen gerichtete, deduplizierte Verweise und Rückverweise. Der Server prüft
  aktuelle Zugriffsrechte vor Speicherung, Projektion, Zählung und Seitennavigation.
  Fremde oder nicht zugängliche Tickets werden nicht durch einen Verweis freigegeben.
- Die Oberfläche bündelt Beschreibung und Unterhaltung; Kontext und Verknüpfungen
  stehen daneben. Eine neue Aufgabe kann eigenständig verknüpft werden. Frühere
  Nachfrageketten bleiben eingeklappt lesbar. Übersicht, Kommentare und Anhänge
  haben getrennte Seitennavigation; neue Beiträge führen zur neuesten Seite.
- Archivieren verlangt Abschlusszeit, abschließende Person und die Berechtigung
  des Erstellers, Admins oder Partners. Kommentare, Zuweisungen, Ergebnisabgabe und
  Anhänge sind im Archiv gesperrt. Wiederherstellen erhält den Arbeitsabschluss;
  Wiederöffnen bleibt eine gesonderte Handlung.
- Upload prüft Berechtigung und Archivzustand vor dem Store-Write und erneut
  unter Zeilensperre beim Datenbankcommit. Ein zwischenzeitlicher Entzug wird
  abgewiesen und der Storage-Commit kompensiert. Worker beachten denselben Archivschutz.

## Fehlernachweise und Bereinigung

Gegenseitige Verweise bei zwei gleichzeitig gehaltenen `FOR UPDATE`-Sperren
reproduzierten PostgreSQL `40P01`: Die Fremdschlüsselprüfung brauchte jeweils
eine inkompatible Sperre des anderen Tickets. `FOR NO KEY UPDATE` erhält die
Serialisierung von Statusänderungen und erlaubt die Fremdschlüsselprüfung.
Der echte Gegenlauf belegt zwei erfolgreiche Commits und genau zwei Kanten.
Ein weiterer Paralleltest weist mit `pg_blocking_pids` nach, dass eine wartende
Mutation nach der Archivierung den neuen Status liest.

Die Datenbank verweigert Archivierung ohne abschließende Person sowie
Selbstverweise, tenantübergreifende Kanten und Änderungen der Ticketidentität.
Die Anwendungsrolle darf Verweise nur lesen und ergänzen. Der Nummernzähler
ist ausschließlich über die geprüfte Triggerfunktion beschreibbar.
Zehn absichtlich falsche ACL-Zustände wurden zunächst als rote Regression
reproduziert; die erweiterte Restore-Abnahme weist sie jetzt ab.

Die kompakte Mandantenübersicht sortiert offene Aufgaben ausdrücklich mit
`NULLS FIRST`, bevor sie auf 50 Einträge begrenzt. Der Filter „Von mir“ enthält
auch selbst zugewiesene Aufgaben. Fehlercodes für neue Archivaktionen und ihre
Auditbezeichnungen sind in die bestehenden Vertragsprüfungen eingebunden.
Beschreibung, Gespräch, Formulare und Kontext wurden in kleinere Komponenten
aufgeteilt; es wurde keine höhere Komplexitätsschuld freigegeben.

Zwei echte Rendererregressionen belegen außerdem, dass ein verspätet
abgeschlossener Kommentar oder Upload nach Verlassen des Tickets zur alten
Seite zurücknavigieren konnte. Die Oberfläche prüft vor Resultverarbeitung,
ob die zuständige Komponente noch aktiv ist. Ein Ticketwechsel erzwingt über
die Ticket-ID einen neuen Komponentenbaum. Beide roten Fälle und die bisherigen
13 Komponentenfälle bestehen nach der Korrektur.

## Datenbank und Migration

Die vollständige Datenbanksuite bestand mit 425 Fällen in 56 Dateien ohne
Auslassung. Ein anschließend ergänzter Konkurrenzfall erhöht die erfolgreich
ausgeführte Abdeckung auf 426 unterschiedliche Fälle; der finale Nachlauf der
Ticketdatei bestand mit 20/20. Zusätzlich bestanden sechs Tests der tatsächlichen
Produktionsloader und Referenzdienste mit der eingeschränkten PostgreSQL-App-Rolle.
Sie prüfen unter anderem tenantgebundene Nummern, Rechte vor Zählung und
Pagination, private Rückverweise, Archivschutz und 201 Kommentare auf zwei Seiten.

Ein gesondertes Upgrade führte sieben synthetische Bestandsaufgaben von 226 auf
227 Migrationen. Alle bisherigen Spalten blieben unverändert; Nummern und
Herkunftsanker wurden wie spezifiziert ergänzt. Ein echter PG18-Dump/Restore
erhielt acht Tickets, zwei Zähler und eine Referenzkante. Ein leeres Ziel wurde
akzeptiert, ein vorbereitetes Ziel mit zu weit reichenden Defaultprivilegien
trotz identischer Daten abgewiesen. 23 Restore-/CLI-Units, Migrationsledger,
RLS-Inventur und Schemaabgleich ohne Drift ergänzen den Nachweis.

## Weitere Prüfungen

| Prüfung                          | Ergebnis                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Gesamte Unit-Suiten ohne DB/E2E  | 4.101 bestandene Fälle in 13 Paketen, alle 21 Turbo-Aufgaben erfolgreich ohne Cache                     |
| Opt-in-Datenbanktests            | Die sechs neuen Ticket-Service-Fälle wurden zusätzlich mit echten DB-Verbindungen ausgeführt            |
| Komponenten im Chromium-Renderer | 15/15 Fälle einschließlich Archivschutz, Verweis-Whitelist, Seitennavigation und verspäteter Aktionen   |
| Statische Qualität               | Typecheck über 22 Aufgaben, ESLint ohne Fehler, React-Compiler-Baseline ohne Treffer                    |
| Komplexität                      | 67 statt 69 vorhandene Warnungen; Spitzenwert unverändert 53 bei Grenzwert 20                           |
| CI-Guards                        | Keine fokussierten Tests; sämtliche E2E-Specs eingebunden; Images, Actions und Paketlieferkette geprüft |

Der reale Ticketflow 23 bestand auf dem finalen Produktionsimage, ebenso drei
bestehende Health-/Mandantensuchfälle. Es gab keine automatischen Retries.
Übersicht und Detailansicht wurden zusätzlich auf Desktop und bei schmalem
Viewport visuell geprüft. Nach der regulären Sidebar-Transition bleibt der
Ticketinhalt lesbar; eine vorzeitig aufgenommene Mobileansicht wurde ersetzt.
Formatprüfung, Dokumentationslinks, `pnpm fachkatalog:check` und
`pnpm fachkatalog:diff` bestanden mit 81 aktuellen Regeln.

Der normale Unit-Lauf lässt 15 Fälle aus drei ausdrücklich aktivierbaren
Integrationsdateien aus. Sechs davon sind die separat ausgeführten neuen
Ticket-Service-Fälle; sieben ältere Mandatservice- und zwei Redis-Fälle wurden
im vorausgehenden Gesamtdurchlauf geprüft und in diesem Featurepass nicht
erneut aktiviert. Gezielte Nachläufe werden nicht zu überlappenden Unit-Fällen
addiert. Dieser Featurepass ist keine Wiederholung aller früheren 184 Browserfälle.

## Produktionsartefakte und Sicherheit

| Lokales Image                             | Finale Image-ID                                                           | SBOM-Komponenten |
| ----------------------------------------- | ------------------------------------------------------------------------- | ---------------: |
| `taxtronik/web:local-tickets-20260907`    | `sha256:b0243f4cff1ed27290ca61e2ee450483e78120d873dff8049de9c60972e5aba9` |              145 |
| `taxtronik/worker:local-tickets-20260907` | `sha256:0ec6c9228bbcb4fc46d2fdeebb9251d8e708692e3c316d9ab59b27a2792f924d` |              978 |

Beide Produktionsbuilds bestanden mit jeweils 6 GiB Speicherlimit ohne
zusätzlichen Swap. Das Webimage wurde nach der letzten UI-Korrektur erneut
gebaut und der reale Ticketablauf darauf wiederholt. Komponentenprüfungen
verwenden echte React-Renderer mit synthetischen Action-Grenzen; Fall 23 führt
Oberfläche, Server-Actions und Datenbank ohne solche Mocks zusammen.
Für die lokale Browsersuite sind die dokumentierten Test-TOTP-Bypassflags
gesetzt; die Authentifizierungsimplementierung wurde in diesem Pass nicht geändert.

Der CI-gepinnte Trivy-Scanner meldete für beide finalen Image-IDs im vollständigen
Scan einschließlich nicht behobener CVEs keine bekannten Schwachstellen aller
Schweregrade und keine Secrets. Kritische Gates bestanden; CycloneDX-1.7-SBOMs
wurden erstellt. Scanner-Datenbankstand: 6. September 2026, 13:03 UTC.
Gitleaks 8.29.0 fand im gesamten vorgemerkten Änderungsumfang keine Secrets.
Das sind zeitpunktbezogene Scannerbefunde, kein externer Pentest.

## Grenzen und Betrieb

Automatische Ticketverweise gelten für neu gespeicherte Beschreibungen und
Kommentare einschließlich freier Delegationsnotizen. Andere Freitextfelder und
historische Notizen werden nicht pauschal nach Verweisen durchsucht. Ähnlicher
Inhalt oder derselbe Mandant begründen keinen geratenen Zusammenhang.
Nicht mehr rekonstruierbare Rechercheherkunft bleibt unbekannt.

Das Ticketarchiv ist eine organisatorische Ablage, keine fachliche Freigabe und
keine unveränderliche Vollkopie sämtlicher verknüpfter Dokumente. Berechtigte
Löschung und Anonymisierung bleiben gesonderte Verfahren. Rechtliche Fristen
und Ergebnisfreigaben werden durch Archivierung nicht abgeschlossen.

Der Restore-Prüfer verlangt die Objekte des aktuellen Migrationsstands.
Backups vor `20260907013230_reminder_tickets` werden zunächst mit ihrem passenden
Softwarestand wiederhergestellt und anschließend kontrolliert migriert.
Ein abgelehntes Restore-Ziel wird nicht automatisch zurückgerollt; die Dienste
dürfen erst nach erfolgreicher Sicherheitsabnahme starten.

Regelbindung: neue Produktregel `REMINDER-TICKET-001` und ergänzte
`ACCESS-TENANT-RLS-001`. Die neue Regel bleibt fachlich `unreviewed`.
Bestehende professionelle Freigabefelder werden nicht geändert.

Rohprotokolle, Erstfehler, Nachläufe, Browserberichte und SBOMs liegen unter
`%TEMP%\kanzleikonsole-tickets-20260907`. Temporäre Konfigurationen und
Zugangsdaten gehören nicht zum Repository. Die
[Anwenderdokumentation](../anwenderdoku/wiedervorlagen.md) beschreibt die Bedienung.
