# DSGVO — Lösch-, Aufbewahrungs- und Verarbeitungskonzept

Stand: 2026-06-10. Dieses Dokument beschreibt für taxtronik:

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
| `GWG_EVIDENCE` | `gwg` (separat!) | **GOVERNANCE** | 5 Jahre + 1 Tag |
| `GENERAL`, `STAFF_PRIVATE` | jeweils eigener Bucket | — | kein Lock, Lifecycle nach Bedarf |

**Warum GOVERNANCE statt COMPLIANCE für GwG?** COMPLIANCE lässt sich vor
Ablauf von niemandem (auch nicht root) verkürzen — damit wäre die von
§ 8 Abs. 4 Satz 4 GwG geforderte UNVERZÜGLICHE Vernichtung nach Ende der
Geschäftsbeziehung technisch nicht erfüllbar (Konflikt mit Art. 5 Abs. 1
lit. e DSGVO). GOVERNANCE erlaubt die privilegierte Frühlöschung
(`s3:BypassGovernanceRetention`); für alle ohne dieses Recht bleibt die
fristgebundene Unveränderbarkeit erhalten. GoBD-Klassen bleiben COMPLIANCE
(keine Frühlöschung vorgesehen). Siehe `lockModeForTier()` in
[`packages/storage/src/service.ts`](../../packages/storage/src/service.ts).

`gwgRetentionUntil()` ist in [`packages/storage/src/service.ts`](../../packages/storage/src/service.ts)
implementiert. Vor Round 13 lagen GwG-Bilder im `gobd`-Bucket mit
10-Jahre-COMPLIANCE — Bestandsdaten aus dieser Zeit MÜSSEN von der Kanzlei
nach Ablauf der 5-Jahre-GwG-Frist manuell gelöscht werden (Object-Lock
verhindert das im `gobd`-Bucket aktuell — Operations-Eskalation an Vendor
erforderlich, falls Bestandsdaten existieren).

### 2.2 Maximale Aufbewahrungsdauer (Löschung)

| Datenklasse | Max. Aufbewahrung | Trigger |
|---|---|---|
| `client_contact.lastLoginAt` | 2 Jahre nach letztem Login | Worker `dsgvo-retention` (täglich 04:00 UTC) — Feld wird genullt |
| Inactive `staff_user` (deaktiviert) | 6 Jahre nach Deaktivierung | manuell durch Admin |
| `phone_note` | 3 Jahre | Worker `dsgvo-retention` (täglich 04:00 UTC) |
| Anforderungen + Antworten ohne GoBD-Bezug | 6 Jahre (10 J. mit GoBD-Bezug) | Worker `dsgvo-retention` (täglich 04:00 UTC) |
| Notifications | 1 Jahr nach Erstellung | Worker `dsgvo-retention` (täglich 04:00 UTC) |
| `magic_link` (verbrauchte oder abgelaufene) | 30 Tage | direkt nach Verbrauch |
| GwG-Belege + GwG-Aufzeichnungen beendeter Mandate | Mandatsende-Jahresende + 5 Jahre (§ 8 (4) GwG) | Review-Queue `/staff/admin/gwg-retention` — Vernichtung wird vom Berufsträger bestätigt (kein Auto-Delete); Worker `gwg-expiry-check` schickt täglich eine idempotente `GWG_DELETION_DUE`-Notification an ADMIN/PARTNER, sobald Einträge löschreif sind. Details in [gwg.md](./gwg.md) |
| Mandanten-Stammdaten natürlicher Personen (`client`, `kind = NATPERS`) beendeter Mandate | Mandatsende-Jahresende + **10 Jahre** (längste Frist gewinnt: GoBD 10 J. § 147 AO > GwG 5 J. § 8 (4)) | Review-Queue `/staff/admin/dsgvo-retention` — Anonymisierung wird vom Berufsträger bestätigt (kein Auto-Anonymisieren). Name/Adresse/USt-ID/Notizen/DATEV-Addison-Nr. werden genullt, Custom-Feld-Werte gelöscht, verknüpfte `client_contact`s mit-anonymisiert. Skelett-Datensatz mit Vernichtungsvermerk (`client.anonymized_at`) bleibt. Vorbedingung: GwG-Belege/-Aufzeichnungen des Mandanten sind bereits vernichtet (GwG-Queue). Fristlogik: [`apps/web/src/server/dsgvo/client-retention.ts`](../../apps/web/src/server/dsgvo/client-retention.ts) |

> Stand 2026-05-29: Der Worker `dsgvo-retention`
> ([apps/worker/src/jobs/dsgvo-retention.ts](../../apps/worker/src/jobs/dsgvo-retention.ts))
> setzt Notifications-, Phone-Note-, lastLoginAt- UND Anforderungs-Retention
> automatisch durch.
>
> **GoBD-Bezug bei Anforderungen**: Ein Request gilt als GoBD-bezogen, sobald
> eine Antwort ein Dokument mit `documentType.tier = GOBD` bzw. `classification`
> `GOBD_*` referenziert — dann greift die 10-Jahres-Frist (§ 147 AO) statt der
> 6-Jahre-DSGVO-Minimierung. Beim Löschen werden die losen Rückverweise
> `tax_deadline.request_id` und `form_submission.request_id` in derselben
> Transaktion genullt; referenzierte Dokumente bleiben (eigene Object-Lock-
> Retention).

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
- Segmente werden wöchentlich als NDJSON in den Object-Store archiviert
  (`audit-rotate`, SOFT-Rotation). Die Löschung der DB-Einträge nach
  Ablauf der gesetzlichen 10 Jahre (HARD-Rotation) ist noch nicht
  implementiert — der Audit-Log wächst monoton (siehe gobd.md § 3)

---

## 4. Betroffenenrechte — Umsetzung

### 4.1 Auskunft (Art. 15 DSGVO)

**Implementiert** als DSGVO-Modul (`/staff/admin/dsgvo`),
`exportContactDataAction` in
[`apps/web/src/app/staff/(protected)/admin/dsgvo/actions.ts`](<../../apps/web/src/app/staff/(protected)/admin/dsgvo/actions.ts>):

- Pro `client_contact` ein **JSON-Export** mit folgenden Datenklassen:
  - Kontakt-Stammdaten (E-Mail, Name, Mandant, Anlage-/Login-Zeitpunkte)
  - Anforderungs-Antworten der Person (`request_response`)
  - **Dokument-Metadaten** der Dokumente, die dem Kontakt über den
    Audit-Trail direkt zugeordnet sind (Upload, Antwort) — bewusst NICHT
    alle Dokumente des Mandanten (bei mehreren Kontakten würden sonst
    Daten Dritter mit exportiert)
  - Vollmachten (`power_of_attorney`, via Signer-FK oder E-Mail-Match)
  - Terminanfragen (`appointment_request`)
  - Formular-Antworten (`form_submission` — die selbst eingegebenen
    Antworten, Art.-20-relevant)
  - Telefonnotizen (`phone_note`) per Heuristik „gleicher Mandant +
    Anrufername = Kontaktname" — kann Namensgleiche treffen bzw.
    abweichende Schreibweisen verfehlen; der Sachbearbeiter prüft den
    Export vor Herausgabe
  - Anzahl der Magic-Link-Anforderungen
- **Keine Datei-Downloads** im Export — Dokumente sind nur als Metadaten
  enthalten (Titel, Klassifikation, Datum); die Dateien selbst gibt die
  Kanzlei bei Bedarf separat heraus
- Audit-Log-Einträge der Person werden nicht inline gedumpt — der Export
  verweist auf den **Audit-CSV-Export** (`/api/staff/admin/audit/export`,
  Filter auf Akteur/Ressource = Kontakt)
- Jeder Export wird selbst auditiert (`dsgvo.export.contact`)

### 4.2 Berichtigung (Art. 16)

- Stammdaten via Mandanten-Edit (`/staff/clients/[id]/edit`)
- Mandant kann eigene Notification-Setting im Portal ändern
- Berichtigung wird im Audit-Log mit `before`/`after` festgehalten

### 4.3 Löschung (Art. 17)

**Anonymisierung statt Löschung** (wegen Hash-Chain):

- `dsgvo.anonymize.contact`-Action setzt für `client_contact`:
  - `email` → `anonymized-<uuid>@taxtronik.local`
  - `fullName` → „Anonymisiert"
  - `active` → false
- Zusätzlich werden offene Magic-Links der Person ungültig gemacht und
  alle aktiven Portal-Sessions sofort revoked
- Verknüpfte Daten (z. B. Vollmacht-Signaturen, Anforderungen) bleiben
  erhalten — die Person ist aber nicht mehr identifizierbar
- Audit-Log-Einträge: `actor_id` bleibt (UUID, kein Klartext-Bezug)

**Mandanten-Anonymisierung nach Fristablauf** (Klasse „Mandant", `client`):

- Gilt für natürliche Personen (`kind = NATPERS`) — bei juristischen
  Personen/Personengesellschaften sind die Firmen-Stammdaten keine
  personenbezogenen Daten; deren Ansprechpartner bleiben über die
  Contact-Anonymisierung oben einzeln anonymisierbar
- Trigger: Mandatsende + Ablauf ALLER Aufbewahrungsfristen (längste gewinnt:
  GoBD 10 J. ab Jahresende > GwG 5 J., siehe § 2.2) — vorher hat die
  Aufbewahrungspflicht Vorrang (Art. 17 (3) b)
- Review-Queue `/staff/admin/dsgvo-retention` (ADMIN/PARTNER), Bestätigung
  durch den Berufsträger mit Zwei-Schritt-Dialog — kein Auto-Anonymisieren
- `confirmClientAnonymizationAction` setzt: `name` → „Anonymisiert";
  `street`/`postalCode`/`city`/`countryIso`/`vatId`/`invoiceEmail`/
  `internalNotes`/`datevNo`/`addisonNo` → null; `allowActive` → false;
  Custom-Feld-Werte (`client_custom_field_value`) werden gelöscht;
  verknüpfte `client_contact`s werden mit-anonymisiert (geteilte Logik,
  inkl. Magic-Link-Invalidierung + Session-Revocation)
- Skelett-Datensatz bleibt: `id`, `kind`, `mandateEndedAt` und
  `anonymizedAt` als Vernichtungsvermerk (Nachweis, DASS anonymisiert wurde)
- Vorbedingung: GwG-Belege/-Aufzeichnungen des Mandanten sind bereits über
  die GwG-Queue vernichtet (eigene Vernichtungs-Semantik + Nachweise)
- Audit-Event `client.anonymize` — bewusst nur Zähler, keine Personendaten
  (die Hash-Chain ist insert-only; nach Fristablauf werden keine
  Personendaten erneut hineingeschrieben)

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
- SeaweedFS-Object-Lock: COMPLIANCE für GoBD-Klassen, GOVERNANCE für
  GwG-Belege (siehe § 2.1)

### Verfügbarkeit

- Postgres-Dump in den S3-Backup-Bucket via Operator-Cron bzw. manuell
  (`scripts/backup.sh` / `pnpm --filter @taxtronik/web backup:run`);
  jeder Lauf wird auditiert (`backup.run`) und als `BackupRecord` mit
  Status + SHA-256 erfasst, die Admin-Übersicht zeigt den letzten Stand.
  Kein automatischer SeaweedFS-Sync durch die App — die Off-Site-
  Replikation des Object-Stores ist Operator-Aufgabe (siehe gobd.md § 5)
- Pre-Flight-Backup vor jeder Migration (`scripts/update.sh`)

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
| Mandant anonymisiert (Art. 17, nach Fristablauf) | `client` (Stammdaten genullt + `anonymized_at`), `client_custom_field_value` gelöscht, `client_contact` anonymisiert | `client.anonymize` |
| Mandant deaktiviert (GwG abgelaufen) | `client.allowActive = false` | `gwg.expired` (Worker) |
| GwG-Datei-Beleg vernichtet (§ 8 (4)) | `document` + `document_version` gelöscht, Bytes vernichtet | `gwg.evidence.destroy` |
| GwG-Aufzeichnungen vernichtet (§ 8 (4)) | `gwg_beneficial_owner` gelöscht, `gwg_id_document` genullt, `gwg_check` anonymisiert + `destroyedAt` | `gwg.check.destroy` |
