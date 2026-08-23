# Compliance-Dokumentation

Stand: 2026-08-23

Dieser Ordner enthält unterschiedliche Dokumentarten: technische
Ist-Beschreibungen, interne Arbeits- und Vorbereitungspapiere sowie Vorlagen,
die eine Kanzlei erst für ihren konkreten Betrieb ausfüllen und freigeben muss.
Ein Dokument im Repository ist weder eine Rechtsberatung noch ein Nachweis
einer unabhängigen Prüfung, Zertifizierung oder berufsrechtlichen Freigabe.

**Statusbegriffe:** „Ist-Dokumentation“ beschreibt den dokumentierten
Produktstand und muss für den betrachteten Release verifiziert werden.
„Arbeitsstand“ ist eine noch abzugleichende Analyse oder Anleitung. „Vorlage“
ist ohne Ausfüllen, organisatorische Anpassung und Freigabe kein Nachweis.

## Übersicht

| Datei                                                                      | Typ                              | Zielgruppe                             | Status und Zweck                                                                                                                                 |
| -------------------------------------------------------------------------- | -------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [auth-secret-rotation.md](./auth-secret-rotation.md)                       | Betriebsanleitung                | Betrieb, Security                      | Arbeitsstand: Rotation und bekannte Auswirkungen; vor Ausführung gegen Release und Betriebsumgebung prüfen                                       |
| [avv-template.md](./avv-template.md)                                       | Kanzleivorlage                   | Kanzleileitung, Datenschutz, Rechtsrat | Auszufüllen und rechtlich/organisatorisch anzupassen; kein abgeschlossener AVV                                                                   |
| [cookie-config.md](./cookie-config.md)                                     | Technische Ist-Dokumentation     | Entwicklung, Betrieb, Security         | Beschreibt Cookie- und Auth-Surface-Konfiguration zum angegebenen Stand; je Release gegen Code und Deployment prüfen                             |
| [dsfa-template.md](./dsfa-template.md)                                     | Kanzleivorlage                   | Verantwortliche, Datenschutz           | Auszufüllende DSFA-Arbeitshilfe; ersetzt weder die Risikobewertung noch die Freigabe der verantwortlichen Stelle                                 |
| [dsgvo-konzept.md](./dsgvo-konzept.md)                                     | Produkt- und Betriebskonzept     | Datenschutz, Betrieb, Prüfer           | Gemischte Ist-/Soll-Beschreibung zu Löschung, Aufbewahrung und Verarbeitung; offene Betreiberentscheidungen bleiben organisatorisch zu schließen |
| [eidas-tsa.md](./eidas-tsa.md)                                             | Technische Betriebsdokumentation | Betrieb, Security, Prüfer              | Konfiguration und Grenzen der RFC-3161-Zeitstempel; keine Bestätigung einer eIDAS-Vertrauensdienst- oder Signaturklasse                          |
| [gobd-template.md](./gobd-template.md)                                     | Kanzleivorlage                   | Kanzleileitung, Berufsträger, Prüfer   | Für die kanzleieigene Verfahrensdokumentation auszufüllen und fachlich freizugeben                                                               |
| [gobd.md](./gobd.md)                                                       | Technische Ist-Dokumentation     | Berufsträger, Entwicklung, Prüfer      | Technische GoBD-Verfahrensbeschreibung der Software; ergänzt, aber ersetzt nicht die kanzleieigene Verfahrensdokumentation                       |
| [gwg.md](./gwg.md)                                                         | Fachlich-technisches Mapping     | GwG-Verantwortliche, Entwicklung       | Ordnet Pflichten und Produktfunktionen ein; interne Risikoanalyse und Sicherungsmaßnahmen der Kanzlei bleiben separat erforderlich               |
| [idw-ps880-pruefungsbereitschaft.md](./idw-ps880-pruefungsbereitschaft.md) | Readiness-Arbeitsstand           | Produktverantwortliche, Prüfer         | Scope-, Gap- und Maßnahmenanalyse; keine durchgeführte Prüfung und keine Softwarebescheinigung                                                   |
| [idw-ps980-tcms.md](./idw-ps980-tcms.md)                                   | Mapping und Zielbild             | Kanzleileitung, Tax-Compliance, Prüfer | Trennt implementierten allgemeinen Workspace vom nicht implementierten Organschafts-Zielbild; keine CMS-Beschreibung oder PS-980-Prüfung         |
| [pen-test-vorbereitung.md](./pen-test-vorbereitung.md)                     | Interne Checkliste               | Security, Betrieb, externer Pentester  | Vorbereitung und Scope-Vorschlag; weder Pen-Test-Bericht noch Aussage über den aktuellen Schutzgrad                                              |
| [tenancy-model.md](./tenancy-model.md)                                     | Architektur-/Grenzendokument     | Architektur, Security, Betrieb         | Beschreibt Isolation und bekannte Betriebsgrenzen zum angegebenen Stand; vor Multi-Tenant-Betrieb neu bewerten                                   |
| [vvt-template.md](./vvt-template.md)                                       | Kanzleivorlage                   | Verantwortliche, Datenschutz           | Ausgangspunkt für ein kanzleieigenes VVT; ohne Ergänzung der tatsächlichen Verarbeitungstätigkeiten kein vollständiges Verzeichnis               |

Release- und prüfungsbezogene Nachweise werden nicht durch diesen Index
erzeugt. Dafür dienen die [Anleitung zur eingefrorenen
Prüfumgebung](../assurance/pruefumgebung.md) und die
[Release-Evidence-Vorlage](../assurance/ps880-release-evidence.md).

## Pflichten im Überblick

| Vorschrift                                     | Was wird verlangt                                                                         | Wo abgebildet                                                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **DSGVO Art. 30** (VVT)                        | Liste aller Verarbeitungstätigkeiten                                                      | siehe vvt-template.md                                                                                                                        |
| **DSGVO Art. 35** (DSFA)                       | Folgenabschätzung bei hohem Risiko                                                        | siehe dsfa-template.md                                                                                                                       |
| **DSGVO Art. 28** (AVV)                        | Auftragsverarbeitungs-Verträge                                                            | erfasst in `/staff/service-providers`                                                                                                        |
| **DSGVO Art. 15-21**                           | Betroffenenrechte                                                                         | abgewickelt in `/staff/admin/dsgvo`                                                                                                          |
| **§ 146 AO + GoBD**                            | Unveränderbarkeit der Aufzeichnungen                                                      | Hash-Chain + RFC-3161 (ADR-0004), Object-Lock (ADR-0005)                                                                                     |
| **§ 147 AO / § 14b UStG**                      | dokumentartabhängig 6/8/10 Jahre                                                          | Datei-Typ mit COMPLIANCE-Lock und expliziter Frist                                                                                           |
| **§ 10 GwG**                                   | allgemeine Sorgfaltspflichten, risikobasierte Anwendung und laufende Überwachung          | GwG-Modul mit Risikoanalyse + DB-Trigger (ADR-0007), siehe [gwg.md](./gwg.md)                                                                |
| **§§ 11, 12 GwG**                              | Angaben zur Identifizierung erheben und Identität überprüfen                              | GwG-Onboarding, Personen-/Vertreter-/UBO-Daten und Dokumentanforderungen; die Einzelfallprüfung bleibt beim Verpflichteten                   |
| **§ 8 GwG**                                    | grundsätzlich 5 Jahre, ggf. andere längere Gesetze; spätestens nach 10 Jahren Vernichtung | `gwg`-Bucket GOVERNANCE + Review-Queue `/staff/admin/gwg-retention`, siehe [gwg.md](./gwg.md)                                                |
| **DSGVO Art. 28**                              | Auftragsverarbeiter auswählen, vertraglich binden und kontrollieren                       | Kanzleivorlage [avv-template.md](./avv-template.md) und organisatorische Erfassung unter `/staff/service-providers`                          |
| **Elektronische Vollmacht / eIDAS-Prüfbedarf** | Nachweis einer elektronischen Bestätigung                                                 | Token + E-Mail-Code mit gebundenem Inhalts-Snapshot (ADR-0009); keine bestätigte Einstufung als fortgeschrittene oder qualifizierte Signatur |
| **§ 257 HGB**                                  | 6-jährige Aufbewahrung kaufmännischer Korrespondenz                                       | GoBD-Datei-Typ mit 6-Jahres-COMPLIANCE-Lock                                                                                                  |
| **§ 203 StGB**                                 | Verschwiegenheit                                                                          | RBAC, RLS, separater Auth-Flow                                                                                                               |
| **§ 26 BDSG**                                  | Mitarbeiterdaten                                                                          | Mitarbeiter-Zeit/Urlaub mit RBAC                                                                                                             |

## Vorgehen bei einer Aufsichtsbehörden-Anfrage

1. VVT auf Stand bringen (`/staff/admin/audit` für Beleg, dass System aktiv ist)
2. DSFA vorlegen, falls vorhanden
3. AVV-Liste aus `/staff/service-providers` entnehmen (Bildschirmausdruck; ein CSV-Export besteht dort noch nicht)
4. Audit-Log-CSV-Export für den angefragten Zeitraum
5. Hash-Chain-Verifikation als technischen Integritätsnachweis ausführen:
   `pnpm verify:chain` (CLI) oder `/staff/admin/audit` (UI). Der Nachweis
   erkennt nachträgliche Inkonsistenzen innerhalb seines Prüfbereichs; seine
   Grenzen sind unter
   [Known Limits, Abschnitt 8](../assurance/known-limits.md)
   dokumentiert.

## Bei einer Datenpanne (Art. 33 DSGVO)

Innerhalb 72 Stunden nach Kenntnis melden bei der zuständigen
Aufsichtsbehörde, wenn ein Risiko für betroffene Personen besteht.

Vorbereitung:

- Audit-Log-Export für den fraglichen Zeitraum
- Liste der wahrscheinlich betroffenen Mandanten/Personen
- Bereits ergriffene Gegenmaßnahmen
- Bei hohem Risiko: zusätzlich Betroffeneninformation (Art. 34)
