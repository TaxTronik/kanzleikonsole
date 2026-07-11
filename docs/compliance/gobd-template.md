# GoBD-Verfahrensdokumentation der Kanzlei — Vorlage

Stand: 2026-05-14

Diese Vorlage hilft Steuerberater-Kanzleien, ihre eigene GoBD-Verfahrens-
dokumentation gemäß GoBD Rn. 151 ff. zu erstellen. Sie ergänzt
[gobd.md](./gobd.md) — dort wird die TECHNISCHE Implementation in taxtronik
beschrieben, hier die ORGANISATORISCHEN Pflichten der Kanzlei.

Vor Verwendung von einer/einem WP oder Steuerberater-Anwältin prüfen lassen.

---

## 1. Unternehmensorganisation

### 1.1 Verantwortliche Personen

| Rolle                                   | Name               | E-Mail             | Vertretung         |
| --------------------------------------- | ------------------ | ------------------ | ------------------ |
| Geschäftsführer / Inhaber               | ******\_\_\_****** | ******\_\_\_****** | ******\_\_\_****** |
| Datenschutzbeauftragte/r                | ******\_\_\_****** | ******\_\_\_****** | ******\_\_\_****** |
| GwG-Verantwortliche/r (§ 7 GwG)         | ******\_\_\_****** | ******\_\_\_****** | ******\_\_\_****** |
| IT-Administration (taxtronik-Custodian) | ******\_\_\_****** | ******\_\_\_****** | ******\_\_\_****** |
| WP / Wirtschafts­prüfer/in (extern)     | ******\_\_\_****** | ******\_\_\_****** | —                  |

### 1.2 IT-Infrastruktur

- **taxtronik-Installation**: ☐ On-Premise im eigenen Serverraum
  ☐ On-Premise im externen Rechenzentrum
  ☐ Co-Located bei: ******\_\_\_******
- **Hosting-Provider** (falls anwendbar): ******\_\_\_****** (AVV abgeschlossen am **\_\_\_**)
- **Reverse-Proxy**: ☐ NGINX ☐ Caddy ☐ Traefik ☐ Sonstiger: ******\_\_\_******
- **TSA-Provider**: ☐ D-Trust ☐ SwissSign ☐ Sonstiger: ******\_\_\_******

## 2. Belegfluss und Klassifikation

| Belegart                                             | DocumentClassification | Object-Lock                                                                                 | Aufbewahrung                        |
| ---------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------- |
| Eingangs-Rechnungen                                  | GOBD_INVOICE           | ja, 8 J.                                                                                    | § 147 Abs. 3 AO / § 14b UStG        |
| Ausgangs-Rechnungen                                  | GOBD_INVOICE           | ja, 8 J.                                                                                    | § 147 Abs. 3 AO / § 14b UStG        |
| Verträge (Mandanten-Mandate, Vollmachten als Beleg)  | passender GoBD-Typ     | ja, 6/8/10 J. nach Funktion                                                                 | § 147 AO; Fristbeginn fallbezogen   |
| Steuer-Bescheide, ELSTER-Belege                      | passender GoBD-Typ     | ja, 6/8/10 J. nach Funktion                                                                 | § 147 AO; offene Verfahren beachten |
| GwG-Ausweisscans, wB-Erklärungen, TR-Auszüge         | GWG_EVIDENCE           | eigener GwG-Pfad: grundsätzlich **5 J.**, längere andere Pflichten prüfen, spätestens 10 J. | § 8 (4) GwG                         |
| Mandanten-Korrespondenz, Notizen, Formular-Antworten | GENERAL                | nein                                                                                        | —                                   |
| Mitarbeiter-Storage                                  | STAFF_PRIVATE          | nein, versioniert                                                                           | —                                   |

**Klassifikationsregeln der Kanzlei** (was wird wann wie klassifiziert):

_Beschreibung in eigenen Worten:_

```
Beispiel:
- Wenn ein Mandanten-Beleg über das Portal hochgeladen wird, klassifiziert
  der zuständige Bearbeiter ihn beim Review als GOBD_INVOICE, GOBD_CONTRACT
  oder GOBD_TAX (UI-Pflichtfeld).
- GwG-Ausweise werden ausschließlich über den GwG-Onboarding-Wizard
  hochgeladen und sind automatisch GWG_EVIDENCE.
- Telefonnotizen und Anforderungs-Antworten sind GENERAL, sofern keine
  expliziten Belegdokumente enthalten.
```

## 3. Backup-Konzept

| Aspekt              | Beschreibung                                  | Frequenz           | Verantwortlich       |
| ------------------- | --------------------------------------------- | ------------------ | -------------------- |
| Postgres-Dump       | pg_dump custom-format, komprimiert, SHA-256   | täglich 23:00      | Worker (automatisch) |
| Object-Store-Backup | S3-Replikation zu Off-Site-Bucket             | täglich            | ******\_\_\_******   |
| Off-Site-Ziel       | ******\_\_\_****** (Provider, Region)         | ******\_\_\_****** | ******\_\_\_******   |
| Verschlüsselung     | ******\_\_\_****** (Borg/Restic/serverseitig) | —                  | ******\_\_\_******   |
| Restore-Drill       | Test-Restore aus Backup in Sandbox            | quartalsweise      | ******\_\_\_******   |
| Letzter Drill       | TT.MM.JJJJ                                    | —                  | ******\_\_\_******   |

Backup-Aufbewahrung: **_ Tage rolling + _** Tage Monats-Snapshots + \_\_\_ Jahre
Jahres-Snapshots.

## 4. Datenzugriff / Z3-Recht der Finanzverwaltung

Die Kanzlei kann der Betriebsprüfung Daten in den folgenden Formaten zur
Verfügung stellen:

- **Z1 (Online-Zugriff)**: ☐ ja (Read-only-Account für Prüfer) ☐ nein
- **Z2 (Maschinelle Auswertung)**: ☐ ja, taxtronik-Admin-UI ☐ nein
- **Z3 (Datenträgerüberlassung)**: ☐ ja, via `pnpm export:datev` oder
  `/staff/clients/<id>/datev-belege-export`

Verfahren bei Prüfer-Anfrage:

1. WP/Kanzlei stellt Anfrage mit Mandanten-IDs und Zeitraum
2. Custodian erstellt DATEV-Belege-Export-ZIPs pro Mandant
3. Übergabe auf verschlüsselter externer Festplatte
4. Begleitprotokoll (signed by Berufsträger)

## 5. Internes Kontrollsystem (IKS)

| Kontrolle                                                        | Frequenz            | Verantwortlich        |
| ---------------------------------------------------------------- | ------------------- | --------------------- |
| Audit-Hash-Chain-Verifikation (automatisch via verify:chain)     | täglich 02:45 UTC   | Worker                |
| Audit-Hash-Chain-Verifikation (manuell, beim Quartalsabschluss)  | quartalsweise       | Berufsträger          |
| Backup-Integrität (Hash-Match in BackupRecord)                   | täglich automatisch | Restore-Routine       |
| TSA-Stempel-Coverage (kein NULL in audit_seal.tsa_response_blob) | wöchentlich         | ******\_\_\_******    |
| GoBD-Stichproben aus DATEV-Export                                | quartalsweise       | Berufsträger          |
| GwG-Auswertung Risikoanalysen                                    | jährlich            | GwG-Verantwortliche/r |

## 6. Wiederanlauf (Disaster Recovery)

Siehe [docs/operations/disaster-recovery.md](../operations/disaster-recovery.md)
für die technische Anleitung. Organisatorisch:

- **RTO** (Recovery Time Objective): \_\_\_ Stunden
- **RPO** (Recovery Point Objective): \_\_\_ Stunden (= max. Datenverlust)
- **Eskalations­kette**: 1. **\_\_\_** → 2. **\_\_\_** → 3. **\_\_\_**
- **Externe Unterstützung im Notfall**: ******\_\_\_****** (Vendor-Support
  oder externe IT-Firma)

## 7. Schulungen und Dokumentation

| Schulungsbereich                                       | Frequenz        | Letzte Schulung |
| ------------------------------------------------------ | --------------- | --------------- |
| DSGVO-Grundlagen für Mitarbeiter                       | jährlich        | TT.MM.JJJJ      |
| GwG-Schulung (§ 6 Abs. 2 Nr. 5 GwG)                    | jährlich        | TT.MM.JJJJ      |
| taxtronik-Bedienung (Belegklassifikation, Audit-Trail) | bei Einstellung | TT.MM.JJJJ      |
| Phishing-/Social-Engineering-Awareness                 | jährlich        | TT.MM.JJJJ      |

## 8. Änderungs-Protokoll dieser Doku

| Datum      | Wer                | Was wurde geändert |
| ---------- | ------------------ | ------------------ |
| TT.MM.JJJJ | ******\_\_\_****** | Erstausstellung    |
|            |                    |                    |
