# Ausbauintegration – 31. August 2026

Dieser Arbeitsstand erweitert den übernommenen GwG-/Steuerstammdatenstand
`599c969c`. Der dort während paralleler Entwicklung aufgetretene Katalogkonflikt
wird nicht durch eine neue fachliche Freigabe übergangen: neue Regeln bleiben
`unreviewed`, bestehende Freigabefelder werden nicht ergänzt. Die abschließenden
Katalogprüfungen beziehen sich auf den zusammengeführten Arbeitsstand.

Alle neuen Module sind standardmäßig deaktiviert. Die normalen Workflow-,
Anforderungs-, Benachrichtigungs- und Archivwege bleiben erhalten. Neue
Formularvorgänge binden Fragenfassungen; bei Bestandsvorgängen mit fehlendem
Snapshot wird kein historischer Stand erfunden.

| Paket                                 | Fachregel               | Technische Dokumentation                            |
| ------------------------------------- | ----------------------- | --------------------------------------------------- |
| Wiki im Bearbeitungskontext           | KNOWLEDGE-CONTEXT-001   | [Workflow-Ausbau](module/workflow-expansion.md)     |
| Jahreswechsel/Inventur                | YEAR-END-CAMPAIGN-001   | [Workflow-Ausbau](module/workflow-expansion.md)     |
| Bescheidrückmeldung                   | TAX-NOTICE-DECISION-001 | [Workflow-Ausbau](module/workflow-expansion.md)     |
| Smart-Mailbox                         | MAIL-INBOX-001          | [Mailbox](module/smart-mailbox.md)                  |
| Personalaufnahme                      | PAYROLL-INTAKE-001      | [Personalaufnahme](module/payroll-intake.md)        |
| Bewirtung und Eigenbeleg              | CLIENT-ASSISTANCE-001   | [Mandantenassistenten](module/client-assistance.md) |
| Verfahrensdokumentation               | CLIENT-ASSISTANCE-001   | [Mandantenassistenten](module/client-assistance.md) |
| Feedback                              | CLIENT-FEEDBACK-001     | [Workflow-Ausbau](module/workflow-expansion.md)     |
| Beteiligungseditor                    | MANDATE-STRUCTURE-001   | [Mandatsausbau](module/mandate-expansion.md)        |
| Workflow-Abhängigkeiten               | WORKFLOW-DEPENDENCY-001 | [Mandatsausbau](module/mandate-expansion.md)        |
| Offboarding                           | CLIENT-OFFBOARDING-001  | [Mandatsausbau](module/mandate-expansion.md)        |
| VDB-Vorbereitung                      | VDB-PREPARATION-001     | [Mandatsausbau](module/mandate-expansion.md)        |
| EU-Screening und manuelle PEP-Prüfung | GWG-SCREENING-001       | [Screening](module/screening.md)                    |
| StBVV-Honorarvorschläge               | STBVV-CALCULATION-001   | [StBVV](module/stbvv.md)                            |

Gemeinsame Regeln sind unter anderem FORM-SCHEMA-SNAPSHOT-001,
ACCESS-TENANT-RLS-001, ACCESS-STAFF-PERMISSION-001,
DOC-PORTAL-SHARING-001 und DSGVO-OPERATIONAL-RETENTION-001.

## Einführung und verbleibende Abnahmen

1. Additive Migrationen zunächst auf einer isolierten Kopie prüfen; kein
   automatisches Aktivieren von Modulen. Worker und Web gemeinsam aktualisieren.
2. Rechte, Mandantenabgrenzung, Widerruf und Session-Sperren mit synthetischen
   Arbeitgeber-, Arbeitnehmer- und Kanzleizugängen abnehmen.
3. DATEV-LuG- und VDB-Dateien bleiben gesperrt, bis die exakte Formatfassung,
   unterstützte Felder und ein tatsächlicher Import mit synthetischen Daten
   nachgewiesen sind. PDF-/Datenvorbereitung ist keine Schnittstellenabnahme.
4. M365 einschließlich freigegebenem Postfach, Token-Erneuerung und Widerruf
   mit einer eigenen Entra-App der Pilotkanzlei prüfen. Keine Abschaltung von
   Sicherheitsrichtlinien und kein Basic-Auth-Fallback.
5. Lange PDF-/DOCX-Ausgaben visuell abnehmen. Menschliche Freigabe bleibt
   dokumentierter Bestandteil der Verfahrensdokumentation; ein Generator
   bestätigt weder tatsächliche Durchführung noch GoBD-Konformität.
   Zehn PDF-Seiten einschließlich internationaler Namen wurden visuell geprüft.
   Die DOCX-Dateien wurden strukturell geprüft; eine visuelle Word-/LibreOffice-
   Prüfung fehlt, weil hier kein LibreOffice verfügbar ist. Bei extern
   bearbeiteten Word-Dateien ist die neue Originaldatei maßgeblich; das begleitende
   PDF ist ausdrücklich ein Prüfprotokoll und keine behauptete Word-Konvertierung.
6. StBVV-Referenzrechnungen und Tatbestandsabdeckung unabhängig fachlich prüfen.
   Screening-Kandidaten und PEP-Recherche bleiben menschliche Entscheidungen.
7. Für neue personenbezogene Datenklassen vor breiter Nutzung Löschzwecke und
   Aufbewahrung organisatorisch festlegen. Sie werden nicht still der
   vorhandenen Löschung allgemeiner Anforderungsdaten unterstellt. Auch die
   bestehende allgemeine Mandanten-Anonymisierung deckt die neuen privaten
   Datenklassen nicht vollständig ab. Kein Modul darf daraus eine vollständige
   Löschung oder rechtliche Aufbewahrungsfreigabe ableiten.

Mandatsende schließt keine Fristen und löscht keine Dokumente. Herausgabe
erfordert eigene Empfänger- und Versionsauswahl; allgemeine Portalfreigabe
ersetzt sie nicht. Geschützte Lohnarchive sind im allgemeinen Portal unsichtbar.
Die Mailbox erlaubt keine automatische Ablage interner/GwG-/Personalunterlagen
über allgemeine Dokumenttypen; solche Unterlagen benötigen den dafür
vorgesehenen Fachzugang. Ursprungsmails bleiben unverändert.

## Technische Prüfung vor der Dev-Bereitstellung

Abschließender lokaler Prüfstand mit synthetischen Daten:

| Prüfung                        | Ergebnis                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Webtests                       | 2.553 bestanden; sieben separat ausgeführte DB-Tests im normalen Lauf ausgenommen                                                            |
| Worker / Mail / Tax            | 186 / 40 / 184 Tests bestanden                                                                                                               |
| PostgreSQL-Integration         | 39 Tests in sieben DB-Dateien plus sieben echte Mandats-Service-Tests bestanden                                                              |
| Browser                        | Vier Tests bestanden: Downloadschutz, zwölf Oberflächen, Arbeitnehmerwiderruf, Jahresbindung                                                 |
| Migrationen                    | Alle 205 Migrationen auf isolierter Testdatenbank angewendet; kein Schema-Drift                                                              |
| RLS                            | Alle 132 vorgesehenen Tabellen mit ENABLE, FORCE und Policy geprüft                                                                          |
| Typen / ESLint                 | Typprüfungen bestanden; ESLint ohne Fehler, 24 Warnungen                                                                                     |
| Fachkatalog                    | 77 Regeln gültig; 32 Validator-Tests bestanden; 110 Fachpfadänderungen zugeordnet                                                            |
| Dokumentationslinks            | Prüfung und vier Regressionstests bestanden                                                                                                  |
| Produktionspaket               | Build und 34 statische Seiten erfolgreich; 675 Trace-Dateien geprüft                                                                         |
| PDF-Prüfer im Produktionspaket | Echter isolierter Prüflauf: normale PDF lesbar, verschlüsselte PDF gesperrt; 173 Parserdateien ohne Rückgriff auf Entwicklungsabhängigkeiten |
| Schriftdateien                 | Vier eingebettete Schriftdateien und zwei Lizenztexte im Produktionspaket geprüft                                                            |

Die Tests wurden nicht gegen die laufende Kanzleidatenbank ausgeführt. Neue
Fachregeln bleiben ungeprüfte Entwürfe; technische Tests sind keine fachliche
Freigabe durch einen Berufsträger.

Unit-, Datenbank- und Strukturtests prüfen unter anderem doppelte Starts,
unveränderliche Fassungen, Tenant- und Fachrechte, gesperrte Dateitypen,
Scannerfehler, IMAP-Wiederaufnahme und Rechenfälle. Migrationen und RLS werden
in einer eigens angelegten Testdatenbank geprüft; die laufende Anwendungsdatenbank
wird dafür nicht migriert. Diese Tests ersetzen keine der oben genannten
externen oder fachlichen Abnahmen.

Die Browserprüfung verwendet einen getrennten Server auf Port 3100 und eine
synthetische Datenbank. Sie prüft anonyme Downloadverbote, zwölf Moduloberflächen,
die eingeschränkte Arbeitnehmer-Session samt Widerruf sowie eine tatsächlich
gespeicherte Workflow-Abhängigkeit nach ausdrücklicher Jahresbestätigung. Der
bereits laufende Entwicklungsserver auf Port 3000 bleibt unverändert.

## Anschließende Bereitstellung im bestehenden Dev

Am 31. August 2026 hat der Benutzer ausdrücklich die Aktivierung im bestehenden
lokalen Dev zum Handtest beauftragt. Die vorstehende isolierte Prüfung wurde
nicht auf der laufenden Datenbank wiederholt. Anschließend wurde jedoch die
lokale Datenbank `taxtronik` gesichert und über den normalen Deploymentpfad von
181 auf 205 Migrationen aktualisiert. Die neuen Modulflags wurden nur für die
Musterkanzlei aktiviert; Produktdefaults bleiben deaktiviert. Bestehende Zugänge,
Berufsträgerkennzeichnungen und der Rechnungsmodus `EXTERNAL` blieben erhalten.

- Datenbanksicherung: `backups/dev-before-expansion-20260831-050634.dump` mit
  SHA-256-Begleitdatei; Archivverzeichnis durch `pg_restore --list` geprüft.
- Prisma-Client neu erzeugt; alle 132 RLS-Tabellen geprüft. Der lesende Vergleich
  zwischen laufender Datenbank und Prisma-Schema meldete keinen Unterschied.
  Der separate Reset-basierte Shadow-Datenbankcheck wurde nicht ausgeführt,
  nachdem dessen Reset-Sicherheitsprüfung eine ausdrückliche Bestätigung
  verlangte. Die dafür angelegte leere Shadow-Datenbank wurde nicht gelöscht.
- Web auf Port 3000 und Worker neu gestartet; die ursprünglichen Pausenzustände
  aller 24 Jobqueues wiederhergestellt. Ein alter fehlgeschlagener
  `dsgvo-retention`-Lauf von vor der Migration bleibt sichtbar: Damals fehlte
  `client_interaction`. Er wurde weder entfernt noch durch einen eigens
  ausgelösten Löschlauf ersetzt; die Tabelle ist inzwischen vorhanden.
- Vier ausdrücklich synthetische Testmandate und vorbereitete Wiki-, Formular-,
  Kampagnen-, Workflow- und Personalvorgänge angelegt. Die dabei verwendeten
  Dev-GwG-Metadaten sind keine herunterladbaren Nachweisdateien und keine
  fachliche Freigabe. Bestehende Mandate wurden nicht zurückgesetzt.
- Lokales GreenMail-Testpostfach nur auf Loopback, IMAPS 3993 und Test-SMTP 3025.
  TLS-Zertifikat geprüft, zusätzliche lokale CA ausschließlich in den gestarteten
  Node-Prozessen. Die normale App-Mailzustellung bleibt im Mailhog auf Port 1025.
  Zwei PDF-Anhänge wurden durch den echten Worker als sauber geprüft, eine
  Textdatei blieb gesperrt. Wiederholter Abruf erzeugte keine weiteren Nachrichten;
  alle drei Originale blieben im Postfach ohne Gelesen-Markierung erhalten.
- Eine PDF ausdrücklich als GoBD-Rechnung für TEST Ausbau GmbH archiviert.
  Kanzleidownload mit identischem Originalhash geprüft; keine Portalfreigabe.
  Der gesperrte Mailanhang liefert 404, der anonyme Download 401.
- Offiziellen EU-Listenbestand über die geschützte Bedienaktion abgerufen und
  lokal validiert. Keine Mandantennamen an einen externen Matchingdienst gesendet.
- 16 Einstiegsseiten auf Port 3000 einschließlich mandantenbezogenem Screening
  und StBVV ohne Schreibaktionen geprüft: HTTP 200, passende Überschriften und
  keine Browserfehler.
- 18 Portalchecks mit getrennten A1-/A2-Sessions bestanden: echte Anmeldung über
  lokale Loginmail, Jahrescheckliste, Anforderung, Lohnfreigabe nur für A1,
  interne Wiki-Abgrenzung und 404 beim nicht freigegebenen Archivbeleg. Nur die
  Anmeldung schrieb Sitzungsdaten; keine fachlichen Bestätigungen vorgenommen.
  Zunächst aufgezeichnete React-Dev-Hydrationswarnungen wurden auf das vorzeitige
  Verbergen des Schreibcursors durch Playwright-Screenshots zurückgeführt.
  Wiederholung ohne diese DOM-Manipulation: Personal- und Formularansicht ohne
  Konsolen-/Hydrationsfehler. Dafür wurde eine bereits vorhandene unverbrauchte
  Loginmail regulär bestätigt, kein neuer Link angefordert oder Limit umgangen.
- Fachkatalog erneut geprüft: 77 gültige Regeln, 32 Validator-Tests und das
  Diff-Gate für 110 Fachpfadänderungen bestanden. Keine fachlichen Freigaben
  durch das Setup ergänzt.

Die [Handtestanleitung](expansion-dev-test.md) enthält Einstiege, Testkontakte
und erwartete Sperren. DATEV-LuG-/VDB-Importabnahmen, M365-Tenantfreigabe und
fachliche Freigaben sind damit weiterhin nicht ersetzt.
