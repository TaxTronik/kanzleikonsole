# DSGVO — Lösch-, Aufbewahrungs- und Verarbeitungskonzept

Stand: 2026-05-11. Dieses Dokument beschreibt für taxtronik:

- Welche personenbezogenen Daten verarbeitet werden
- Welche Aufbewahrungsfristen gelten
- Wie und wann gelöscht oder anonymisiert wird
- Welche Betroffenenrechte (Auskunft, Berichtigung, Löschung) wie umgesetzt sind

> Adressat: Auftraggeber (Steuerkanzlei) zur Vorlage bei eigener
> Datenschutz-Auditierung und für die Antwort auf Betroffenen-Anfragen.

---

## 1. Verarbeitete Datenkategorien

### 1.1 Mitarbeiter der Kanzlei (`staff_user`)

| Feld | Zweck | Rechtsgrundlage |
|---|---|---|
| `email`, `fullName` | Login + Identifikation | Art. 6 (1) b DSGVO (Vertrag) |
| `passwordHash` | Authentifizierung | Art. 6 (1) b |
| `totpSecretEnc` | 2FA-Pflicht | Art. 6 (1) c (§ 32 DSGVO) |
| `roles` | Zugriffssteuerung | Art. 6 (1) b |
| `lastLoginAt` | Sicherheits-Monitoring | Art. 6 (1) f |
| `lockedUntil` | Brute-Force-Schutz | Art. 6 (1) f |

### 1.2 Mandanten (`client`)

| Feld | Zweck |
|---|---|
| Firma, Anschrift, USt-ID | Mandanten-Verwaltung + Rechnungsstellung |
| DATEV-/Addison-Nr. | Verknüpfung externe Systeme |
| Stamm-Daten (`vatId`, `kind` etc.) | GwG-relevante Identifizierung |

### 1.3 Mandanten-Kontakte (`client_contact`)

| Feld | Zweck |
|---|---|
| `email`, `fullName` | Portal-Zugang + Kommunikation |
| `lastLoginAt` | Aktivitätsanzeige |
| `notificationsEnabled` | Selbstbestimmung Mandant |

### 1.4 GwG-Daten (besonders schutzbedürftig)

| Feld / Tabelle | Zweck | Rechtsgrundlage |
|---|---|---|
| `gwg_check.*` | Geldwäschegesetz-Prüfung | Art. 6 (1) c DSGVO + § 11 GwG |
| `gwg_id_document` mit Ausweisbildern | Identifizierung gem. § 12 GwG | Art. 6 (1) c |
| `gwg_beneficial_owner` (Geb.-Datum, Anschrift) | wirtschaftlich Berechtigte | § 11 GwG |
| `gwg_risk_score` | Risikobewertung | § 10 GwG |

### 1.5 Bewegungsdaten

- `time_entry` — Zeiterfassung pro Mandant
- `audit_log` — Hash-versiegelte Änderungshistorie (siehe § 3)
- `phone_note` — Telefonnotizen
- `request` + `request_response` — Anforderungen + Antworten
- `document` + `document_version` — Belege, Verträge
- `invoice` + `invoice_position` — Rechnungen
- `power_of_attorney` — Vollmachten mit Signatur-Audit
- `tax_notice` — Steuerbescheide

---

## 2. Aufbewahrungsfristen

### 2.1 Gesetzliche Aufbewahrungsfristen

| Datenklasse | Frist | Quelle | Rechtsgrundlage |
|---|---|---|---|
| GoBD-Belege (Rechnungen, Verträge, Steuerbelege) | **10 Jahre** Mindestfrist | § 147 AO | Art. 6 (1) lit. c DSGVO i. V. m. § 147 AO |
| Geschäftsbriefe, sonstige Unterlagen | 6 Jahre Mindestfrist | § 147 AO | Art. 6 (1) lit. c DSGVO i. V. m. § 147 AO |
| Lohnunterlagen | 6 Jahre Mindestfrist | § 41 EStG | Art. 6 (1) lit. c DSGVO i. V. m. § 41 EStG |
| **GwG-Identifizierungs-Daten** (Ausweisbilder, wB-Daten) | **5 Jahre Höchstfrist** nach Geschäftsbeendigung | § 8 (4) GwG | Art. 6 (1) lit. c DSGVO i. V. m. § 8 GwG |
| GwG-Risikoanalysen | 5 Jahre | § 8 (4) GwG | Art. 6 (1) lit. c DSGVO i. V. m. § 8 GwG |
| Audit-Log + Hash-Chain | 10 Jahre | analog § 147 AO (Verfahrensintegrität) | Art. 6 (1) lit. f DSGVO (berechtigtes Interesse) + § 147 AO analog |

> ⚠ **§ 8 Abs. 4 GwG ist Höchst-, keine Mindestfrist.** Satz 4 verlangt
> EXPLIZIT „unverzügliche Vernichtung" nach Ablauf. Längere Aufbewahrung
> ist nach DSGVO Art. 5 Abs. 1 lit. e (Speicherbegrenzung) zusätzlich
> unzulässig. taxtronik trennt deshalb GwG-Bilder vom GoBD-Bucket ab
> (siehe technische Durchsetzung unten).

**Audit-Log-Rechtsgrundlage (B-2):** Der Audit-Log enthält personenbezogene
Daten (actor_id, ip, user_agent, optional before/after-Werte). Wir leiten die
10-Jahre-Aufbewahrung aus folgenden Grundlagen ab:

- § 147 AO analog: zur Sicherstellung der Verfahrensintegrität (siehe GoBD
  Rn. 102 ff. „Protokollierung"). Die Aufbewahrungsdauer entspricht der
  längsten anwendbaren Frist der protokollierten Geschäftsvorfälle.
- Art. 6 Abs. 1 lit. f DSGVO: berechtigtes Interesse der Kanzlei an
  Nachweisfähigkeit gegenüber Mandanten, Finanzverwaltung und Aufsichts-
  behörden. Interessenabwägung: minimaler personenbezogener Inhalt (nur
  actor_id + IP/User-Agent), kein Inhalt der Geschäftsvorfälle selbst, hohe
  Schutzfunktion für die Kanzlei und ihre Mandanten.

Die Kanzlei muss diese Begründung im eigenen Verzeichnis der Verarbeitungs-
tätigkeiten (Art. 30 DSGVO) entsprechend ausweisen.

**Audit-Log-Inhalts-Hygiene (B-3):** Der Audit-Log speichert pro Eintrag
optionale `before`/`after`-JSON-Felder. Die `evidenceService.record()`-
Aufrufe MÜSSEN sicherstellen, dass keine sensitiven Felder (passwordHash,
TOTP-Secret, OTP-Hash, Cookie-Token, Session-Token) in den Audit-Log
durchgereicht werden. Pre-Pen-Test-Pflicht-Check: alle Aufrufer von
`evidenceService.record({ before, after })` auf sensitive Felder durch-
sehen — siehe [pen-test-vorbereitung.md](./pen-test-vorbereitung.md).

**Technische Durchsetzung (B-1, Round 13):**

| Klassifikation | Bucket | Object-Lock | Retention |
|---|---|---|---|
| `GOBD_INVOICE`, `GOBD_CONTRACT`, `GOBD_TAX` | `gobd` | COMPLIANCE | 10 Jahre + 1 Tag (Jahresende-Logik, § 147 AO) |
| `GWG_EVIDENCE` | `gwg` (separat!) | COMPLIANCE | 5 Jahre + 1 Tag |
| `GENERAL`, `STAFF_PRIVATE` | jeweils eigener Bucket | — | kein Lock, Lifecycle nach Bedarf |

`GwgRetentionUntil()` ist in [`packages/storage/src/service.ts`](../../packages/storage/src/service.ts)
implementiert. Vor Round 13 lagen GwG-Bilder im `gobd`-Bucket mit
10-Jahre-COMPLIANCE — Bestandsdaten aus dieser Zeit MÜSSEN von der Kanzlei
nach Ablauf der 5-Jahre-GwG-Frist manuell gelöscht werden (Object-Lock
verhindert das im `gobd`-Bucket aktuell — Operations-Eskalation an Vendor
erforderlich, falls Bestandsdaten existieren).

### 2.2 Maximale Aufbewahrungsdauer (Löschung)

| Datenklasse | Max. Aufbewahrung | Trigger |
|---|---|---|
| `client_contact.lastLoginAt` | 2 Jahre nach letztem Login | Worker (TODO) |
| Inactive `staff_user` (deaktiviert) | 6 Jahre nach Deaktivierung | manuell durch Admin |
| `phone_note` | 3 Jahre | Worker (TODO) |
| Anforderungen + Antworten ohne GoBD-Bezug | 6 Jahre | Worker (TODO) |
| Notifications | 1 Jahr nach Erstellung | Worker (TODO) |
| `magic_link` (verbrauchte oder abgelaufene) | 30 Tage | direkt nach Verbrauch |

> Stand 2026-05-11: Die mit „TODO" markierten Worker sind noch nicht
> implementiert. Manuelle Löschung über DSGVO-Anfrage funktioniert.

---

## 3. Sonderfall Audit-Log (Hash-Chain)

Das `audit_log` ist:

- **Insert-only** durch DB-Trigger erzwungen
- **Hash-verkettet** (jeder Eintrag hängt am Vorgänger via SHA-256)
- **Tagesversiegelt** mit RFC-3161-TSA-Stempel

Daraus folgt für die DSGVO-Löschung:

- Einzelne Audit-Einträge **können nicht gelöscht werden**, ohne die
  Hash-Chain zu brechen
- **Pseudonymisierung** ist möglich: bei Betroffenen-Löschung werden in
  `audit_log.actor_id` und JSON-Inhalten (`before` / `after`) die
  personenbezogenen Werte durch generische IDs ersetzt — die Hash-Chain
  würde aber brechen
- **Akzeptierter Konflikt:** Aufbewahrungspflicht (GoBD/AO) hat im
  Steuerberater-Kontext Vorrang vor Art. 17 DSGVO (s. Art. 17 (3) b);
  betroffene Mitarbeiter werden im Vertrag darauf hingewiesen
- Nach Ablauf der gesetzlichen 10 Jahre wird das ganze `audit_log`-
  Segment gelöscht (jährliche Archiv-Rotation, noch nicht implementiert)

---

## 4. Betroffenenrechte — Umsetzung

### 4.1 Auskunft (Art. 15 DSGVO)

**Implementiert** als DSGVO-Modul (`/staff/admin/dsgvo`):

- Pro `client_contact` ein Datenexport als ZIP/JSON mit allen verlinkten
  Datenklassen
- Audit-Log-Einträge als CSV-Auszug (zugeordnet via `actor_id`)
- Aufruf: `GET /staff/admin/dsgvo` → neue Anfrage anlegen → Export-Action

### 4.2 Berichtigung (Art. 16)

- Stammdaten via Mandanten-Edit (`/staff/clients/[id]/edit`)
- Mandant kann eigene Notification-Setting im Portal ändern
- Berichtigung wird im Audit-Log mit `before`/`after` festgehalten

### 4.3 Löschung (Art. 17)

**Anonymisierung statt Löschung** (wegen Hash-Chain):

- `dsgvo.anonymize.contact`-Action setzt für `client_contact`:
  - `email` → `deleted-{id}@anon.taxtronik.local`
  - `fullName` → „Gelöschter Kontakt"
  - `active` → false
- Verknüpfte Daten (z. B. Vollmacht-Signaturen, Anforderungen) bleiben
  erhalten — die Person ist aber nicht mehr identifizierbar
- Audit-Log-Einträge: `actor_id` bleibt (UUID, kein Klartext-Bezug)

### 4.4 Einschränkung der Verarbeitung (Art. 18)

- `client_contact.active = false` setzt das Konto auf inaktiv (Login geblockt,
  keine neuen Mails) ohne Daten zu löschen
- Volle Sperrung würde via Tenant-Admin-Funktion erfolgen (manuell)

### 4.5 Datenübertragbarkeit (Art. 20)

- Datenexport via DSGVO-Modul liefert JSON in einem maschinenlesbaren Format
- Kein automatisierter Transfer zu Dritten — Mandant lädt herunter

### 4.6 Widerspruch (Art. 21)

- Mandant kann via Portal-Settings E-Mail-Benachrichtigungen abschalten
- Vollständiger Widerspruch gegen die Verarbeitung der GwG-Daten ist
  nicht möglich (Art. 21 (1) — gesetzliche Verarbeitungsgrundlage § 11 GwG)

---

## 5. Auftragsverarbeiter

Innerhalb von taxtronik werden folgende Auftragsverarbeiter eingesetzt:

| Anbieter | Zweck | AV-Vertrag |
|---|---|---|
| Hosting-Provider (durch Kanzlei gewählt) | Server-Betrieb | individuell |
| ClamAV (lokaler Container) | Virus-Scan | kein externer Drittanbieter |
| RFC-3161-TSA (z. B. D-Trust) | Audit-Versiegelung | Adapter konfigurierbar |
| n8n (lokaler Container) | Workflow-Automatisierung | kein externer Drittanbieter — **Achtung**: Sobald die Kanzlei n8n.cloud oder einen externen n8n-Server nutzt, wird n8n zum Auftragsverarbeiter (Art. 28 DSGVO) und ein AVV ist Pflicht. taxtronik gibt das Compose-Setup für lokales n8n vor; die Kanzlei muss eine bewusste Entscheidung treffen, wenn sie davon abweicht (B-4). |
| (Optional) eIDAS-QES-Provider | qualifizierte Signaturen | Adapter konfigurierbar |
| Mandanten-eigene Auftragsverarbeiter | im Verzeichnis `/staff/admin/dsgvo/providers` |

**Verzeichnis nach Art. 30 DSGVO** wird im Modul „Dienstleister (AVV)"
gepflegt.

---

## 6. Technisch-organisatorische Maßnahmen (Auszug)

### Vertraulichkeit

- Ende-zu-Ende-TLS (durch Reverse-Proxy)
- TOTP-Pflicht für alle Mitarbeiter
- Magic-Link (Single-Use, 30 min Gültigkeit) für Mandanten
- Postgres-RLS pro Tenant (Defense in Depth gegen App-Bugs)
- Cookie-Trennung Staff/Portal (kein Cross-Surface-Login)

### Integrität

- Hash-verketteter Audit-Log mit RFC-3161-Stempel
- ClamAV-Synchron-Scan auf jeden Upload
- DB-Trigger blocken UPDATE/DELETE auf `audit_log` und `audit_seal`
- SeaweedFS-Object-Lock COMPLIANCE für GoBD-Klassen

### Verfügbarkeit

- Tägliches Postgres-Dump + SeaweedFS-Sync
- Pre-Flight-Backup vor jeder Migration
- BackupRecord-Tabelle mit Status

### Belastbarkeit

- Worker-Pool für Hintergrund-Jobs (BullMQ + Redis)
- Health-Endpoint `/api/health`
- Strukturierte Logs (pino)

---

## 7. Datenschutz-Folgenabschätzung (DSFA)

**Notwendig nach Art. 35 DSGVO**, weil GwG-Daten besonders schutzbedürftig
sind (Identitätsmerkmale + Risikoeinschätzung).

Die DSFA ist NICHT Teil dieses Dokuments — sie wird pro Kanzlei
individuell durchgeführt mit Vorlagen aus dem Bereich „Steuerberater
+ DSGVO" (z. B. Vorlagen der Steuerberaterkammern).

---

## 8. Anhang — Mapping „Aktion → Daten-Auswirkung"

| Aktion | Tabellen geschrieben | Audit-Action |
|---|---|---|
| Mandant anlegen | `client` | `client.created` |
| Stammdaten bearbeiten (administrativ) | `client` | `client.update.administrative` |
| Stammdaten bearbeiten (GwG-relevant) | `client`, `gwg_check` (→ IN_REVIEW) | `client.update.gwg_relevant` |
| GwG-Onboarding-Submit | `client`, `gwg_check`, `gwg_beneficial_owner`, `gwg_id_document`, `document` | `gwg.onboarding.submit` |
| Dokument-Upload | `document`, `document_version` | `document.upload` |
| Rechnung erstellen | `invoice`, `invoice_position` | `invoice.create` |
| DSGVO-Auskunft | (read) | `dsgvo.export.contact` |
| DSGVO-Anonymisierung | `client_contact` (Felder anonymisiert) | `dsgvo.anonymize.contact` |
| Mandant deaktiviert (GwG abgelaufen) | `client.allowActive = false` | `gwg.expired` (Worker) |
