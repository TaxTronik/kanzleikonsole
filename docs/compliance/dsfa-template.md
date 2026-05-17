# Datenschutz-Folgenabschätzung (DSFA) — taxtronik

> **Vorlage** für die DSFA nach Art. 35 DSGVO. Anpassung an die konkrete
> Kanzlei-Situation ist Pflicht: Hosting-Standort, Mitarbeiterzahl,
> Mandantenstruktur, etablierte technische und organisatorische Maßnahmen
> (TOM) variieren.
>
> Diese Vorlage deckt die typischen Verarbeitungstätigkeiten von taxtronik ab.
> Die DSFA ist verbindlich, sobald eine **voraussichtlich hohes Risiko** für
> die Rechte und Freiheiten betroffener Personen besteht (Art. 35 Abs. 1).

---

## 1. Bezeichnung der Verarbeitung

**Verarbeitung**: Mandantenverwaltung, Belegarchivierung, Anforderungs-
Workflow, GwG-Identifizierung und Risikobewertung, elektronische Signatur
von Vollmachten, Rechnungserstellung mit XRechnung/ZUGFeRD,
Betriebswirtschaftliche Auswertungen, Steuerschätzung.

**Verantwortlicher**:
- Name der Kanzlei: …
- Anschrift: …
- Vertretungsberechtigter: …
- Datenschutzbeauftragter (intern oder extern): …

**Art der Verarbeitung**: automatisiert, in einer On-Premise-betriebenen
Webanwendung mit Postgres-Datenbank, SeaweedFS-Object-Storage und ClamAV-
Virenscan. Kein Cloud-Provider, keine US-Datenübermittlung.

---

## 2. Beschreibung der Verarbeitungsvorgänge

### 2.1 Datenkategorien

| Kategorie | Beispiele | Personenbezug |
|---|---|---|
| Mandanten-Stammdaten | Name, Anschrift, USt-ID, DATEV-Nr., Bankverbindung | mittel |
| Ansprechpartner-Daten | E-Mail, Telefon, Vor-/Nachname | mittel |
| Identitätsnachweise (GwG) | Personalausweis, Reisepass, Handelsregisterauszug | **hoch** (besondere Kategorien § 23 GwG) |
| Wirtschaftlich Berechtigte | Geburtsdatum, Geburtsort, Anteil, PEP-Status | **hoch** |
| Finanzdaten | BWA-Positionen, Rechnungsbeträge, Stundenabrechnungen | mittel-hoch |
| Korrespondenz | Anforderungen, Antworten, Anhänge | mittel |
| Telemetriedaten | Login-Zeiten, IP-Adressen, Audit-Log | mittel |
| Mitarbeiterdaten | Zeiterfassung, Urlaub, Krankmeldung | hoch |

### 2.2 Verarbeitungszwecke

- Erfüllung des Steuerberatungsmandats (Art. 6 Abs. 1 lit. b DSGVO)
- Erfüllung gesetzlicher Pflichten: GoBD (§ 146 AO), GwG (§ 10 ff.),
  HGB (§ 257), eIDAS (Vollmachten) — Art. 6 Abs. 1 lit. c DSGVO
- Berechtigtes Interesse: Audit-Log, IT-Sicherheit (Virenscan, Login-Logs) —
  Art. 6 Abs. 1 lit. f
- Mitarbeiterverwaltung: § 26 BDSG

### 2.3 Empfänger

- **Intern**: Kanzlei-Mitarbeiter (rollenbasiert: EMPLOYEE, PARTNER, ADMIN)
- **Extern**:
  - Mandanten-Ansprechpartner (Portal-Login)
  - Finanzbehörden (Steuererklärungen, Vollmachten)
  - Banken (Überweisungen aus Rechnungen)
  - Auftragsverarbeiter (siehe VVT, z. B. Mailprovider, RFC-3161-TSA)

### 2.4 Speicherdauer

| Datenkategorie | Aufbewahrung | Rechtsgrundlage |
|---|---|---|
| Belege (GoBD-Klassen) | 10 Jahre | § 147 AO |
| Verträge | 6 Jahre | § 257 HGB |
| GwG-Nachweise | 5 Jahre nach Ende der Geschäftsbeziehung | § 8 GwG |
| Audit-Log + Tagesstempel | 10 Jahre (Hash-Chain unveränderlich) | § 146 AO |
| Magic-Links (Portal) | nach Verbrauch oder 30 Min. | technisch |
| Mitarbeiter-Zeiterfassung | 2 Jahre nach Ende des Beschäftigungsverhältnisses | § 16 ArbZG |
| Backups | 90 Tage rolling | technisch |

---

## 3. Notwendigkeit & Verhältnismäßigkeit

Die Verarbeitung ist erforderlich, weil:
1. **Steuerberatungsleistung** nicht ohne Mandantendaten erbringbar ist
2. **GwG-Identifizierung** gesetzlich vorgeschrieben (§ 10 GwG)
3. **GoBD-Aufbewahrung** mit Manipulationsschutz steuerrechtlich verpflichtend
4. **Elektronische Rechnung** (XRechnung) für B2B ab 2025 verpflichtend

Datenminimierung wird durch RBAC, RLS und kategorisierte Aufbewahrungsfristen
sichergestellt.

---

## 4. Risiken für betroffene Personen

| Risiko | Eintrittswahrscheinlichkeit | Schwere | Brutto-Risiko |
|---|---|---|---|
| Unbefugter Zugriff auf GwG-Identitätsnachweise | gering | hoch | mittel |
| Manipulation der Buchhaltungs-Belege | gering | hoch | mittel |
| Identitätsdiebstahl bei Magic-Link-Phishing | gering | mittel | gering |
| Verlust der GoBD-Daten (z. B. Hardware-Ausfall) | mittel | hoch | hoch |
| Datenpanne durch Mitarbeiter-Account-Übernahme | gering | hoch | mittel |
| Ungewollte Weitergabe an Dritte (n8n-Webhook) | gering | mittel | gering |

---

## 5. Abhilfemaßnahmen (TOM)

### 5.1 Technische Maßnahmen

| Risiko | Maßnahme |
|---|---|
| Unbefugter Zugriff | Mitarbeiter: TOTP-2FA Pflicht; Portal: E-Mail-OTP-Magic-Link, kurze Gültigkeit |
| Cross-Tenant-Datenleck | Postgres Row-Level-Security + App-Filter (doppelte Verteidigung, ADR-0002) |
| Manipulation Belege | S3 Object-Lock COMPLIANCE 10 Jahre + ClamAV-Virenscan vor Commit |
| Manipulation Buchführung | Hash-Chain auf Audit-Log + tägliche RFC-3161-TSA-Versiegelung (ADR-0004) |
| Passwort-Brute-Force | Rate-Limit 10 Versuche / 10 Min auf Passwort-Step, 5 Versuche / 5 Min auf TOTP |
| Magic-Link-Phishing | Tokens 32 Byte random, gehashed (SHA-256) gespeichert, 30 Min TTL, one-time |
| Daten in Transit | HTTPS (Reverse-Proxy der Kanzlei), HSTS-Header |
| Daten at Rest | LUKS/BitLocker auf Server-Storage; Postgres-Verschlüsselung über Filesystem |
| Datenverlust | Tägliches Postgres-pg_dump nach SeaweedFS `backups`-Bucket, 90 Tage Lifecycle |
| TOTP-Secret-Kompromittierung | Per-Tenant-HKDF-Key, AES-256-GCM-verschlüsselt in DB |

### 5.2 Organisatorische Maßnahmen

- DSGVO-Anfragen-Workflow im System (Art. 15/16/17/18/20/21) mit
  Frist-Tracking (1 Monat Default, verlängerbar)
- Dienstleisterverzeichnis (§ 11 GwG, DSGVO Art. 28) im System gepflegt
- Audit-Log-Verifikation täglich automatisch (Worker `audit-verify-check`),
  Bruch löst Notification an alle ADMIN/PARTNER aus
- GwG-Ablauf-Warnung 30 Tage vorher, automatische Deaktivierung
- Mitarbeiter-Onboarding mit DSGVO-Schulung (jährlich)
- Verschwiegenheitserklärung aller Mitarbeiter (§ 203 StGB)

---

## 6. Bewertung des Restrisikos

Nach Anwendung der TOM verbleibt ein **niedriges Restrisiko** für die
betroffenen Personen. Die Datenverarbeitung ist verhältnismäßig zum Zweck
und mit dem Mandatsverhältnis zwingend verbunden.

**Eine Konsultation der Aufsichtsbehörde nach Art. 36 DSGVO ist nicht
erforderlich.**

---

## 7. Überprüfung der DSFA

- **Erstellt am**: …
- **Verantwortlich**: …
- **Nächste Überprüfung**: spätestens nach Änderung der Verarbeitung,
  ansonsten alle 24 Monate
- **Versionshistorie**:
  - v1.0 (Datum): Initial-Erstellung anhand taxtronik-Vorlage
