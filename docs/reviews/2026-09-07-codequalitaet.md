# Lokale Prüfung auf Bugs und Codequalität vom 7. September 2026

Ausgangsstand: `c2d38ca67e5a6540aaf8566ff968046d1f1ed9cd` auf `main`.
Diese Runde ergänzt die vorherigen Sicherheits- und Volltests um konkrete
Anzeige-, Auswahl- und Parserfehler sowie die Zerlegung dreier großer Funktionen.
Alle Laufzeittests verwenden lokale, synthetische Daten.

## Markdown: Stillstand, Textverfälschung und HTML-Kontexte

Eine Zeile wie `| Text` ohne Tabellentrenner ließ den Parser endlos auf derselben
Zeile stehen. Absatzende und Blockauswahl verwenden jetzt dieselbe Erkennung.
Code, Tabellen, Listen und Absätze haben getrennte Leser mit fortschreitendem
Cursor.

Inline-Code wurde anschließend erneut als Markdown interpretiert. Auch
Formatierungszeichen in Linkzielen veränderten URLs. Vorhersehbare interne
Platzhalter kollidierten zudem mit tatsächlichen privaten Unicode-Zeichen.
Die Inline-Verarbeitung liest nun Tokens aus dem Quelltext und verarbeitet
erzeugtes HTML nicht erneut. Code wird als Text escaped, Linkziele werden als
URL-Daten geprüft und Bildbeschriftungen ausschließlich als Attributtext escaped.
Die bestehenden Einschränkungen für Bildpfade, Linkprotokolle und Editor-Stile
bleiben erhalten.

Die unabhängige Gegenprüfung fand zwei weitere Laufzeitprobleme: wiederholte
unvollständige Linkanfänge und ein ungültiger Tabellentrenner mit sehr vielen
Leerzeichen verursachten stark wachsende Sucharbeit. Schon 10.000 Leerzeichen
erreichten vor der Korrektur das Prozess-Zeitlimit von 2,5 Sekunden. Die
überlappenden Suchmuster sind beseitigt. Die zwölf abschließenden Proben,
darunter Eingaben mit 100.000 Zeichen, benötigten lokal 0–4 Millisekunden reine
Renderzeit. Das ist ein Nachweis für diese Fälle, keine allgemeine Komplexitätsgarantie.

Vier anfängliche Regressionen waren vor der Korrektur rot. Der finale gezielte
Markdown-Lauf besteht mit 35 Fällen in vier Dateien. Die dauerhafte
Timeout-Regression führt acht große Eingaben in einem eigenen Prozess aus,
damit ein blockierter JavaScript-Thread den Testlauf nicht festhält.
20 zusätzliche DOM-Angriffsfälle im echten Chromium zeigten keine ausführbaren
Tags, Eventattribute oder externen Bildziele.

Der Renderer bleibt eine begrenzte Markdown-Grammatik. Gleichartig verschachtelte
Editor-Stile und verschachtelte Link-/Bildklammern sind nicht vollständig
unterstützt; es wird keine CommonMark-Kompatibilität zugesagt.

## Gemeinsame Such- und Formularelemente

Beim Wechsel zwischen zwei längeren Suchbegriffen blieben die alten Treffer
während Debounce und Netzwerkabruf auswählbar. Im Browser öffnete Enter den
Datensatz des vorherigen Suchbegriffs. Alte Datensatztreffer werden jetzt bei
jeder Queryänderung geleert; passende Navigationsbefehle bleiben verfügbar.

Ein deaktivierter Datumswähler deaktivierte nur sein sichtbares Feld. Sein
versteckter Wert landete weiter in `FormData`. Beide Eingaben teilen jetzt den
Deaktivierungszustand. Vier neue Regressionen waren vorher rot; anschließend
bestehen alle 13 gezielten Komponentenfälle. Ein isolierter Chromium-Lauf mit
den echten React-Komponenten bestätigt beide Korrekturen einschließlich
Tastaturnavigation und tatsächlichem `FormData`.

## Audit: Kanzleizähler und verständliche Seitenstruktur

Die ungefilterte Audit-Seite verwendete `pg_class.reltuples` für die gesamte
Datenbanktabelle. Im Reproduktionsfall wurden für zwei eigene Ereignisse
ungefähr 1.300 angezeigt. PostgreSQL-Katalogstatistiken werden nicht durch den
Tenantkontext auf die eigene Kanzlei begrenzt. Liste, Ressourcenauswahl und
exakter Count tragen nun eine explizite Tenantbedingung. Der Count übernimmt
Filter, aber keinen Seiten-Cursor.

Die Seitendatei umfasst jetzt 78 statt 751 Zeilen. Datenzugriff, Filterzustand,
Eintragstabelle, Prüfer-Link und Statuskarten sind getrennte Bausteine.
Die zentrale Rollenprüfung läuft weiterhin zuerst; Hash-, Anker-, Recovery-
und Exportentscheidungen bleiben erhalten. 39 gezielte Tests bestehen,
einschließlich echter Seitenrenderings, BigInt-Pagination und negativer Statusfälle.
Regeln: `AUDIT-HASH-CHAIN-001`, `AUDIT-VERIFY-ALERT-001`,
`ACCESS-TENANT-RLS-001`. Die rein technischen Verschiebungen sind zusätzlich
unter `FK-EXC-20260907-002` nachvollzogen.

Der vorhandene Tenant-Index unterstützt den Count. Ein exakter Count bleibt
bei großen eigenen Audit-Beständen aufwendiger als eine globale Schätzung;
eine Produktionslastmessung ist damit nicht ersetzt.

## Timeline: aktuelle Folgeereignisse und konsistente Anzeige

Die Begrenzung nach Anlagedatum blendete aktuelle Folgeereignisse älterer
Vorgänge aus, etwa eine heute bezahlte alte Rechnung bei vielen jüngeren
Entwürfen. Jede gespeicherte Ereigniszeit liefert jetzt eine eigene begrenzte
Kandidatenmenge. Die Projektion berücksichtigt die strikte Zeitgrenze erneut,
entfernt doppelt geladene Datensätze und ordnet Gleichstände eindeutig.
Lesen, Ereignisprojektion und Zusammenführung sind getrennt.

Die Seite gruppiert Ereignisse jetzt durchgehend nach Berliner Kalendertagen.
Ungültige oder gebrochene Limits gelangen nicht mehr ungeprüft zur Datenbank.
An der Obergrenze von 500 Ereignissen entfällt der wirkungslose Nachladelink.
Vorher scheiterten alle 17 Aggregator-Regressionen und sechs von sieben
Seitenfällen; danach bestehen 28 Fälle einschließlich Vertraulichkeitsprüfung.

Die Auswahl benötigt 18 begrenzte Quellenabfragen statt elf auf derselben
Tenant-Transaktionsverbindung. Zusätzliche Zeitindizes oder ein großer
Produktions-Ausführungsplan wurden nicht eingeführt beziehungsweise gemessen.
`before` bleibt eine strikte Datumsgrenze und kein verlustfreier Cursor über
Zeitgleichstände. Die UI verwendet ein wachsendes Limit. Gespeicherte Fachzustände
und Nachweise ändern sich nicht. GwG-Ablehnungen verwenden mangels eigenem
Ablehnungsdatum weiterhin das Anlagedatum als Näherung. Details und Regel-IDs:
[Timeline-Modul](../development/module/timeline.md).

## Gemeinsame Prüfnachweise

- Vollständige Unit-Suite ohne Cache: **3881 bestanden**, neun bewusst
  ausgelassene DB-/Redis-Opt-ins, kein Fehler. 13 Testpakete und 21 erfolgreiche
  Turbo-Tasks. Das sind netto 64 zusätzliche Fälle gegenüber dem Ausgangsstand;
  gezielte Teilprüfungen werden nicht nochmals addiert.
- SHA-256-Abgleich: Alle 26 geänderten Quell-/Testdateien blieben während
  Gesamtprüfung und Buildvorbereitung unverändert.
- Vollständiger Typecheck und ESLint erfolgreich. Bestehende
  Komplexitätswarnungen von **75 auf 72** reduziert: Audit-Seite zuvor 67,
  Timeline-Aggregator 53, Markdown-Renderer 47. Alle neuen Funktionen liegen
  unter dem bestehenden Grenzwert 20; keine Warnung wurde unterdrückt.
  Die Baseline entfernt ausschließlich diese drei nachgewiesenen Verbesserungen.
- React- und Komplexitätsbaseline erfolgreich. Fachkatalog: 80 aktuelle Regeln,
  33 Katalogtests und zwölf konkret zugeordnete Fachpfadänderungen.
  Die fachlichen Reviewfelder aller Regeln sind unverändert.
- Vollständige Formatprüfung und Dokumentationslinkprüfung erfolgreich.
- Gitleaks 8.29.0 prüfte die vollständigen zum Commit vorgemerkten Änderungen
  mit der Repository-Konfiguration und fand keine Secrets.
- Neuer Web-Produktionsbuild beim ersten Versuch erfolgreich, mit 6 GiB
  Speicher und ohne Swap. Image:
  `sha256:6d0972532ad0e142f743118712d478f8433ae327504dbcfd32f2ba585a419769`.
  Trivy prüfte genau dieses Image: kein bekannter Schwachstellenbefund aller
  Schweregrade, keine Secrets, Critical-Gate erfolgreich. CycloneDX-SBOM mit
  145 Komponenten. Der CI-gepinnte Scanner kennt Alpine 3.24 weiterhin nicht
  in seiner EOL-Liste; die OS-Schwachstellenprüfung gegen Repository 3.24 lief.
- Drei Chromium-Fälle am lokalen HTTPS-Produktionsserver bestanden ohne
  Retry oder Skip, einschließlich vorheriger echter TOTP-Einrichtung und
  Anmeldung bei ausgeschalteten TOTP-Testausnahmen. Der Audit-Zähler von
  228 wurde gegen PostgreSQL geprüft, ebenso 50er-Pagination, vollständige
  Hashes und der tatsächlich persistierte Status. Der gefilterte CSV-Download
  lieferte 60 Zeilen und genau einen Export-Auditeintrag. Ein ungültiger
  Export lieferte HTTP 400 ohne weiteren Schreibzugriff. Die Timeline zeigte
  32 bestehende synthetische Ereignisse und behandelte `NaN`, `20.9` und `500`
  korrekt. Es wurde keine Rechnung durch direkte DB-Manipulation als bezahlt
  markiert; der betreffende Auswahlfall ist durch die Aggregator-Regression belegt.
- Das ausschließlich hierfür angelegte Testkonto wurde deaktiviert, seine
  Authrevision erhöht, sein Passwort unbekannt rotiert und TOTP-/Recoverydaten
  entfernt. Die drei eigenen Auditaktionen für Enrollment, Login und Export
  bleiben erhalten. Browser und DB-Verbindungen sind geschlossen; alle eigenen
  Testdienste wurden gestoppt. Bestehende Live-Dienste wurden nicht verändert.

Der erste Compose-Wartecheck meldete den temporären HTTPS-Proxy fälschlich als
ungesund: Er hatte aus seinem Basisimage den Check für Web-Port 3000 geerbt,
während er auf 3443 lauscht. Die Anwendung antwortete und alle Browserfälle
bestanden. Anschließend wurde ausschließlich die temporäre Testkonfiguration
auf einen HTTPS-Check des Proxyports korrigiert und erfolgreich geprüft.

Rohprotokolle liegen unter `%TEMP%\kanzleikonsole-quality-20260907`, insbesondere
`markdown-before.log`, `markdown-review-benchmark-final.json`,
`markdown-dom-review.json`, `shared-browser-before.json`,
`shared-browser-after.json`, `audit-count-red.log`, `timeline-results.md`,
`unit.log`, `summary-static.json`, `complexity-improvements.json`,
`web-build-result.json`, `web-trivy-result.json` und `browser-smoke/evidence.json`.
Die simulierten Persistenztests sind keine erneute vollständige
RLS-/Migrationsprüfung oder Lastmessung. Es gab keine Schemaänderung.
