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

| Rolle | Name | E-Mail | Vertretung |
|---|---|---|---|
| Geschäftsführer / Inhaber | _______________ | _______________ | _______________ |
| Datenschutzbeauftragte/r | _______________ | _______________ | _______________ |
| GwG-Verantwortliche/r (§ 7 GwG) | _______________ | _______________ | _______________ |
| IT-Administration (taxtronik-Custodian) | _______________ | _______________ | _______________ |
| WP / Wirtschafts­prüfer/in (extern) | _______________ | _______________ | — |

### 1.2 IT-Infrastruktur

- **taxtronik-Installation**: ☐ On-Premise im eigenen Serverraum
                              ☐ On-Premise im externen Rechenzentrum
                              ☐ Co-Located bei: _______________
- **Hosting-Provider** (falls anwendbar): _______________ (AVV abgeschlossen am _______)
- **Reverse-Proxy**: ☐ NGINX  ☐ Caddy  ☐ Traefik  ☐ Sonstiger: _______________
- **TSA-Provider**: ☐ D-Trust  ☐ SwissSign  ☐ Sonstiger: _______________

## 2. Belegfluss und Klassifikation

| Belegart | DocumentClassification | Object-Lock | Aufbewahrung |
|---|---|---|---|
| Eingangs-Rechnungen | GOBD_INVOICE | ja, 10 J. | § 147 AO |
| Ausgangs-Rechnungen | GOBD_INVOICE | ja, 10 J. | § 147 AO |
| Verträge (Mandanten-Mandate, Vollmachten als Beleg) | GOBD_CONTRACT | ja, 10 J. | § 147 AO |
| Steuer-Bescheide, ELSTER-Belege | GOBD_TAX | ja, 10 J. | § 147 AO |
| GwG-Ausweisscans, wB-Erklärungen, TR-Auszüge | GWG_EVIDENCE | ja, **5 J.** | § 8 (4) GwG |
| Mandanten-Korrespondenz, Notizen, Formular-Antworten | GENERAL | nein | — |
| Mitarbeiter-Storage | STAFF_PRIVATE | nein, versioniert | — |

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

| Aspekt | Beschreibung | Frequenz | Verantwortlich |
|---|---|---|---|
| Postgres-Dump | pg_dump custom-format, komprimiert, SHA-256 | täglich 23:00 | Worker (automatisch) |
| Object-Store-Backup | S3-Replikation zu Off-Site-Bucket | täglich | _______________ |
| Off-Site-Ziel | _______________ (Provider, Region) | _______________ | _______________ |
| Verschlüsselung | _______________ (Borg/Restic/serverseitig) | — | _______________ |
| Restore-Drill | Test-Restore aus Backup in Sandbox | quartalsweise | _______________ |
| Letzter Drill | TT.MM.JJJJ | — | _______________ |

Backup-Aufbewahrung: ___ Tage rolling + ___ Tage Monats-Snapshots + ___ Jahre
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

| Kontrolle | Frequenz | Verantwortlich |
|---|---|---|
| Audit-Hash-Chain-Verifikation (automatisch via verify:chain) | täglich 02:45 UTC | Worker |
| Audit-Hash-Chain-Verifikation (manuell, beim Quartalsabschluss) | quartalsweise | Berufsträger |
| Backup-Integrität (Hash-Match in BackupRecord) | täglich automatisch | Restore-Routine |
| TSA-Stempel-Coverage (kein NULL in audit_seal.tsa_response_blob) | wöchentlich | _______________ |
| GoBD-Stichproben aus DATEV-Export | quartalsweise | Berufsträger |
| GwG-Auswertung Risikoanalysen | jährlich | GwG-Verantwortliche/r |

## 6. Wiederanlauf (Disaster Recovery)

Siehe [docs/operations/disaster-recovery.md](../operations/disaster-recovery.md)
für die technische Anleitung. Organisatorisch:

- **RTO** (Recovery Time Objective): ___ Stunden
- **RPO** (Recovery Point Objective): ___ Stunden (= max. Datenverlust)
- **Eskalations­kette**: 1. _______ → 2. _______ → 3. _______
- **Externe Unterstützung im Notfall**: _______________ (Vendor-Support
  oder externe IT-Firma)

## 7. Schulungen und Dokumentation

| Schulungsbereich | Frequenz | Letzte Schulung |
|---|---|---|
| DSGVO-Grundlagen für Mitarbeiter | jährlich | TT.MM.JJJJ |
| GwG-Schulung (§ 6 Abs. 2 Nr. 5 GwG) | jährlich | TT.MM.JJJJ |
| taxtronik-Bedienung (Belegklassifikation, Audit-Trail) | bei Einstellung | TT.MM.JJJJ |
| Phishing-/Social-Engineering-Awareness | jährlich | TT.MM.JJJJ |

## 8. Änderungs-Protokoll dieser Doku

| Datum | Wer | Was wurde geändert |
|---|---|---|
| TT.MM.JJJJ | _______________ | Erstausstellung |
| | | |
