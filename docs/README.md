# TaxTronik-Dokumentation

Dieser Index führt nach Zielgruppe zur passenden Dokumentation. Die Dateien
sind mit der Software versioniert; maßgeblich ist der Stand des eingesetzten
Releases. Ein dokumentierter Soll-Zustand, eine Vorlage oder eine Gap-Analyse
ist nicht automatisch ein Nachweis, dass die Funktion umgesetzt, betrieblich
eingerichtet oder fachlich freigegeben ist.

## Dokumentstatus richtig lesen

| Kennzeichnung                | Bedeutung                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ist-Dokumentation**        | Beschreibt den im Repository belegten Stand. Version, Code und Tests bleiben für die konkrete Aussage maßgeblich.                            |
| **Verfahren / Runbook**      | Beschreibt einen einzuhaltenden Entwicklungs- oder Betriebsablauf; die tatsächliche Durchführung muss separat nachgewiesen werden.           |
| **Fachregel mit Prüfstatus** | Enthält Umsetzung und Nachweise; der Berufsträgerstatus wird je Regel separat geführt. Ein ungeprüfter Entwurf ist keine fachliche Freigabe. |
| **Gap-Analyse / Readiness**  | Interne Selbsteinschätzung und Maßnahmenstand, weder Prüfung noch Testat oder Bescheinigung.                                                 |
| **Vorlage**                  | Muss für die konkrete Kanzlei ausgefüllt, geprüft, freigegeben und organisatorisch gelebt werden.                                            |
| **Konzept / Zielbild**       | Beschreibt eine mögliche oder geplante Lösung; nicht als vorhandene Funktion verwenden.                                                      |
| **Historie / Archiv**        | Hält einen früheren Stand nachvollziehbar; nicht als aktuelle Anleitung verwenden.                                                           |

## Einstieg nach Zielgruppe

### Berufsträger und fachlich Verantwortliche

| Einstieg                                                                         | Typ / Status                | Wofür?                                                                                     |
| -------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------ |
| [Fachkatalog](fachkatalog/README.md)                                             | Fachregeln mit Einzelstatus | Fachlogik, [Abdeckung](fachkatalog/SCOPE.md), Grenzen sowie Code- und Testnachweise prüfen |
| [Funktionsumfang](../FEATURES.md)                                                | Ist-Inventur                | Vorhandene Funktionen und Produktgrenzen überblicken                                       |
| [Anwenderdokumentation](anwenderdoku/README.md)                                  | Ist-Dokumentation           | Fachliche Abläufe aus Sicht von Kanzlei und Mandanten nachvollziehen                       |
| [Bekannte Grenzen](assurance/known-limits.md)                                    | Ist-Abgrenzung              | Aussagen erkennen, die TaxTronik ausdrücklich nicht trifft                                 |
| [Compliance-Übersicht](compliance/README.md)                                     | Gemischter Index            | Softwaredokumente, Kanzleivorlagen und Prüfungs-Readiness unterscheiden                    |
| [IDW-PS-880-Prüfungsbereitschaft](compliance/idw-ps880-pruefungsbereitschaft.md) | Gap-Analyse / Readiness     | Softwareprüfungs-Scope, Nachweisstand und offene Maßnahmen einordnen                       |
| [IDW-PS-980-/TCMS-Einordnung](compliance/idw-ps980-tcms.md)                      | Ist-Mapping plus Zielbild   | Werkzeugunterstützung vom organisatorischen TCMS und nicht umgesetzten Zielbild trennen    |

### Kanzleianwender und Administratoren

| Einstieg                                                       | Typ / Status      | Wofür?                                                               |
| -------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------- |
| [Erste Schritte](anwenderdoku/erste-schritte.md)               | Anwenderanleitung | Erstlogin, Kanzleieinrichtung und grundlegende Arbeitsschritte       |
| [Anwenderhandbuch](anwenderdoku/README.md)                     | Kapitelindex      | Dokumente, Rechnungen, Workflows, Fristen, BWA, Administration, TCMS |
| [n8n-Automatisierungen](anwenderdoku/n8n-automatisierungen.md) | Anwenderanleitung | Geführtes Setup, eigene Workflows und Fehlerdiagnose                 |
| [Bekannte Grenzen](assurance/known-limits.md)                  | Ist-Abgrenzung    | Fachliche, technische und organisatorische Grenzen berücksichtigen   |

### Betreiber

| Einstieg                                               | Typ / Status        | Wofür?                                                   |
| ------------------------------------------------------ | ------------------- | -------------------------------------------------------- |
| [Projekt-README](../README.md)                         | Einstieg / Ist-Doku | Voraussetzungen, Entwicklung und Operator-CLI            |
| [Erstinstallation](operations/initial-deploy.md)       | Runbook             | Unterstützten Installationsweg vorbereiten und ausführen |
| [Day-2 Operations](operations/day-2-operations.md)     | Runbook             | Überwachung, Fehlerdiagnose und Routinebetrieb           |
| [Release und Update](operations/release.md)            | Runbook             | Versionierte Images, Freigabe, Update und Rollback       |
| [Disaster Recovery](operations/disaster-recovery.md)   | Runbook             | Backup-Vertrag, Wiederherstellung und Restore-Drill      |
| [Secret-Rotation](operations/secret-rotation.md)       | Runbook             | Betriebliche Secrets kontrolliert wechseln               |
| [Subdomain-Trennung](operations/subdomain-trennung.md) | Runbook             | Staff-, Portal- und n8n-Domains sicher trennen           |
| [Lizenzschlüssel-Verifikation](operations/lizenz.md)   | Betriebsdoku        | Lizenzprüfung und Ausfallverhalten einordnen             |

Ergänzend dokumentiert das
[Release-Rehearsal](operations/release-rehearsal.md) die Probe des
Release-Wegs. Die tatsächliche Durchführung ist jeweils separat zu belegen.

### Entwickler und übernehmende Personen

| Einstieg                                                      | Typ / Status           | Wofür?                                                                      |
| ------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| [Aktuelle Übergabe und Einarbeitung](HANDOFF.md)              | Einstieg / Checkliste  | Repository übernehmen, Leitplanken und Mindestprüfungen erfassen            |
| [`AGENTS.md`](../AGENTS.md)                                   | Arbeitsregel           | Verbindliche Regeln für Änderungen an fachlicher Logik                      |
| [Architektur](architecture.md)                                | Ist-Dokumentation      | Komponenten, Datenflüsse und Sicherheitsgrenzen verstehen                   |
| [Architecture Decision Records](adr/README.md)                | Entscheidungsregister  | Architekturentscheidungen und ihren Status nachvollziehen                   |
| [Entwicklungsverfahren](development/entwicklungsverfahren.md) | Verfahren              | Änderung, Review, CI und Freigabe durchführen                               |
| [Test- und Abnahmekonzept](development/testkonzept.md)        | Verfahren / Soll       | Teststufen, Scope, Nachweise und bekannte Abdeckungslücken einordnen        |
| [Barrierefreiheit](assurance/barrierefreiheit.md)             | Ist-/Gap-Dokumentation | WCAG-2.2-AA-Ziel, technische Gates, manuellen Prüfumfang und Grenzen prüfen |
| [Technische Modulbeschreibungen](development/module/)         | Ist-Dokumentation      | Zugriffsschutz, Archiv, Fakturierung, Audit und Backup im Detail prüfen     |
| [Workspace-Injektion](development/workspace-injection.md)     | Entwicklerhinweis      | Veraltete pnpm-Workspace-Kopien erkennen und beheben                        |

Die [ERiC-Integrationsregeln](development/eric-integration.md) enthalten
verbindliche Umgangsregeln und Architekturvorgaben, aber keine Behauptung über
eine vollständig ausgelieferte Integration. Das
[Posteingangskonzept](development/posteingang-konzept.md) ist ausdrücklich ein
nicht umgesetztes Zielbild. Der
[Optimierungsbericht vom 16.07.2026](development/optimierungsbericht-2026-07-16.md)
ist ein zeitgebundener Reviewstand und keine aktuelle Mängelliste.

### Prüfer, Datenschutz und Informationssicherheit

| Einstieg                                                                         | Typ / Status            | Wofür?                                                                            |
| -------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| [IDW-PS-880-Prüfungsbereitschaft](compliance/idw-ps880-pruefungsbereitschaft.md) | Gap-Analyse / Readiness | Scope, Entwicklungsverfahren, Programmdokumentation und Nachweise                 |
| [Entwicklungsverfahren](development/entwicklungsverfahren.md)                    | Verfahrensbeschreibung  | Rollen, Wartung, Tests, Freigabe und Versionsführung                              |
| [Test- und Abnahmekonzept](development/testkonzept.md)                           | Verfahren / Soll        | Testumfang, Umgebungen, Nachweise und explizite Lücken                            |
| [Technische Modulbeschreibungen](development/module/)                            | Ist-Dokumentation       | Kontrollen und Implementierung der prüfungsnahen Kernmodule                       |
| [Assurance-Modell](assurance/assurance-model.md)                                 | Ist-/Kontrollmodell     | Vertrauensannahmen, Kontrollschichten und Release-Gates                           |
| [Threat Model](assurance/threat-model.md)                                        | Bedrohungsmodell        | Schutzgüter, Angreifer, Grenzen und Gegenmaßnahmen                                |
| [Bekannte Grenzen](assurance/known-limits.md)                                    | Ist-Abgrenzung          | Nicht zugesagte Eigenschaften und verbleibende Betreiberverantwortung             |
| [Barrierefreiheit](assurance/barrierefreiheit.md)                                | Ist-/Gap-Dokumentation  | Umgesetzte A11Y-Schichten, automatisierte Nachweise und offene manuelle Prüfungen |
| [Prüfumgebung](assurance/pruefumgebung.md)                                       | auszufüllende Vorlage   | Release, Host, Konfiguration, Seed und Testfälle für einen Prüfauftrag einfrieren |
| [Release-Evidence](assurance/ps880-release-evidence.md)                          | auszufüllende Vorlage   | Digests, CI-Berichte, SBOMs, Security-Befunde, Abweichungen und Freigaben binden  |
| [Compliance-Dokumentation](compliance/README.md)                                 | Gemischter Index        | DSGVO, GoBD, GwG, eIDAS, Tenancy sowie anpassbare Vorlagen                        |
| [Pen-Test-Vorbereitung](compliance/pen-test-vorbereitung.md)                     | Prüfvoraussetzung       | Scope und organisatorische Vorbereitung eines externen Tests                      |
| [Security Policy](../SECURITY.md)                                                | Verfahren               | Unterstützte Versionen und vertraulicher Meldeweg                                 |

## Struktur des Dokumentationsbestands

| Pfad                             | Inhalt und Dokumentart                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`anwenderdoku/`](anwenderdoku/) | Versioniertes Benutzerhandbuch; Kapitelindex in [`README.md`](anwenderdoku/README.md)                          |
| [`fachkatalog/`](fachkatalog/)   | Maschinen- und menschenlesbarer Fachregelkatalog mit Regelstatus, Beitragsverfahren und Änderungsdokumentation |
| [`compliance/`](compliance/)     | Gemischter Bestand aus technischer Ist-Doku, Readiness-Analysen und ausdrücklich bezeichneten Kanzleivorlagen  |
| [`operations/`](operations/)     | Betriebsrunbooks für Installation, Release, Routinebetrieb, Secrets und Wiederherstellung                      |
| [`development/`](development/)   | Entwicklungs-/Testverfahren, technische Modulbeschreibungen, Entwicklerhinweise und klar bezeichnete Konzepte  |
| [`adr/`](adr/)                   | Statusgeführte Architekturentscheidungen                                                                       |
| [`assurance/`](assurance/)       | Bedrohungs-, Kontroll- und Grenzmodell sowie ausdrücklich auszufüllende Prüfvorlagen                           |
| [`archive/`](archive/)           | Historische Unterlagen ohne Geltung als aktuelle Anleitung                                                     |

Übergreifend gelten der [aktuelle Funktionsumfang](../FEATURES.md), die
[Architektur](architecture.md) und die [Release-Historie](../CHANGELOG.md).
Bei Widersprüchen zwischen Fachkatalog, Code, Test und Dokumentation darf keine
Quelle stillschweigend bevorzugt werden; der Konflikt ist offenzulegen und von
der zuständigen Person zu klären.
