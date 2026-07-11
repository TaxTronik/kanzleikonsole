# Verzeichnis von Verarbeitungstätigkeiten (VVT) — taxtronik

> **Vorlage** nach Art. 30 DSGVO. Jede Kanzlei muss ein eigenes VVT führen
> und der Aufsichtsbehörde auf Anforderung vorlegen können.
>
> Dieses Template listet die Verarbeitungstätigkeiten, die durch taxtronik
> abgewickelt werden. Anpassungen erforderlich für nicht-software-bezogene
> Tätigkeiten (z. B. Postversand, Beratungsgespräche).

---

## Stammdaten

**Verantwortlicher** (Art. 4 Nr. 7 DSGVO):

- Name: …
- Anschrift: …
- Vertretungsberechtigter: …
- Datenschutzbeauftragter: …
- Kontakt für Betroffenenanfragen: …

---

## Verarbeitungstätigkeiten

### V1 — Mandantenverwaltung

| Feld                   | Inhalt                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Zweck                  | Stammdatenpflege, Korrespondenz, Auftragsabwicklung                                                                                   |
| Rechtsgrundlage        | Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung)                                                                                        |
| Datenkategorien        | Name, Anschrift, Telefon, E-Mail, USt-ID, Steuer-Nr., DATEV-Nr., Bankverbindung                                                       |
| Betroffene Personen    | Mandanten und deren Ansprechpartner                                                                                                   |
| Empfänger              | Intern: Mitarbeiter; extern: keine                                                                                                    |
| Drittlandsübermittlung | Keine                                                                                                                                 |
| Aufbewahrung           | je Datenklasse festzulegen; Handakten regelmäßig 10 Jahre nach § 66 StBerG, daneben konkrete Steuer-, Handels- und GwG-Fristen prüfen |
| TOM                    | RBAC, RLS, TLS, AES-256 verschlüsselte TOTP-Secrets                                                                                   |

### V2 — Belegarchivierung (GoBD)

| Feld                   | Inhalt                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Zweck                  | Aufbewahrung steuerlich relevanter Belege                                                                                       |
| Rechtsgrundlage        | Art. 6 Abs. 1 lit. c (§ 146, § 147 AO)                                                                                          |
| Datenkategorien        | Rechnungen, Verträge, Steuerunterlagen, ggf. personenbezogene Inhalte                                                           |
| Betroffene Personen    | Mandanten, Geschäftspartner der Mandanten                                                                                       |
| Empfänger              | Intern: Mitarbeiter; extern: Finanzbehörden auf Anforderung                                                                     |
| Drittlandsübermittlung | Keine                                                                                                                           |
| Aufbewahrung           | je Dokumentart 6, 8 oder 10 Jahre (§ 147 AO); Rechnungen 8 Jahre (§ 14b UStG); mögliche Ablaufhemmungen/Verfahrensbezüge prüfen |
| TOM                    | S3 Object-Lock COMPLIANCE, Hash-Chain auf Audit-Log, RFC-3161-TSA, ClamAV-Virenscan vor Commit                                  |

### V3 — GwG-Identifizierung & Risikobewertung

| Feld                   | Inhalt                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Zweck                  | Erfüllung der GwG-Sorgfaltspflichten                                                                                                    |
| Rechtsgrundlage        | Art. 6 Abs. 1 lit. c (§ 10 ff. GwG)                                                                                                     |
| Datenkategorien        | Personalausweis-/Pass-Daten, Geburtsdatum, Staatsangehörigkeit, PEP-Status, wirtschaftlich Berechtigte, Risikobewertung                 |
| Betroffene Personen    | Mandanten, gesetzliche Vertreter, wirtschaftlich Berechtigte                                                                            |
| Empfänger              | Intern: Mitarbeiter; extern: BaFin / FIU / Strafverfolgungsbehörden auf Anforderung                                                     |
| Drittlandsübermittlung | Keine                                                                                                                                   |
| Aufbewahrung           | grundsätzlich 5 Jahre nach gesetzlichem Fristbeginn; andere Gesetze ggf. länger, Vernichtung spätestens nach 10 Jahren (§ 8 Abs. 4 GwG) |
| TOM                    | eigener GwG-Bucket mit GOVERNANCE-Lock, fachliche Vernichtungs-Review-Queue, Hash-Chain, RBAC ADMIN/PARTNER für Verifikation            |

### V4 — Anforderungs-Workflow (Mandantenportal)

| Feld                   | Inhalt                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Zweck                  | Strukturierte Belegabfrage und -beantwortung                                                                 |
| Rechtsgrundlage        | Art. 6 Abs. 1 lit. b (Vertragserfüllung)                                                                     |
| Datenkategorien        | Anforderungstexte, Antworten, hochgeladene Belege                                                            |
| Betroffene Personen    | Mandanten-Ansprechpartner                                                                                    |
| Empfänger              | Intern: Mitarbeiter; extern: keine                                                                           |
| Drittlandsübermittlung | Keine                                                                                                        |
| Aufbewahrung           | grundsätzlich 6 Jahre; bei verknüpften GoBD-Dokumenten längste einschlägige Typfrist von 6, 8 oder 10 Jahren |
| TOM                    | Magic-Link-Auth (one-time, 30 Min TTL, gehasht), Rate-Limit, RLS                                             |

### V5 — Rechnungsstellung (XRechnung/ZUGFeRD)

| Feld                   | Inhalt                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| Zweck                  | Erfüllung handelsrechtlicher Pflichten + Mandantenrechnung                                            |
| Rechtsgrundlage        | Art. 6 Abs. 1 lit. b + lit. c                                                                         |
| Datenkategorien        | Rechnungsdaten, Bankverbindung Verkäufer, Mandanten-Adresse, USt-ID                                   |
| Betroffene Personen    | Mandanten                                                                                             |
| Empfänger              | Intern; extern: Mandant; ggf. Finanzbehörde                                                           |
| Drittlandsübermittlung | Keine                                                                                                 |
| Aufbewahrung           | 8 Jahre (§ 147 Abs. 3 AO / § 14b UStG), soweit keine Ablaufhemmung oder längere Spezialpflicht greift |
| TOM                    | XRechnung 3.0 / ZUGFeRD EN16931, Audit-Log auf Erstellung+Versand                                     |

### V6 — Elektronische Vollmachten-Bestätigung

| Feld                   | Inhalt                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zweck                  | Elektronische Bevollmächtigung zur Vertretung                                                                                                                                           |
| Rechtsgrundlage        | Kanzleispezifisch festzulegen, regelmäßig Art. 6 Abs. 1 lit. b oder c DSGVO; eIDAS Art. 26 ist keine datenschutzrechtliche Rechtsgrundlage                                              |
| Datenkategorien        | Vollmachtsumfang, Signatur-Beleg (IP, User-Agent, Zeitstempel), Unterzeichner-Adresse                                                                                                   |
| Betroffene Personen    | Vollmachtgeber                                                                                                                                                                          |
| Empfänger              | Intern; extern: Behörde, der die Vollmacht vorgelegt wird                                                                                                                               |
| Drittlandsübermittlung | Keine                                                                                                                                                                                   |
| Aufbewahrung           | kanzleispezifisch nach Mandats-/Nachweiszweck und einschlägigen gesetzlichen Pflichten festzulegen; keine pauschale Mindestfrist                                                        |
| TOM                    | Magic-Link + 6-stelliger E-Mail-Code, explizite Bestätigung, gebundener Inhalts-/Dokumentversions-Snapshot, Hash-Chain-Audit, atomare State-Transition; keine Produktzusage als AES/QES |

### V7 — Mitarbeiterverwaltung (Zeit, Urlaub, Krank)

| Feld                   | Inhalt                                                        |
| ---------------------- | ------------------------------------------------------------- |
| Zweck                  | Lohnabrechnung, Urlaubsplanung, AU-Erfassung                  |
| Rechtsgrundlage        | § 26 BDSG (Beschäftigungsverhältnis)                          |
| Datenkategorien        | Arbeitszeit pro Mandant, Urlaubsanträge, AU-Bescheinigungen   |
| Betroffene Personen    | Mitarbeiter                                                   |
| Empfänger              | Intern: Geschäftsführung, Personalbüro                        |
| Drittlandsübermittlung | Keine                                                         |
| Aufbewahrung           | 2 Jahre nach Ende des Beschäftigungsverhältnisses             |
| TOM                    | RLS, Audit-Log, AU-Bescheinigung verschlüsselt im GoBD-Bucket |

### V8 — System-Audit & Logging

| Feld                   | Inhalt                                                                          |
| ---------------------- | ------------------------------------------------------------------------------- |
| Zweck                  | Compliance, Beweissicherung, IT-Sicherheit                                      |
| Rechtsgrundlage        | Art. 6 Abs. 1 lit. c (§ 146 AO) + lit. f (berechtigtes Interesse)               |
| Datenkategorien        | Akteur-ID, Aktion, Ressource, Zeitstempel, IP, User-Agent, vorher/nachher-State |
| Betroffene Personen    | Alle Nutzer                                                                     |
| Empfänger              | Intern: ADMIN/PARTNER; extern: Wirtschaftsprüfer auf Anforderung                |
| Drittlandsübermittlung | Keine                                                                           |
| Aufbewahrung           | 10 Jahre (Hash-Chain unveränderbar)                                             |
| TOM                    | DB-Trigger blockt UPDATE/DELETE, Hash-Chain, RFC-3161-TSA                       |

### V9 — Backup

| Feld                   | Inhalt                                                                   |
| ---------------------- | ------------------------------------------------------------------------ |
| Zweck                  | Wiederherstellbarkeit nach Datenverlust                                  |
| Rechtsgrundlage        | Art. 6 Abs. 1 lit. c (§ 146 AO) + lit. f                                 |
| Datenkategorien        | Vollständiger Postgres-Dump                                              |
| Betroffene Personen    | Alle                                                                     |
| Empfänger              | Intern: ADMIN                                                            |
| Drittlandsübermittlung | Keine (sofern Off-Site-Backup auf inländischem Storage)                  |
| Aufbewahrung           | 90 Tage rolling                                                          |
| TOM                    | SHA-256-Integritätsprüfung, Off-Site-Replikation (Borg/Restic empfohlen) |

---

## Auftragsverarbeiter (Art. 28)

| Dienstleister                                            | Zweck                                            | DSGVO-Vertrag                                                     |
| -------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| SMTP-Provider (z. B. Hosteurope, …)                      | E-Mail-Versand für Magic-Links und Notifications | erforderlich                                                      |
| RFC-3161-TSA (z. B. D-Trust)                             | Tagesversiegelung der Audit-Chain                | erforderlich (Hash, kein Personenbezug → ggf. nicht erforderlich) |
| Hosting-Anbieter (sofern nicht in eigener Infrastruktur) | Server-Bereitstellung                            | erforderlich                                                      |

Pflege im System unter `/staff/service-providers`.

---

## Überprüfung des VVT

- **Erstellt am**: …
- **Verantwortlich**: …
- **Letzte Überprüfung**: …
- **Nächste Überprüfung**: jährlich oder bei Änderung
