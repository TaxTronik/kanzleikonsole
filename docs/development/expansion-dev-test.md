# Lokaler Handtest der 14 Erweiterungen

Stand: 31. August 2026. Nur synthetische Daten und ausdrücklich dafür bestimmte
Testmandate verwenden. Die Anleitung beschreibt Bedienproben, keine fachliche
Freigabe. DATEV-LuG und VDB bleiben ohne echte Schnittstellenabnahme gesperrt.

**Eingerichteter Dev-Stand:** Die lokale Datenbank ist auf alle 205 Migrationen
gebracht, alle 14 Erweiterungsmodule sind aktiviert und Web läuft auf
`http://localhost:3000`. Der bestehende Adminzugang wurde nicht geändert.
Der Rechnungsmodus bleibt **EXTERNAL**: StBVV-Kalkulationen und ihre Nachweise
können getestet werden, eine Übernahme in interne Rechnungsentwürfe ist in
dieser Konfiguration nicht verfügbar. Diese Vorbereitung ist kein vollständiger
Testfallbestand für sämtliche Positiv-, Negativ- und Ausnahmefälle.

## Einstieg und Vorbereitung

- Standard-Dev: [Kanzleianmeldung](http://localhost:3000/staff/login),
  [Portalanmeldung](http://localhost:3000/portal/login), lokaler
  [Mailhog](http://localhost:8025). Bestehende lokale Zugänge verwenden; keine
  Zugangsdaten oder persönlichen Einladungslinks in Testprotokolle kopieren.
- Migrationen und Modulfreischaltung sind für diesen Dev-Lauf erledigt.
  Im [Einstellungsbereich](http://localhost:3000/staff/admin/settings) lässt sich
  die Konfiguration nachsehen. Ein fehlendes
  Menü oder eine gesperrte Direktadresse kann an Modul oder Berechtigung liegen.
  Für den vollständigen Durchlauf ADMIN/PARTNER verwenden; Lohnbearbeitung,
  Mailbox und Rechnungsübernahme benötigen außerdem die jeweiligen Rechte.
- Der normale Seed `packages/db/seeds/dev.ts` beschreibt die **Musterkanzlei
  GmbH**, den aktiven Testmandanten **Mustermann GmbH** mit DATEV-Nummer **10001**,
  den Kontakt **Max Mustermann** und die Anforderung **Belege Q3 2025**. Das ist
  eine Beschreibung des Seeds, keine Zusage zum Inhalt der laufenden Datenbank.
  Er legt keine vollständigen Testvorgänge für die 14 neuen Pakete an. Den Seed
  für diese Handtests nicht erneut ausführen: Er verändert vorhandene Demoobjekte.
- Angelegt sind **TEST Ausbau GmbH** als Mandat **A**,
  **TEST Ausbau Beteiligung GmbH** als Mandat **B**, **TEST Ausbau Privat GmbH**
  für Zugriffstests und **TEST Ausbau Offboarding GmbH** ausschließlich für
  Paket 11. Bereits bereitgestellte Testobjekte verwenden. **A1** ist
  `ausbau.lohn@example.test` mit ausdrücklich erteiltem Arbeitgeberzugriff auf
  den vorbereiteten Personalvorgang. **A2** ist `ausbau.portal@example.test`,
  ein aktiver Portalkontakt **ohne Lohnfreigabe**. Über die Portalanmeldung
  einen Magic-Link anfordern und im lokalen Mailhog auf Port 8025 öffnen.
  Portal und Arbeitnehmerzugang in getrennten Browserprofilen testen.
  Die synthetischen Kontakte erhalten keine automatischen Benachrichtigungen;
  dies ist von einem ausdrücklich angeforderten Loginlink zu unterscheiden.
- Kleine, ausschließlich synthetische Dateien bereitlegen: `Original.pdf`,
  `Korrektur.pdf`, ein PNG sowie eine DOCX. Originale für Belegassistenten zuerst
  im Dokumentbereich des richtigen Mandats hochladen, einen erfolgreichen Scan
  abwarten und bei Portaltests ausdrücklich freigeben. Keine Lohn- oder
  GwG-Unterlagen über allgemeine Formular-/Belegwege verwenden.

Die vorbereiteten **GwG-Dokumente sind ausschließlich Datenbank-Metadaten**;
zu ihnen gibt es keine herunterladbaren Objektdateien. Sie sind keine echten
Nachweise und eignen sich nicht für Download-/PDF-/ZIP-Proben. Dafür die oben
genannten synthetischen Dateien regulär hochladen.

Ein echtes synthetisches PDF liegt bereits in A unter Dokumente:
**synthetischer-testbeleg.pdf**, aus dem Testpostfach ausdrücklich als
GoBD-Rechnung abgelegt. Es ist nicht im Portal freigegeben. Der zweite saubere
PDF-Anhang bleibt im Eingangskorb zur eigenen Zuordnungsprobe; die Textdatei
bleibt gesperrt. Lokal liegt eine identische Upload-Vorlage unter
`.codex-run/synthetischer-testbeleg.pdf`. Abruf, Scan, wiederholter Abruf ohne
Duplikate und unveränderte Prüfsumme beim Archivdownload wurden geprüft.

Bereits vorbereitet:

- Interner veröffentlichter Wikiartikel **TEST Ausbau – Interne Testanleitung**;
  jeweils der erste Schritt der beiden Testworkflows ist damit verknüpft.
- Formularvorlage **TEST Ausbau Jahreswechsel 2026** mit Pflichttext
  „Änderungen“, Pflichtbestätigung „nur Testdaten“ und optionaler Datei.
  Kampagne **TEST Ausbau Jahreswechsel**, Jahr 2026, hat bereits einen offenen
  Anforderungsvorgang mit noch nicht ausgefülltem Formular für A.
- **TEST Ausbau A – Jahresabschluss 2026** und
  **TEST Ausbau B – Beteiligungswerte 2026**, jeweils mit zwei offenen manuellen
  Schritten und bestätigtem Jahr 2026. Für den unten beschriebenen Negativtest
  „Jahr unbestätigt“ zusätzliche Testworkflows anlegen; die vorbereiteten
  Jahreszuordnungen dafür nicht umschreiben.
- Personalentwurf **TEST Ausbau – Synthetische Neueinstellung** für A mit
  Arbeitgeberfreigabe für A1. Diesen öffnen, statt zwingend einen zweiten
  Vorgang anzulegen. Ein Arbeitnehmerlink entsteht erst auf ausdrückliche Aktion.
- Lokales TLS-IMAP-Profil **Lokaler Testeingang** auf Port **3993**. Für die
  erste Mailboxprobe dieses Profil verwenden; ein eigenes externes Postfach ist
  dafür nicht nötig. M365 bleibt ein gesonderter Test mit eigener Entra-App.

Die Tabelle beschreibt auch Anlage- und Negativproben. Für einen schnellen
ersten Durchlauf die vorbereiteten Objekte verwenden. Weitere Vorlagen lassen
sich unter [Wissen](http://localhost:3000/staff/knowledge),
[Formulare](http://localhost:3000/staff/forms),
[Workflowvorlagen](http://localhost:3000/staff/workflows/templates) und
[Anforderungsvorlagen](http://localhost:3000/staff/admin/request-templates)
ergänzen.

## Die 14 Bedienproben

| Nr. / Modul                                       | Einstieg                                                                                                                                     | Testdaten und erwarteter Ablauf                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · Wiki im Kontext                               | [Kanzleileitfäden](http://localhost:3000/staff/knowledge/context)                                                                            | Veröffentlichten Artikel mit einem Vorlagenschritt oder einer Anforderungsvorlage verknüpfen. **Danach einen neuen Vorgang starten**: Der Leitfaden erscheint im Kanzleikontext. Im Mandantenportal darf der interne Inhalt nicht auftauchen. Bereits laufende Vorgänge erhalten die neue Zuordnung nicht rückwirkend.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2 · Jahreswechsel / Inventur                      | [Jahreswechsel](http://localhost:3000/staff/year-end), danach [Portalformulare](http://localhost:3000/portal/forms)                          | Kampagne „TEST Inventur 2026“ mit aktivem Formular und zukünftigem Zieltermin einfrieren; A ausdrücklich auswählen und bereitstellen. Vorlage nachträglich ändern: Der bereitgestellte Fragenstand bleibt gleich. Im Portal teilweise ausfüllen, Datei hochladen und abgeben. Kanzlei: Fortschritt, eingereicht und Prüfung getrennt prüfen, dann Rückfrage veröffentlichen. Im Portal korrigieren und Datei ersetzen: Alter Antwortstand, Abgabezeit und alte Dateiversion bleiben unter den Einreichungsständen erhalten. Wiederholtes Bereitstellen derselben Kampagne darf keinen zweiten Vorgang für A erzeugen.                                                                                                                                                                          |
| 3 · Bescheidentscheidung                          | [Mandantenentscheidungen](http://localhost:3000/staff/interactions), [Portalrückmeldungen](http://localhost:3000/portal/interactions)        | In der Mandantenakte einen synthetischen **geprüften** Bescheid mit geklärtem Fristvorschlag und sauberem, freigegebenem Dokument vorbereiten. Kontakt A1 wählen, Erläuterung und zukünftigen Antworttermin spätestens am Fristende setzen. A1 kann die gebundene Fassung lesen und antworten; A2 darf diese persönliche Anfrage nicht beantworten. Kanzleiprüfung der Antwort erledigt keine steuerliche Frist und legt keinen Einspruch ein.                                                                                                                                                                                                                                                                                                                                                 |
| 4 · Smart-Mailbox                                 | [Mailbox](http://localhost:3000/staff/mailbox)                                                                                               | Eigenes TLS-IMAP-Testpostfach oder M365-Testpostfach verbinden. M365 benötigt eine passende Entra-App und deren konfigurierte Rücksprungadresse; Mailhog allein ist kein IMAP-Postfach. Eine Testmail mit kleiner PDF abrufen lassen, Mandat und Dokumenttyp ausdrücklich bestätigen und ablegen. Erneuter Abruf darf kein Duplikat erzeugen; das Originalpostfach bleibt unverändert. ZIP oder verschlüsselte PDF als Negativfall verwenden. Keine automatische Portalfreigabe erwarten.                                                                                                                                                                                                                                                                                                      |
| 5 · Personalaufnahme                              | [Kanzlei Personal](http://localhost:3000/staff/payroll), [Arbeitgeberportal](http://localhost:3000/portal/payroll), eigener Arbeitnehmerlink | Einzelvorgang für A mit ausdrücklich berechtigtem Arbeitgeberkontakt und zukünftigem Zugriffsende anlegen. Arbeitgeber erfasst Tätigkeit, Beginn, z. B. 40 Wochenstunden und 3.000 EUR Monatsbrutto und bestätigt selbst. Arbeitnehmerlink in einem separaten privaten Profil öffnen, synthetische Personendaten ergänzen und bestätigen; Steuer-ID/SV bei einem fiktiven noch nicht registrierten Fall ausdrücklich „nicht vergeben“ wählen. Alle übrigen Pflichtfelder einschließlich einer lokalen Test-IBAN ausfüllen. Kleine Anlage hochladen, dann Kanzleiprüfung und PDF/ZIP testen. Neuer Arbeitnehmerlink muss die alte Session sperren. Arbeitnehmer sieht keine Arbeitgebervergütung und erhält keinen allgemeinen Portalzugang. **DATEV-Gate muss gesperrt bleiben**, siehe unten. |
| 6 · Bewirtung und Eigenbeleg                      | [Kanzlei-Assistenten](http://localhost:3000/staff/client-assistance), [Portal-Assistenten](http://localhost:3000/portal/client-assistance)   | A wählen. Bewirtung: sauberen Originalbeleg auswählen, Tag, Ort, Gastgeber, Teilnehmer, konkreten Anlass und z. B. 120 EUR plus 10 EUR Trinkgeld erfassen. Einreichen, prüfen, Ergänzungs-PDF und optional kombinierte Ansicht erzeugen; Original separat erhalten. Danach „Eigenbeleg“ mit Datum, Empfänger, 25 EUR, Verwendungszweck, fehlendem Fremdbeleg und Ersteller testen. Rückgabe/Korrektur erzeugt nachvollziehbare Fassungen. Keine automatische Buchung oder steuerliche Anerkennung erwarten.                                                                                                                                                                                                                                                                                    |
| 7 · Verfahrensdokumentation                       | Dieselben [Kanzlei-Assistenten](http://localhost:3000/staff/client-assistance), Auswahl „Verfahrensdokumentation des Mandanten“              | Gültigkeitsbeginn, Verantwortlichkeiten und ein synthetisches Verfahren für Belegeingang, Scan, Ablage, Zugriff und Sicherung beschreiben; offene Punkte ausdrücklich benennen. Einreichen, prüfen und PDF/DOCX ablegen. DOCX extern ändern, neu hochladen und ausdrücklich als neue Fassung auswählen: alte Prüfung darf nicht fortgelten. Word-Ausgabe entspricht dann der gebundenen Word-Datei; das begleitende PDF ist ein Prüfprotokoll, keine Word-Konvertierung. Nicht mit der installationsbezogenen Kanzlei-IST-Dokumentation verwechseln.                                                                                                                                                                                                                                           |
| 8 · Feedback                                      | [Feedback einrichten](http://localhost:3000/staff/interactions), [Portalrückmeldungen](http://localhost:3000/portal/interactions)            | Für einen Testworkflow und A1 Feedback vormerken, dann dessen letzten Schritt abschließen; alternativ einen bereits abgeschlossenen Workflow auswählen. Im Portal einmal 1–2 Sterne und einen kurzen Testkommentar abgeben. Hinweis beim zuständigen Bearbeiter sowie Durchschnitt und Rücklauf im Monatsverlauf prüfen. Zweite Einladung zum selben Meilenstein bzw. innerhalb 90 Tagen muss ausbleiben/abgewiesen werden. Weitere Positivläufe mit anderem Testmandat testen, keine Zeitstempel manipulieren. Keine Mahnungen erwarten.                                                                                                                                                                                                                                                      |
| 9 · Beteiligungsstruktur / gemeinsamer Visualizer | [Struktur](http://localhost:3000/staff/mandate-expansion/structure)                                                                          | A, B und eine synthetische externe Person ausdrücklich einfügen; direkte Kapital- und Stimmrechtskanten getrennt erfassen, Positionen ändern, speichern und Versions-PDF ablegen. Neue Version anlegen und alte Fassung erneut öffnen. Optional eine konkrete Strukturversion als Arbeitsgrundlage einer offenen GwG-Prüfung übernehmen. Es dürfen keine indirekten Quoten oder wirtschaftlich Berechtigten automatisch entstehen. Mit fehlendem Zugriff auf B darf keine Teilstruktur mit dessen Daten ausgegeben werden.                                                                                                                                                                                                                                                                     |
| 10 · Mandatsübergreifende Abhängigkeit            | [Abhängigkeiten](http://localhost:3000/staff/mandate-expansion/dependencies)                                                                 | Je einen Workflow-Schritt von A/B verwenden. Zunächst ohne Jahresbestätigung verbinden: erwartete Sperre. Dann bei beiden ausdrücklich 2026 bestätigen und A → B verbinden. Nach Abschluss von A erscheint B bereit; Wiederöffnung von A nimmt die Bereitschaft zurück und erzeugt den vorgesehenen Hinweis. B → A als Zyklus muss scheitern. Die Anzeige erledigt keine Aufgabe oder Frist und ist keine allgemeine harte Bearbeitungssperre.                                                                                                                                                                                                                                                                                                                                                 |
| 11 · Mandatsübergabe / Offboarding                | [Übergabe](http://localhost:3000/staff/mandate-expansion/offboarding)                                                                        | **Nur TEST Ausbau Offboarding GmbH verwenden; zuletzt testen.** Eindeutigen Testempfänger, Enddatum, Vermerk und Aufbewahrungsprüfung erfassen; konkrete Dokumentfassungen einzeln auswählen. Sensible Fassungen benötigen zusätzliche Freigabe. Prüfprotokoll und alle ZIP-Teile ablegen, dann den weiterhin aktuellen Stand separat abschließen. Danach müssen Portal-/Arbeitnehmerzugriffe des beendeten Testmandats scheitern. Offene Fristen bleiben offen, Dokumente werden nicht pauschal gelöscht. Archive werden weder automatisch versandt noch allgemein im Portal geteilt.                                                                                                                                                                                                         |
| 12 · VDB-Vorbereitung                             | [VDB-Nachweise](http://localhost:3000/staff/mandate-expansion/vdb)                                                                           | In A eine Testvollmacht aus dem bestehenden Vollmachtsbereich verwenden. Vorbereitung mit Vermerk speichern. Einen nur lokal simulierten externen Folgezustand mit Datum, ausdrücklich synthetischer Referenz und sauberer Nachweisdatei protokollieren. Verlauf muss erhalten bleiben und darf den technischen Vollmachtsstatus nicht als echte Behördenbestätigung ersetzen. **VDB-Importexport bleibt deaktiviert**; keine Meldung an DATEV/Finanzverwaltung wird ausgeführt.                                                                                                                                                                                                                                                                                                               |
| 13 · EU-Screening und manuelle PEP-Prüfung        | [Quelle](http://localhost:3000/staff/admin/screening), in der Mandantenakte „Screening“ (`/staff/clients/<id>/screening`)                    | Zunächst offiziellen EU-Bestand laden; Stand, Abrufzeit und Hash prüfen. Einen eindeutig synthetischen Namen untersuchen und das Ergebnis als Namensabgleich lesen. PEP-Recherche separat mit Umfang, Quelle und begründetem Testergebnis dokumentieren. Für den GwG-Freigabepfad zuerst die konkrete GwG-Fassung einreichen und danach **deren gebundene Ziele** bearbeiten; freie Einzeltests erfüllen die Freigabesperre nicht. Ein fehlender/veralteter Quellenabruf oder ungeklärter Kandidat soll sperren, nicht automatisch freigeben.                                                                                                                                                                                                                                                  |
| 14 · StBVV-Honorarvorschläge                      | [StBVV-Katalog](http://localhost:3000/staff/stbvv), gespeicherte Nachweise unter `/staff/clients/<id>/stbvv`                                 | A wählen, Übergangsrecht ausdrücklich prüfen und z. B. eine EÜR-Position mit 50.000 EUR Wertgrundlage und zulässigem Satz erfassen. Rechenspur, Auslagen/USt und JSON prüfen; speichern. Nur bei Rechnungsmodus IN_APP und passendem Recht als neuen Rechnungsentwurf übernehmen: Wiederholung darf keinen zweiten Entwurf erzeugen. **Nicht versenden.** RVG-Fälle außer der engen Dokumentenpauschale benötigen externe Berechnung und Begründung.                                                                                                                                                                                                                                                                                                                                           |

## Erwartete Grenzen und Fehlermeldungen

- **DATEV Lohn und Gehalt:** Mitarbeiterneuanlage ist das vorgesehene Ziel.
  Bestätigte Berater-, Mandanten- und Personalnummer allein geben den Export
  nicht frei. Installierte Feldspezifikation und ein dokumentierter echter
  Probeimport fehlen; es entsteht absichtlich keine angeblich importfähige
  ASCII-/CSV-Datei. PDF/ZIP sind interne Prüfexporte, keine DATEV-Importdateien.
- **VDB:** Vorbereitungs-/Nachweisverwaltung ist bedienbar, XML-/CSV-Export,
  direkte Meldung und automatisierte Behördenabfrage sind nicht implementiert.
  Keine echte Übermittlung oder Bestätigung aus einem Teststatus ableiten.
- **Dateien:** Ohne verfügbaren Scanner, versionierten Storage oder ausreichende
  Freigabe kann die Ausgabe scheitern. Das ist kein Grund, Prüfungen zu umgehen.
  Wiederaufnahme-Schaltflächen für unvollständige Uploads nutzen. Eine fehlende
  alte Formularfassung sperrt die Rückgabe, statt die heutige Vorlage als alte
  Abgabe zu behaupten.
- **Test-IBAN:** Für den ausschließlich lokalen Personaltest kann
  `DE36 0000 0000 0000 0000 00` verwendet werden. Sie ist synthetisch, erfüllt die
  hier implementierte Prüfziffernprüfung und bezeichnet keine zu verwendende
  Bankverbindung. Niemals für Überweisungen oder externe Importproben verwenden.
- **Rollenprobe:** Nach dem ADMIN-Durchlauf mit einem Mitarbeiter ohne Lohn- bzw.
  Mailboxrecht und mit dem zweiten Portalkontakt wiederholen. Kein vertraulicher
  Inhalt darf über Direktlinks oder allgemeine Dokumentlisten erreichbar werden.

## Startkonvention und Rückmeldung

Die bestehende Dev-Umgebung verwenden, keinen zweiten Stack oder Server auf
demselben Port starten. Laut Repository laufen Web und Worker getrennt über
`pnpm --filter @taxtronik/web dev` bzw.
`pnpm --filter @taxtronik/worker dev`; `pnpm dev` bündelt die Dev-Skripte.
Mailboxabrufe und geplante Folgeläufe benötigen den Worker. Das Setup-Skript
erzeugt Infrastruktur, Secrets und Seed-Daten und ist **kein Neustartknopf für
diese bereits eingerichtete Umgebung**.

Für genau die hier eingerichtete lokale Testumgebung gibt es den ignorierten
Starthelfer `.codex-run/start-dev-expansion.ps1`. Aus dem Repository-Verzeichnis
mit PowerShell 7.4 oder neuer aufrufen:

```powershell
pwsh -NoProfile -File .codex-run/start-dev-expansion.ps1
```

Er verwendet vorhandene, verifizierte Prozesse weiter und startet nur fehlende
Dienste. Er beendet keine Prozesse und ändert weder Datenbank noch Jobqueues.
Mit zusätzlichem `-CheckOnly` prüft er ausschließlich. Die Wiederverwendung der
laufenden Dienste wurde geprüft. Der Helfer bindet beim Start die lokale
Test-CA ein; ohne sie scheitert ein gewöhnlich neu gestarteter Worker sicher an
der TLS-Prüfung des Testpostfachs. Die lokale CA läuft am 30. September 2026 ab.
Details stehen in `.codex-run/local-imap/README.md`. Diese Helfer und Testdateien
sind lokale, ignorierte Artefakte und keine Produktionskonfiguration.

GreenMail hält Nachrichten nur im Arbeitsspeicher. Ein Neustart verliert diesen
Testbestand und ändert die Ordnerkennung; das bisherige Mailboxprofil pausiert
dann absichtlich. Für einen neuen Testbestand ein neues Profil zum kontrollierten
Abgleich anlegen; alte Cursor oder Nachweise nicht zurücksetzen.

Die automatisierten Portalproben haben am 31. August morgens fünf Loginmails
angefordert. Neue Linkanforderungen vom selben lokalen Zugang sind nach Ablauf
des regulären Limits ab etwa **05:41 Uhr Europe/Berlin** wieder möglich.
Benutzte Testlinks sind verbraucht; für eigene Tests immer einen neuen anfordern.
Passwörter, Limits und Sicherheitsprüfungen wurden nicht verändert.

Bei einem Fehler festhalten: Modul, Route, Testmandatsname, Rolle, konkrete
Schritte, erwartetes/tatsächliches Ergebnis und Zeitpunkt. Keine Passwörter,
Cookies, Arbeitnehmerlinks, Postfach-Secrets oder echten Personaldaten anhängen.
Technische Details und weitere Abnahmegrenzen stehen in der
[Ausbauintegration](expansion-integration.md).
