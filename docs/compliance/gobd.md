# GoBD-Verfahrensdokumentation taxtronik

Stand: 2026-06-10

Dieses Dokument beschreibt, wie taxtronik die Anforderungen der **Grundsätze
zur ordnungsmäßigen Führung und Aufbewahrung von Büchern, Aufzeichnungen und
Unterlagen in elektronischer Form sowie zum Datenzugriff** (BMF-Schreiben vom 28. November 2019, IV A 4 - S 0316/19/10003 :001 — „GoBD 2019") umsetzt.

Es ergänzt — ersetzt aber nicht — die kanzleieigene Verfahrensdokumentation
des einsetzenden Steuerberaters (§ 145 AO, GoBD Rn. 151 ff.). Die Kanzlei
bleibt für die geschäftsspezifische Verfahrensdokumentation verantwortlich;
taxtronik liefert die technische Grundlage.

---

## 1. Aufbewahrungsfristen (§ 147 AO)

§ 147 Abs. 3 AO: 10 Jahre für Bücher, Inventare, Bilanzen und die übrigen
buchführungsrelevanten Unterlagen. **BEG IV (seit 01.01.2025): Buchungsbelege
und Rechnungen nur noch 8 Jahre** (§ 147 Abs. 3 AO n.F., § 14b Abs. 1 UStG
n.F.). Handels-/Geschäftsbriefe: 6 Jahre. Beginn der Frist jeweils: **mit dem
Schluss des Kalenderjahres**, in dem die letzte Eintragung gemacht / der Beleg
empfangen worden ist.

**Implementierung**: `gobdRetentionUntilFor(classification)` in
[`packages/storage/src/service.ts`](../../packages/storage/src/service.ts)
setzt das Object-Lock-`ObjectLockRetainUntilDate` belegart-abhängig
(`GOBD_INVOICE` → 8 Jahre, sonst 10) als `Jahresende(JahrDerErstellung + N) + 1
Tag`. Damit landen alle Belege eines Kalenderjahres auf demselben
Aufbewahrungs-Stichtag; eine COMPLIANCE-Über-Aufbewahrung von Rechnungen
(Art. 5 Abs. 1 lit. e DSGVO) wird vermieden. Der frühere pauschale
`gobdRetentionUntil()` (10 Jahre) bleibt als konservativer Default erhalten.

**Geltungsbereich**:

- `DocumentClassification = GOBD_INVOICE | GOBD_CONTRACT | GOBD_TAX` werden
  in den Object-Lock-Bucket `gobd` mit COMPLIANCE-Mode geschrieben.
  Vor Ablauf der Retention sind Updates und Deletes von SeaweedFS
  hart-abgelehnt (auch für Owner-Credentials).
- `GWG_EVIDENCE` liegt in einem **eigenen Bucket `gwg`** mit Object-Lock
  **GOVERNANCE** und technischer 5-Jahres-Mindestbarriere
  (`gwgRetentionUntil()`); die Review-Queue ermittelt das tatsächliche
  ereignisabhängige Fristende nach § 8 Abs. 4 GwG. Details in [gwg.md](./gwg.md).
- Audit-Archive (siehe Abschnitt 3) werden in den `gobd`-Bucket gelegt.

**Nicht** unter Object-Lock fallen:

- `GENERAL` (Mandanten-Schriftwechsel, Formulare, Notizen) — kürzere
  Aufbewahrung über `retention_until` in der `document`-Tabelle abbildbar,
  aktuell nicht implementiert.
- `STAFF_PRIVATE` (Mitarbeiter-Ablage) — keine GoBD-Pflicht.

## 2. Unveränderbarkeit (§ 146 Abs. 4 AO, GoBD Rn. 58 ff.)

> „Eine Buchung oder eine Aufzeichnung darf nicht in einer Weise verändert
> werden, dass der ursprüngliche Inhalt nicht mehr feststellbar ist."

**Drei-Schichten-Schutz**:

1. **Object-Lock COMPLIANCE** im S3-kompatiblen Storage (SeaweedFS).
   Datei-Inhalt ist physisch nicht überschreibbar/löschbar bis zum
   Retain-Until-Datum.
2. **Hash-Chain in `audit_log`** (siehe [`packages/evidence/`](../../packages/evidence)):
   jeder Schreibvorgang erzeugt einen SHA-256-Hash über
   `prev_hash || canonical_json(event)`. Postgres-Trigger blocken UPDATE,
   DELETE und TRUNCATE auf `audit_log`, `audit_seal`, `audit_archive`.
3. **Tägliche Versiegelung** via RFC-3161-Zeitstempel (`evidence-seal`-
   Worker um 02:30 UTC). Top-Hash des Tages wird extern signiert; Restore
   aus älterem Backup würde den nachträglichen Stempel offenbaren.

**Verifikation**:

- `pnpm verify:chain` rechnet die komplette Kette pro Tenant nach,
  prüft jeden TSA-Stempel und re-hashed jeden Archive-Eintrag (U-4).
- **Täglicher automatischer Lauf** über `audit-verify-check`-Worker um
  02:45 UTC (siehe [`apps/worker/src/scheduler.ts`](../../apps/worker/src/scheduler.ts)).
  Bei Hash-Bruch wird eine `SYSTEM_AUDIT_BREAK`-Notification an alle
  ADMIN/PARTNER versendet (idempotent pro `auditId`).
- Das Prüf-Ergebnis wird persistiert (`tenant_setting`-Key
  `audit_verify_result`) und auf `/staff/admin/audit` angezeigt; der
  „Jetzt prüfen"-Button stößt dort einen neuen Verifikationslauf als
  Hintergrund-Job an (kein Chain-Hashing im Render-Pfad).

## 3. Audit-Trail (GoBD Rn. 102 ff., „Protokollierung")

Jede sicherheitsrelevante Mutation schreibt einen `audit_log`-Eintrag mit
Feldern: `actor_type`, `actor_id`, `action`, `resource_type`, `resource_id`,
`before`, `after`, `ip`, `user_agent`, `prev_hash`, `this_hash`.

`ip` und `user_agent` sind forensisches Beiwerk und gehen NICHT in den
Hash ein (R-3 / H-2).

**Wartung**:

- Wöchentliche Auslagerung in NDJSON-Segmente (`audit-rotate`-Worker
  sonntags 03:00 UTC, manueller Trigger unter `/staff/admin/archive`).
  Aktuell nur SOFT-Rotation (Datei wird geschrieben, DB bleibt).
  HARD-Rotation (DB-Cleanup) ist nicht implementiert — der Audit-Log
  wächst monoton. Ein konfiguriertes `AUDIT_ARCHIVE_MODE=HARD` wird beim
  Lesen ehrlich auf SOFT normalisiert und pro Lauf als Warnung geloggt,
  damit `audit_archive` keinen DB-Cleanup behauptet, der nie stattfand.

## 4. Lesbarmachung und Datenzugriff (§ 147 Abs. 6 AO)

- **DATEV-Belege-Export** ([`apps/web/.../datev-belege-export/route.ts`](../../apps/web/src/app/api/staff/clients/[id]/datev-belege-export/route.ts)):
  ZIP mit Original-Dateien + `index.csv` (DATEV-kompatible Begleitliste)
  - `manifest.txt`. SHA-256 jedes Belegs in `index.csv` für nachträgliche
    Integritätsprüfung. Hard-Cap 1 GB (T-4); größere Mandanten-Exporte
    benötigen Datums-Eingrenzung.
- **Verify-CLI** für Wirtschaftsprüfer: `pnpm verify:chain` (s. o.).

Diese beiden Funktionen sind **kein vollständiger Z1-/Z2-/Z3-Nachweis**.
Insbesondere existiert derzeit kein dedizierter Nur-Lese-Prüferzugang und kein
vollständiger Export aller aufzeichnungs- und aufbewahrungspflichtigen Daten
einschließlich der für eine maschinelle Auswertung erforderlichen Struktur-
und Verknüpfungsinformationen. Die Kanzlei muss den verlangten Datenzugriff
mit der Finanzverwaltung, dem Vorsystem und gegebenenfalls einem beauftragten
Dritten für den konkreten Prüfungsumfang organisieren.

## 5. Schnittstellen / Datensicherheit

- Authentifizierung: Staff mit Passwort + TOTP-Pflicht; Mandanten mit
  Magic-Link (Single-Use, kein zweiter Faktor im Portal).
- Backups: täglicher Postgres-Dump in den S3-Backup-Bucket durch den Worker
  sowie eine zusätzliche lokale Operator-Kopie bei `./taxtronik backup` via
  [`backup/runner.ts`](../../apps/web/src/server/backup/runner.ts)
  (auditiert als `backup.run`). SHA-256 jedes Dumps in
  `BackupRecord.sha256`; Restore
  verifiziert diesen Hash vor pg_restore (P-6). Der SeaweedFS-Inhalt
  selbst wird von der App NICHT mitgesichert (siehe nächster Punkt).
- Off-Site-Replikation des `gobd`-Buckets: NICHT Teil von taxtronik.
  Operator muss separat eine S3-Replikation einrichten (z. B. SeaweedFS
  Filer-Replication oder externes Tool wie restic/borg).

## 6. Was die Kanzlei selbst dokumentieren muss

- Welche Mandanten-Belege werden mit welcher `DocumentClassification`
  klassifiziert und kommen damit unter Object-Lock?
- Wer ist Custodian/Administrator für die taxtronik-Installation
  (technisch + organisatorisch)?
- Backup-Frequenz und Off-Site-Replikations-Strategie.
- Wiederanlauf-Verfahren nach Disaster (siehe
  [`docs/operations/disaster-recovery.md`](../operations/disaster-recovery.md)).
- TSA-Wahl (siehe [`eidas-tsa.md`](./eidas-tsa.md)) und Vertragsbeziehung
  mit dem TSA-Provider.
