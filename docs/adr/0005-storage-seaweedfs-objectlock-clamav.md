# ADR 0005 — Object-Storage: SeaweedFS + Object-Lock COMPLIANCE + ClamAV

**Status**: Akzeptiert (Iteration 1, **MinIO ersetzt 2026-05-12**)
**Datum**: 2026-05-10 (ursprünglich) · **2026-05-12** (SeaweedFS-Wechsel)
**Kontext**: GoBD-pflichtige Dokumente (Rechnungen, Verträge, Steuer-Belege)
müssen 10 Jahre unveränderbar gespeichert werden. Ein-Datei-Pro-Storage
würde GwG/DSGVO-Anforderungen unterlaufen (z. B. selektive Löschung
auskunftspflichtiger Datensätze).

## Entscheidung

**SeaweedFS** als S3-API-kompatibler On-Premise-Object-Store mit Object-Lock
COMPLIANCE-Mode. Single-Node-Setup (Master + Volume + Filer + S3 in einem
Container) für die Kanzlei-Größenordnung (10–500 Mitarbeiter); Multi-Node
ist später ohne API-Bruch möglich.

- Image: `chrislusf/seaweedfs:latest`, Apache-2.0
- Ports: 8333 (S3-API), 9333 (Master), 8888 (Filer-UI)
- S3-Credentials in `infra/scripts/seaweedfs-s3.json` (für Dev plain; in
  Produktion wird der Container mit Secrets gemountet)

Fünf Buckets — angelegt vom `seaweedfs-init`-Container über die AWS-CLI
(Stand der ursprünglichen Entscheidung; aktueller Stand siehe Addendum):
- `gobd` mit Object-Lock-Mode `COMPLIANCE` und Default-Retention 10 Jahre
- `general` (transiente Anhänge, KB-Bilder)
- `staff-private` (Mitarbeiter-Ablage, mit Versionierung)
- `quarantine` (Upload-Stage, 30-Tage-Lifecycle)
- `backups` (Postgres-Dumps + Audit-Archive, 90-Tage-Lifecycle)

**Upload-Flow** (Defense-in-Depth, unverändert zum MinIO-Setup):
1. Browser holt Presigned-PUT-URL für `quarantine`
2. Browser PUTet die Datei direkt zum Object-Store
3. App-Endpoint `commit`:
   a. Lädt Datei aus Quarantine
   b. Sendet sie an ClamAV via TCP-INSTREAM
   c. Bei `INFECTED`: Datei löschen, 422 zurück
   d. SHA-256 berechnen
   e. Upload nach Ziel-Bucket (mit `ObjectLockMode: COMPLIANCE` für GoBD)
   f. Original aus Quarantine löschen
   g. `document_version`-Insert mit `immutable: true` (Trigger blockt Updates)
   h. Audit-Log-Eintrag (hash-gechained)

## Warum nicht mehr MinIO

- **License-Drift**: MinIO ist mit Version 2025-Q4 von Apache-2.0 in Teilen
  auf AGPL-3.0 gewechselt; Bucket-Replikation, Site-Replication und Lifecycle-
  Management sind in der Community-Version 2025 schrittweise entfernt /
  hinter „Enterprise" gestellt worden.
- **EOL-Risiko**: Die freie Variante wird perspektivisch nicht mehr aktiv
  weiterentwickelt, Sicherheitsupdates sind unsicher.
- **On-Prem-Kanzleien** brauchen einen Object-Store, den sie ohne kommerzielle
  Lizenzverhandlung dauerhaft betreiben können — SeaweedFS erfüllt das mit
  stabiler Apache-2.0-Lizenz und seit 2024 produktivem Object-Lock-Support.

## Konsequenzen

**Vorteile**
- Lizenzklar (Apache-2.0), kein Vendor-Lock-in
- Single-Binary-Architektur — eine Container-Instanz statt MinIO + mc + Konsole
- Object-Lock-COMPLIANCE: nicht einmal der Storage-Admin kann GoBD-Dateien
  löschen. Der einzige Weg ist Bucket-Destruction (= Total-Loss)
- Zwei-Phasen-Upload (Quarantine → Target) verhindert „infizierter Upload
  überschreibt sauberes Dokument"
- Presigned-URL = App muss nicht 100MB-Streams puffern
- Identische S3-API zur AWS — der Code in `packages/storage` ist
  Anbieter-agnostisch (AWS SDK + `forcePathStyle: true`)

**Nachteile**
- Keine Web-Konsole wie MinIO Console — Verwaltung via Filer-UI (8888) oder
  AWS CLI. Für unsere Buckets-as-Code-Logik ist das ok.
- SeaweedFS-Object-Lock seit 3.59 (12/2023) stabil, aber jünger als MinIO —
  Edge-Cases bei concurrent retention-changes weniger gut dokumentiert
- Setup-Init braucht `amazon/aws-cli:latest` als Init-Container (statt `mc`)

## Alternativen verworfen

- **RustFS** (Apache-2.0, Rust): sehr neu (v1.0 Ende 2024), Object-Lock noch
  in Beta-Phase — höheres Risiko für GoBD-Compliance-Pfad
- **Garage** (AGPL): Object-Lock auf Roadmap, noch nicht stabil; AGPL macht
  Lizenz-Sorgen für Kanzleien
- **AWS S3** (verboten: GoBD verlangt Verfügungsgewalt im Inland; zudem ist
  on-premise eine User-Vorgabe)
- **Direktes Filesystem** (kein Object-Lock möglich, keine Lifecycle-Policies)
- **VirusTotal API** (kein PII-Upload zu Externen erlaubt)

## Migration aus bestehendem MinIO

Für Kanzleien, die schon Daten in MinIO haben:

```bash
# 1. Beide Stacks parallel hochfahren
docker compose up -d minio seaweedfs

# 2. Sync via rclone (Object-Lock auf SeaweedFS muss vorher aktiv sein)
rclone copy minio-source: seaweed-dest: --progress

# 3. App-ENV S3_ENDPOINT umschalten, App neustarten
# 4. MinIO-Container abschalten und Volume archivieren (90 Tage Aufbewahrung)
```

Im Dev reicht `docker compose down -v && ./scripts/setup.ps1` (zerstört alle
Daten — nur in Test-Umgebungen).

## Addendum (2026-06-10)

Zwei Punkte der ursprünglichen Entscheidung sind inzwischen überholt:

1. **Sechster Bucket `gwg`** (B-1): `GWG_EVIDENCE` liegt nicht mehr im
   `gobd`-Bucket, sondern in einem eigenen Bucket `gwg` mit Object-Lock-Mode
   **GOVERNANCE** und 5 Jahren Retention. Grund: § 8 Abs. 4 GwG ist eine
   Höchstfrist mit Vernichtungspflicht — COMPLIANCE würde die geforderte
   unverzügliche Vernichtung nach Mandatsende technisch verhindern;
   GOVERNANCE erlaubt die privilegierte Frühlöschung
   (`s3:BypassGovernanceRetention`). Siehe `lockModeForTier()` in
   `packages/storage/src/client.ts`/`service.ts` und
   [docs/compliance/gwg.md](../compliance/gwg.md).
2. **Kein Browser-Presigned-PUT mehr**: Uploads und Downloads laufen
   vollständig **app-proxied** — der Object-Store hängt nur am internen
   Docker-Netz und ist nie öffentlich erreichbar (§ 203 StGB, minimale
   Angriffsfläche on-prem). Der im Upload-Flow oben beschriebene Schritt
   „Browser PUTet direkt zum Object-Store" und der Vorteil „Presigned-URL =
   App muss nicht puffern" gelten nicht mehr; die App streamt die Datei in
   den Quarantine-Bucket und committet danach (Scan → Hash → Ziel-Bucket,
   unverändert). Siehe Kommentar in `packages/storage/src/client.ts`.
