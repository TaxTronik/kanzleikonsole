# Zweite lokale Sicherheitsprüfung vom 6. September 2026

Ausgangsstand: `dc6f32fdcc65265535cb2d3c70a3fc86666c5cda` auf `main`.
Beginn am 6. September, abschließende Prüfungen am 7. September 2026.
Auftrag: weiterer Sicherheitsscan mit Korrektur bestätigter Fehler. Die Prüfung
erfolgte ausschließlich lokal mit synthetischen Daten. Vorhandene Live-Dienste
und deren Daten wurden nicht verändert. Der zuvor abgeschlossene
[Volltest](2026-09-06-volltest.md) bleibt ein separater Nachweis seines damaligen
Arbeitsstands.

## Bestätigte und korrigierte Befunde

| Bereich              | Reproduktion und Auswirkung                                                                                                                                                                                                                             | Korrektur und Nachweis                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portal-Profilwechsel | Ein Wechsel konnte den Anmeldezeitpunkt erneuern und damit einen älteren Widerruf umgehen. Nach dem Wechsel fehlte die Bindung an den ursprünglichen Kontakt. Eine zwischenzeitlich geänderte E-Mail konnte außerdem in die Profilauflösung einfließen. | Frische Mailboxanmeldung setzt den ursprünglichen Kontaktanker. Wechsel bewahren Anker und Zeitpunkt; aktuelle und ursprüngliche Identität werden einschließlich Mandatsstatus und Widerruf geprüft. Die Profilauflösung verwendet die verifizierte Sitzungs-E-Mail. Abmeldung widerruft den ursprünglichen Kontakt. Fünf Angriffsszenarien scheiterten vor der Korrektur und bestehen danach. |
| Redis-Widerrufe      | Ein verspäteter Schreibvorgang mit älterem Zeitstempel konnte einen neueren Widerruf überschreiben und zwischenzeitlich ausgegebene Cookies wieder gültig machen.                                                                                       | Atomarer Lua-Vergleich hält den Zeitstempel monoton und erneuert die TTL. Ungültige gespeicherte Werte führen zur Sperre; nur ein tatsächlich fehlender Schlüssel bedeutet keinen Widerruf. Zwei Regressionen wurden zunächst rot und anschließend grün gegen einen eigenen Redis-8-Container ausgeführt.                                                                                      |
| Kalenderlinks        | Ein bereits ausgegebener iCal-Link blieb nach Änderung der Kontakt-Mailbox gültig; Deaktivierung mit späterer Reaktivierung konnte den alten Link erneut freischalten.                                                                                  | `icalTokenVersion` wird mit E-Mail-Änderung, Deaktivierung und Reaktivierung durch Einladungswege atomar erhöht. Alte Links liefern 404; kosmetische Änderungen lassen gültige Links bestehen. Sechs neue Verhaltenstests, insgesamt 33 Kontakt-/Feed-Fälle grün.                                                                                                                              |
| Dokument-ZIPs        | Die Auswahl `beleg.pdf`, `beleg.pdf`, `beleg_1.pdf` erzeugte zwei gleichnamige Archiveinträge. Beim Entpacken konnte eine Datei die andere überschreiben.                                                                                               | Alle bereits vergebenen vollständigen Eintragsnamen werden nach Unicode-Normalisierung und ohne Beachtung der Groß-/Kleinschreibung reserviert; Suffixe werden bis zu einem freien Namen hochgezählt. Fünf vorher rote Kollisionsfälle, anschließend 15 Download-/ZIP-Fälle grün. Dokumentbytes und gespeicherte Namen bleiben erhalten.                                                       |
| HTTP-Antwortströme   | Die Antwort wurde unabhängig vom Verbrauch vollständig gepuffert. Abbruch erreichte den bereits gesperrten Reader nicht. Größenlimits eines aufrufenden Moduls begrenzten daher nicht zuverlässig das vorgelagerte Puffern.                             | Bedarfsgesteuertes Lesen, Weitergabe von Abbruch und Timeout an den Reader sowie einmaliges Schließen des Agents. Vier neue Regressionen, drei davon vor der Korrektur rot; 146 Pakettests grün. Zwei zusätzliche Versuche gegen einen echten lokalen HTTP-Server bestätigten das Schließen der Verbindung bei Reader-Abbruch und AbortSignal.                                                 |
| Update-Signaturabruf | Die 4-KiB-Prüfung erfolgte erst nach vollständigem Lesen und Entfernen von Leerzeichen. Eine zu große Antwort ohne verlässliches Content-Length konnte Speicher verbrauchen oder nach dem Trimmen akzeptiert werden.                                    | Empfangene Bytes werden vor Dekodierung und Trimmen begrenzt; bei Überschreitung wird der Strom abgebrochen. Auch früh abgewiesene HTTP-Antworten werden geschlossen. Neun neue Fälle, sieben davon vor der Korrektur rot; alle 24 Manifesttests grün, einschließlich exakt 4096 Bytes.                                                                                                        |

Die Portaländerung erfordert nach der Installation eine einmalige neue
Portal-Anmeldung. Alte Cookies ohne ursprünglichen Kontaktanker werden
abgewiesen: Bei bereits gewechselten Profilen lässt sich die ursprüngliche
Mailboxanmeldung nicht zuverlässig rekonstruieren. Staff-Cookies benötigen
diesen zusätzlichen Portalanker nicht.

Die betroffenen Regeln `ACCESS-TENANT-RLS-001`,
`AUDIT-RFC3161-ANCHOR-001` und `ASSURANCE-RELEASE-EVIDENCE-001` enthalten
Umsetzung und Testnachweise. Die rein technische ZIP-Korrektur ist als
`FK-EXC-20260906-003` dokumentiert. Es wurden keine Rechtsquellen oder
fachlichen Freigaben ergänzt.

## Erneute Prüfungen

- Vollständiger Unit-Lauf ohne Cache: **3790 bestanden**, kein Fehler,
  13 Testpakete und 21 frisch ausgeführte Turbo-Tasks. Neun ausdrücklich
  ausgenommene Opt-in-Fälle: sieben Mandats-DB-Fälle und die zwei separat
  ausgeführten Redis-Integrationen. Die acht OpenSSL-Differenztests sind in
  den 3790 bereits enthalten.
- Gezielte Auth-/Login-/Logout-Prüfung: 267 bestanden; zwei Redis-Opt-ins in
  diesem Lauf ausgelassen und getrennt tatsächlich ausgeführt. Diese
  Auth-Fälle sind im vollständigen Unit-Lauf enthalten und werden nicht
  zusätzlich zur Gesamtsumme gezählt.
- Beide pnpm-Abhängigkeitsaudits: keine bekannten Schwachstellen gemeldet.
- Gitleaks 8.29.0: 611 Commits und anschließend vollständige aktuelle
  Änderungsdateien ohne Treffer. Acht Gegenproben der Allowlist bestanden.
- Fokus-Test-, Dependency-/Lockfile- und CI-Action-/Image-Pin-Guards bestanden.
- Typecheck: alle 22 Tasks frisch bestanden. ESLint: kein Fehler und
  unverändert 75 bekannte Complexity-Warnungen; beide Warnungsbaselines grün.
- Fachkatalog: 80 Regeln gültig, 33 Katalogregressionen bestanden und alle
  13 geänderten Fachpfade konkret zugeordnet. Die `professional_review`-Felder
  aller 80 Regeln sind gegenüber dem Ausgangscommit unverändert.
- Dokumentationsprüfung: vier Regressionen und sämtliche geprüften Links
  bestanden.
- Fertige Web- und Worker-Images: Trivy mit dem CI-gepinnten Scanner,
  `vuln,secret`, regulärem CI-Gate und zusätzlichem Vollscan ohne
  `ignore-unfixed`: jeweils **keine bekannten Schwachstellen aller
  Schweregrade und keine Secrets** gemeldet. Gescannt wurden genau die neu
  gebauten Image-IDs. CycloneDX-SBOMs enthalten 145 Web- und 978
  Worker-Komponenten. Die Scanner-Datenbank stammt vom 6. September,
  13:03 UTC; ihr nächster Updatezeitpunkt lag nach diesen Prüfungen.

Der gepinnte Trivy-Scanner 0.71 kennt Alpine 3.24 des Web-Images noch nicht in
seiner EOL-Liste. Das ist eine Grenze seiner Lebenszyklusbewertung;
die OS-Schwachstellenprüfung gegen Repository 3.24 wurde ausgeführt.
Die vollständigen Ergebnisse stehen in `images-security-summary.json`,
`web-trivy-result.json`, `worker-trivy-result.json` und den zugehörigen
Vollberichten. Die SBOMs heißen `web.cdx.json` und `worker.cdx.json`.

Der erste Web-Dockerbuild brach nach erfolgreicher Kompilierung und Typprüfung
bei der Seitendatensammlung mit `SIGSEGV` ab. Der Wiederholungslauf bei gleichem
Produktcode und gleichem 6-GiB-Limit bestand vollständig. Für den einmaligen
nativen Absturz liegt keine bestätigte Ursache vor; beide Buildprotokolle
bleiben erhalten. Das Runtime-Image wurde mit frischer Runner-Stage erzeugt.

Das Worker-Produktionsimage wurde ebenfalls erfolgreich mit frischer
Runner-Stage und 6-GiB-Limit gebaut. Die anschließende Probe ohne Netzwerk
bestätigte UID 1000, lesbare und schreibgeschützte Migrationen, vorhandenes
`pg_restore`, fehlende Paketmanager/`.env` sowie den exakten Quellhash des
geänderten HTTP-Moduls. Der Workerprozess selbst wurde in diesem Nachlauf
nicht erneut gegen Queues gestartet; dafür gilt der gesonderte frühere
Volltestnachweis.

## Neue Portalprüfung im Browser

Ein zusätzlicher umfassender Chromium-Fall bestand ohne Retry am gebauten
Produktionsserver mit PostgreSQL, Redis, lokalem HTTPS und MailHog:

1. Echte Mailboxanmeldung mit zwei eigenen Kontakten und Profilwahl; A→B→A
   einschließlich Auth.js-Erneuerungen bewahrt Ursprung und Anmeldezeitpunkt.
2. Ein tatsächlich ausgegebenes und zuvor gültiges B-Cookie liefert nach
   regulärer Abmeldung aus A bei erneuter Verwendung eine Weiterleitung zur
   Anmeldung und eine leere Session.
3. Zweite echte Mailboxanmeldung, B→A, anschließend nur Ursprung B deaktiviert:
   Auch die abgeleitete Sitzung wird gesperrt, obwohl Zielkontakt A aktiv ist.

Im ersten Aufbauversuch hatte der Test vor der zweiten Anmeldung das reguläre
Limit von einer Mail pro Minute nicht abgewartet. Die erste Sicherheitsphase
war bereits grün. Nach Ergänzung der Wartezeit bestand der gesamte Fall in
67,7 Sekunden; Rate-Limits wurden für diesen Fall nicht verändert oder
gelöscht. Alle vier eigens angelegten Kontakte aus beiden Versuchen wurden
anschließend deaktiviert und unabhängig per Datenbankabfrage nachgeprüft.
Die Belege liegen unter
`%TEMP%\kanzleikonsole-volltest-20260906\security2\portal-browser`, einschließlich
`RESULTS.md`, `results.json`, `evidence.json` und
`cleanup-independent-verification.json`.

Anschließend bestanden **17 vorhandene Portal-/Session-Browserfälle** ohne
Retry in 54 Sekunden: Portal-Anmeldung und Seiten, Staff-/Portal-Abmeldung,
Cookie-Eigenschaften und geschützte Routen sowie die Portal-Compliance-Gruppe.
Zusammen mit der neuen Sicherheitsprobe sind das 18 bestandene Browserfälle
in diesem Nachlauf. Die vorhandenen Helfer verwenden den abgesicherten lokalen
CI-Testmodus und setzen ausschließlich den eigenen Test-Redis zurück;
Staff-TOTP wurde im vorangegangenen Volltest separat mit aktivierter Prüfung
getestet. Alle eigenen Testdienste wurden nach Abschluss wieder gestoppt.

## Lokale Nachweise und Grenzen

Aktuelle Rohprotokolle und maschinenlesbare Ergebnisse liegen unter
`%TEMP%\kanzleikonsole-security2-20260906`, insbesondere `unit-evidence.json`,
`unit.log`, `scanner-summary.json` und `http-live.log`. Die frühen
Vorher-/Nachher-Protokolle einzelner Kontakt-, ZIP- und Auth-Reproduktionen
liegen unter `%TEMP%\kanzleikonsole-volltest-20260906` mit dem Präfix
`security-`. Zugangsdaten und temporäre Schlüssel gehören nicht zum Bericht
oder Repository.

Diese Prüfung kombiniert gezielte Codeprüfung, reproduzierte Angriffspfade,
Regressionstests und automatisierte Secret-/Abhängigkeitsscans. Sie ist kein
externer Penetrationstest und kein Nachweis einer vollständig fehlerfreien
oder fachlich freigegebenen Software. Produktive Domain-/TLS-/Proxy- und
VPS-Konfigurationen wurden in diesem Nachlauf nicht getestet.
