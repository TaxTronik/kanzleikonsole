# Anwenderdokumentation TaxTronik

Benutzerhandbuch für Kanzlei-Mitarbeiter, Administratoren und (in den
jeweiligen Schlusskapiteln) Mandanten. Die Dokumentation ist mit der
Software versioniert: Maßgeblich ist immer der Stand der installierten
Version (Administration → „Installiert"); Änderungen an dokumentierten
Funktionen aktualisieren das betroffene Kapitel im selben Commit
(Doku-Pflicht, siehe
[Entwicklungsverfahren](../development/entwicklungsverfahren.md)).

## Kapitel

| Kapitel                                                          | Inhalt                                                                                                                             | Zielgruppe                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| [Erste Schritte](erste-schritte.md)                              | Inbetriebnahme in 30 Minuten: Erstlogin/2FA, geführte Checkliste, Team + Berechtigungen, erste Arbeitsschritte                     | Admin/Partner                   |
| [Dokumente und Archiv](dokumente.md)                             | Explorer, Upload/Virenscan, Schutzstufen/Aufbewahrung, Versionen, Freigabe, GwG-Vernichtung, Portal-Sicht                          | Mitarbeiter, Admin, Mandant     |
| [Rechnungen](rechnungen.md)                                      | In-App-/Extern-Modus, automatische Nummernvergabe, Festschreibung, E-Rechnung (XRechnung/ZUGFeRD), Stundenabrechnung, Portal-Sicht | Mitarbeiter, Admin, Mandant     |
| [n8n-Automatisierungen](n8n-automatisierungen.md)                | Geführtes Setup, workflow-spezifische Ziele, eigene Workflows, Eventkatalog, Datenschutz und Fehlerdiagnose                        | Admin, Workflow-Verantwortliche |
| [Administration](administration.md)                              | Benutzer/Rollen/2FA, Prüfprotokoll & Zeitstempel, Backup & Restore-Test, Verweise                                                  | Admin/Partner                   |
| [BWA und Planung](bwa-planung.md)                                | BWA-Import, Plausibilisierung, Hochrechnung, Liquiditätsindikatoren, Szenarien und Portal-Planung                                  | Mitarbeiter, Mandant            |
| [Workflows und Formulare](workflows-formulare.md)                | Vorlagen, Instanzen, konsistenzgesicherte Schritte, Mandantenanforderungen, Form-Builder, Antworten und interne Nacharbeit         | Mitarbeiter, Admin, Mandant     |
| [Kalender, Fristen und Bescheide](kalender-fristen-bescheide.md) | Kanzleikalender, Steuertermine, Terminanfragen, Bescheiderfassung, Einspruchs- und Klagefristen                                    | Mitarbeiter, Admin, Mandant     |
| [Subsumtion, TCMS und Quantenlos](subsumtion-tcms-quantenlos.md) | Sachverhaltsanalyse, Governance-Matrix, Recherche, Archivierung und beweisbare Stichproben                                         | Berufsträger, Admin             |

Geltungsbereich: Die Kapitel decken die Module des Prüfungs-Scopes und die
zentralen optionalen Fachmodule ab (vgl.
[Gap-Analyse Prüfungsbereitschaft](../compliance/idw-ps880-pruefungsbereitschaft.md),
Abschnitt 2). Die vollständige technische Funktionsinventur steht ergänzend in
[FEATURES.md](../../FEATURES.md). TaxTronik besitzt derzeit kein separates
kontextsensitives In-App-Handbuch; deshalb darf die Funktionsinventur nicht als
Ersatz für fehlende Anwenderkapitel bezeichnet werden.

Berufsträger finden die regelweise fachliche Entscheidungsgrundlage im
[Fachkatalog](../fachkatalog/README.md). Der dortige Prüfstatus ist ausdrücklich
von der technischen Umsetzung getrennt; ungeprüfte Entwürfe sind keine
fachliche Freigabe.

Betrieb und Installation sind NICHT Teil des Benutzerhandbuchs — siehe
Betriebsdokumentation: [README](../../README.md) (Produktivbetrieb),
[Release/Update](../operations/release.md),
[Disaster-Recovery](../operations/disaster-recovery.md).
