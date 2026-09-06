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

| Kategorie                  | Beispiele                                             | Personenbezug                            |
| -------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| Mandanten-Stammdaten       | Name, Anschrift, USt-ID, DATEV-Nr., Bankverbindung    | mittel                                   |
| Ansprechpartner-Daten      | E-Mail, Telefon, Vor-/Nachname                        | mittel                                   |
| Identitätsnachweise (GwG)  | Personalausweis, Reisepass, Handelsregisterauszug     | **hoch** (besondere Kategorien § 23 GwG) |
| Wirtschaftlich Berechtigte | Geburtsdatum, Geburtsort, Anteil, PEP-Status          | **hoch**                                 |
| Finanzdaten                | BWA-Positionen, Rechnungsbeträge, Stundenabrechnungen | mittel-hoch                              |
| Korrespondenz              | Anforderungen, Antworten, Anhänge                     | mittel                                   |
| Telemetriedaten            | Login-Zeiten, IP-Adressen, Audit-Log                  | mittel                                   |
| Mitarbeiterdaten           | Zeiterfassung, Urlaub, Krankmeldung                   | hoch                                     |

### 2.2 Verarbeitungszwecke

- Erfüllung des Steuerberatungsmandats (Art. 6 Abs. 1 lit. b DSGVO)
- Erfüllung gesetzlicher Pflichten: GoBD (§ 146 AO), GwG (§ 10 ff.) und
  HGB (§ 257) — Art. 6 Abs. 1 lit. c DSGVO. Die Rechtsgrundlage des
  Vollmachtsprozesses ist kanzlei- und vorgangsbezogen festzulegen; eIDAS ist
  keine eigenständige datenschutzrechtliche Rechtsgrundlage.
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
  - bei aktiviertem Hardware-Zugang: FIDO Metadata Service für den signierten
    Metadaten-BLOB; übermittelt werden keine Staff-/Credential-IDs als
    Anwendungsparameter, aber Server-Verbindungsdaten fallen beim Anbieter an
  - bei aktiviertem Hardware-Zugang: CA-CRL-Endpunkte bereits vertrauenswürdig
    aufgebauter Zertifikatsketten; keine Staff-/Credential-IDs als
    Anwendungsparameter, aber Server-Verbindungsdaten bei den Betreibern

### 2.4 Speicherdauer

| Datenkategorie                                | Aufbewahrung                                                                                                                                  | Rechtsgrundlage                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Steuer-/Handelsunterlagen                     | je Dokumentart 6/8/10 Jahre, ggf. Verfahrensverlängerung                                                                                      | § 147 AO / § 14b UStG                            |
| Verträge                                      | 6 Jahre                                                                                                                                       | § 257 HGB                                        |
| GwG-Nachweise                                 | grundsätzlich 5 Jahre; andere Gesetze ggf. länger, Vernichtung spätestens nach 10 Jahren                                                      | § 8 Abs. 4 GwG                                   |
| Audit-Log + Tagesstempel                      | 10 Jahre (Hash-Chain unveränderlich)                                                                                                          | § 146 AO                                         |
| Magic-Links (Portal)                          | nach Verbrauch oder 30 Min.                                                                                                                   | technisch                                        |
| Gesetzlich erforderliche Arbeitszeitnachweise | mindestens 2 Jahre ab Aufzeichnung; weitere Lohn-/Steuer- und Verjährungsfristen gesondert prüfen                                             | § 16 ArbZG und weitere einschlägige Vorschriften |
| Backups                                       | S3-Bucket auf 90 Tage konfiguriert; tatsächliche Lifecycle-Wirksamkeit sowie lokale/Off-Site-Fristen betreiberseitig prüfen und dokumentieren | technisch / Löschkonzept                         |

---

## 3. Notwendigkeit & Verhältnismäßigkeit

Die Verarbeitung ist erforderlich, weil:

1. **Steuerberatungsleistung** nicht ohne Mandantendaten erbringbar ist
2. **GwG-Identifizierung** gesetzlich vorgeschrieben (§ 10 GwG)
3. **GoBD-Aufbewahrung** mit Manipulationsschutz steuerrechtlich verpflichtend
4. **Elektronische Rechnung**: Inländische Unternehmer müssen seit 2025
   E-Rechnungen empfangen können. Für die Ausstellung im inländischen
   B2B-Bereich gelten die Voraussetzungen und Übergangsfristen der
   §§ 14, 27 Abs. 38 UStG; TaxTronik unterstützt dafür strukturierte Formate.

Datenminimierung wird durch RBAC, RLS und kategorisierte Aufbewahrungsfristen
sichergestellt.

---

## 4. Risiken für betroffene Personen

| Risiko                                              | Eintrittswahrscheinlichkeit | Schwere | Brutto-Risiko |
| --------------------------------------------------- | --------------------------- | ------- | ------------- |
| Unbefugter Zugriff auf GwG-Identitätsnachweise      | gering                      | hoch    | mittel        |
| Manipulation der Buchhaltungs-Belege                | gering                      | hoch    | mittel        |
| Identitätsdiebstahl bei Magic-Link-Phishing         | gering                      | mittel  | gering        |
| Verlust der GoBD-Daten (z. B. Hardware-Ausfall)     | mittel                      | hoch    | hoch          |
| Datenpanne durch Mitarbeiter-Account-Übernahme      | gering                      | hoch    | mittel        |
| Aussperrung nach Verlust aller Sicherheitsschlüssel | gering                      | mittel  | gering        |
| Ungewollte Weitergabe an Dritte (n8n-Webhook)       | gering                      | mittel  | gering        |

---

## 5. Abhilfemaßnahmen (TOM)

### 5.1 Technische Maßnahmen

| Risiko                        | Maßnahme                                                                                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unbefugter Zugriff            | Mitarbeiter: Passwort + TOTP oder nach persönlichem Opt-in ausschließlich mindestens zwei physische FIDO2-Schlüssel ohne Software-Fallback; Portal unverändert per E-Mail-Magic-Link                              |
| Cross-Tenant-Datenleck        | Postgres Row-Level-Security + App-Filter (doppelte Verteidigung, ADR-0002)                                                                                                                                        |
| Manipulation Belege           | S3 Object-Lock COMPLIANCE je Dokumenttyp 6/8/10 Jahre + ClamAV-Virenscan vor Commit                                                                                                                               |
| Manipulation Buchführung      | Hash-Chain auf Audit-Log + rollende RFC-3161-Anker (Regelfall 2 s) + zusätzliche Tagesversiegelung (ADR-0004)                                                                                                     |
| Passwort-Brute-Force          | Rate-Limit 10 Versuche / 10 Min auf Passwort-Step, 5 Versuche / 5 Min auf TOTP                                                                                                                                    |
| Magic-Link-Phishing           | Tokens 32 Byte random, gehashed (SHA-256) gespeichert, 30 Min TTL, one-time                                                                                                                                       |
| Daten in Transit              | HTTPS (Reverse-Proxy der Kanzlei), HSTS-Header                                                                                                                                                                    |
| Daten at Rest                 | LUKS/BitLocker auf Server-Storage; Postgres-Verschlüsselung über Filesystem                                                                                                                                       |
| Datenverlust                  | Täglicher Postgres-Dump in den `backups`-Bucket, monatlicher DB-Restore-Drill sowie getrennte, verschlüsselte Off-Site-Sicherung nach Betreiberkonzept                                                            |
| TOTP-Secret-Kompromittierung  | Per-Tenant-HKDF-Key, AES-256-GCM-verschlüsselt in DB                                                                                                                                                              |
| WebAuthn-Replay/Phishing      | einmalige kurzlebige Challenge, RP-/Origin-Bindung, User Verification `required`, Signaturzähler und Rate-Limit; direkte vollständige `packed`-Attestation mit nichtleerer AAGUID-Allowlist und FIDO MDS `strict` |
| Verlust aller FIDO2-Schlüssel | hierarchischer Break-glass-Reset, Sperre aller Credentials, neues Passwort/TOTP-Enrollment und Session-Widerruf; zweiter Schlüssel ist getrennt aufzubewahren                                                     |

Der Hardware-only-Modus verlangt `cross-platform`, `singleDevice`, keine
Backup-Eignung oder -Sicherung und einen Hardware-Transport. Enrollment fordert
eine direkte, vollständige `packed`-Attestation; die AAGUID muss in der
nichtleeren Deployment-Allowlist stehen und ihr FIDO-MDS-Statement im Modus
`strict` die Hardware-Richtlinie erfüllen. Die Zertifikat-AAGUID muss zur
signierten Authenticator-AAGUID passen; Zertifikatsketten und CRLs werden
fail-closed geprüft. Jede spätere Assertion prüft die Allowlist und den
höchstens einstündigen MDS-Snapshot erneut und scheitert bei Nichtverfügbarkeit
fail-closed. Die höchste verifizierte BLOB-Seriennummer bleibt clusterweit in
der owner-only Datenbank verankert.

Die AAGUID identifiziert nur eine Modellfamilie, keine Seriennummer oder
individuelle physische Instanz. Zwei Credentials beweisen deshalb nicht
kryptografisch zwei unterschiedliche Geräte; beide Schlüssel sind vor dem
Opt-in einzeln zu testen und getrennt zu verwahren. Attachment und Transporte
bleiben Clientangaben. Zusätzlich sind MDS-/CA-CRL-Egress, der prozesslokale
bedarfsgetriebene Refresh, das Aussperrungsrisiko bei MDS-/Netzausfall sowie die
Verarbeitung von AAGUID, Attestationsdaten, attestierter Firmware-Version und
Server-Verbindungsdaten in der konkreten TOM-/Datenschutzbewertung zu
berücksichtigen.

### 5.2 Organisatorische Maßnahmen

- DSGVO-Anfragen-Workflow im System (Art. 15/16/17/18/20/21) mit
  Frist-Tracking (1 Monat Default, verlängerbar)
- Dienstleisterverzeichnis (§ 11 GwG, DSGVO Art. 28) im System gepflegt
- Audit-Log-Verifikation täglich automatisch (Worker `audit-verify-check`),
  Bruch löst Notification an alle ADMIN/PARTNER aus
- GwG-Ablauf-Warnung 30 Tage vorher, automatische Deaktivierung
- Mitarbeiter-Onboarding mit DSGVO-Schulung (jährlich)
- Verschwiegenheitserklärung aller Mitarbeiter (§ 203 StGB)
- Bei Hardware-only: geprüfte AAGUID-Allowlist, MDS-Egress-/Refresh-Monitoring,
  getrennte Funktionsprüfung beider Schlüssel und dokumentierter Recovery-Test

---

## 6. Bewertung des Restrisikos

> **Auszufüllen durch den Verantwortlichen:** Die Software kann die konkrete
> Risikobewertung der Kanzlei nicht vorwegnehmen. Eintrittswahrscheinlichkeit,
> Schadensschwere und Wirksamkeit der TOM sind für den tatsächlichen Betrieb,
> Datenumfang, Nutzerkreis und alle aktivierten Drittanbieter zu bewerten.

- Verbleibendes Restrisiko: \_\_\_\_\_\_
- Begründung und verwendete Nachweise: \_\_\_\_\_\_
- Stellungnahme des Datenschutzbeauftragten, soweit benannt: \_\_\_\_\_\_
- Freigabe durch den Verantwortlichen (Name, Datum): \_\_\_\_\_\_

Ergibt die DSFA trotz der vorgesehenen Maßnahmen weiterhin ein hohes Risiko,
ist **vor Beginn der Verarbeitung** die zuständige Aufsichtsbehörde nach
Art. 36 DSGVO zu konsultieren. Die Entscheidung „Konsultation erforderlich /
nicht erforderlich“ ist hier mit ihrer Begründung zu dokumentieren:
\_\_\_\_\_\_

---

## 7. Überprüfung der DSFA

- **Erstellt am**: …
- **Verantwortlich**: …
- **Nächste Überprüfung**: spätestens nach Änderung der Verarbeitung,
  ansonsten alle 24 Monate
- **Versionshistorie**:
  - v1.0 (Datum): Initial-Erstellung anhand taxtronik-Vorlage
