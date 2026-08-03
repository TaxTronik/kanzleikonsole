# Architektur

Dieses Dokument fasst die Architektur von taxtronik zusammen. Operative Details,
Feature-Stand und Release-Prozess stehen in `README.md`, `FEATURES.md` und
`docs/operations/`.

## Stack im Überblick

```
        ┌────────────────────────────────────────────────┐
        │  Browser (Mitarbeiter / Mandant)               │
        └───────────────┬────────────────────────────────┘
                        │ HTTPS
        ┌───────────────▼────────────────────────────────┐
        │  app  (Next.js 16 — UI + API + Server Actions) │
        └─┬──────┬──────┬──────────┬─────────┬───────────┘
          │      │      │          │         │
       Postgres  Redis  SeaweedFS ClamAV    n8n          Risk-Layer
       (RLS)    (BullMQ) (Object  (Virus-   (Workflows)  (TCMS / /v1)
                          Lock)   Scan)
                ▲                            │            ▲
                │                            │ HMAC       │ Bearer
                │                            ▼            │
        ┌───────┴────────────────────────────────────────┐
        │  worker (Node + BullMQ)                        │
        │  - Hash-Chain-Versiegelung (täglich, RFC-3161) │
        │  - Chain-Verify + Audit-Archiv-Rotation        │
        │  - Fristen-/Ablauf-Checks (GwG, PoA, Termine)  │
        │  - Reminder, RSS, DSGVO-Retention, n8n-Outbox  │
        │  - tägliche S3-DB-Backups + Restore-Drill      │
        │  - Infrastruktur-Health und Ops-Alarme         │
        └────────────────────────────────────────────────┘

        (Virus-Scan läuft SYNCHRON beim Upload-Commit in der App —
        packages/storage — nicht als Worker-Job.)
```

## Kern-Prinzipien

1. **Identitätstrennung Mitarbeiter vs Mandant** — zwei separate Tabellen,
   zwei Auth.js-Instanzen und getrennte Cookie-Namen. Die Cookies verwenden
   aus Sicherheitsgründen `Path=/`; die jeweilige Auth-Surface liest nur ihren
   eigenen Cookie. Siehe ADR 0003 und 0010.

2. **Doppelte Verteidigung Mandanten-Trennung** — App-Level-Filter UND
   Postgres-RLS. Siehe ADR 0002.

3. **Manipulationsevidenz via Hash-Chain + RFC-3161** — jede compliance-
   relevante Schreiboperation landet in `audit_log`, hash-verkettet pro Tenant.
   Worker versiegelt täglich den Tages-Spitzen-Hash mit RFC-3161. Verifikation
   per CLI (`pnpm verify:chain`).

4. **n8n für konfigurierbare Automation, Code für Kernkontrollen** — optionale
   Kommunikations-, Recherche- und Eskalationsstrecken können über die
   HMAC-signierte n8n-Outbox laufen. Fachliche Fristen-, Retention-, Audit- und
   Backup-Jobs laufen im BullMQ-Worker; transaktionale Basismails kann die App
   selbst per SMTP versenden.

5. **Externe Integrationen kontrolliert anbinden** — DATEV und
   Transparenzregister haben derzeit keine direkte Produktiv-API-Anbindung;
   verfügbar sind Export-/manuelle Ablagepfade. ELSTER besitzt eine
   feature-gesteuerte Vorstufe über eine private `eric-bridge`, aber keine
   mitgelieferte amtliche ERiC-Laufzeit oder öffentliche ELSTER-Spezifikation.

6. **GwG-Schranke systemisch** — DB-Trigger und App-Guards blockieren
   aktivierungsabhängige Folgeoperationen, solange `client.allow_active = false`.
   Ein Mandant kann und muss zunächst inaktiv angelegt werden; die Freigabe
   folgt aus einem verifizierten `gwg_check`.

7. **Risk-Layer als internes Backend** — die TCMS-/Subsumtions-Engine ist opt-in,
   zustandslos und wird über `RISK_LAYER_URL` + Bearer-Token angesprochen. Diese
   URL ist Operator-Konfiguration und darf Docker-Service-DNS, Loopback oder eine
   interne IP sein; nutzerkonfigurierbare externe Fetches bleiben weiterhin beim
   zentralen SSRF-Guard.

8. **Drei Stufen im Subsumtions-Space** — der Zugriff auf eine Analyse ist
   abgestuft, durchgesetzt serverseitig in jeder Server Action (nicht durch
   Ausblenden in der UI):
   - _Lesen_ — jede Person mit Mandantenzugriff (`canAccessClient`).
   - _Schreiben_ — Admin/Partner oder zugeordnete Berufsträger:innen bzw.
     Hauptbearbeiter:innen (`canWriteClientTx`).
   - _Recherche_ — wer eine einzelne Markierung zugewiesen bekam, darf genau
     dort recherchieren und Ergebnisse prüfen, sonst nichts.

   Zusätzlich kann eine Analyse als **vertraulich** gekennzeichnet werden
   (`RiskAnalysis.vertraulich`). Dann sieht, wer nur zugewiesen ist, statt des
   Sachverhalts ausschliesslich die eigenen Textstellen — mit auf den gekürzten
   Text umbasierten Offsets (`lib/subsumtion-redaction.ts`). Die Grenze gilt an
   allen Austrittsstellen: Analyse-Seite, abgeleitete Recherche-Daten, der
   Sachverhalt-Auszug im KI-Auftrag (Kontext-Padding fällt auf 0) und der
   DOCX/PDF-Report (403 statt gekürzter Fassung, da ein Report mit anderem
   Textbestand als Report irreführend wäre).

## Repositorystruktur

Siehe README.md für die vollständige Folder-Übersicht.

## Compliance-Mapping

| Anforderung                                    | Wo umgesetzt                                                                                                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| § 203 StGB Berufsgeheimnis / Mandantentrennung | RLS-Policies in `packages/db/prisma/migrations/.../migration.sql`; `withTenantContext` in `packages/db/src/tenant-context.ts`                                                                                                    |
| GoBD Unveränderlichkeit                        | SeaweedFS Object-Lock (Bucket `gobd`, COMPLIANCE-Mode, typabhängig 6/8/10 Jahre; Bucket `gwg`, GOVERNANCE-Mode plus fachliche Retention-Queue); `document_version.immutable` mit DB-Trigger; `audit_log` insert-only mit Trigger |
| GoBD Nachvollziehbarkeit                       | Hash-verkettetes `audit_log` (`packages/evidence/src/service.ts`)                                                                                                                                                                |
| GoBD Aufbewahrungsfrist                        | `document.retention_until` plus Object-Lock-Retention pro Schutzstufe                                                                                                                                                            |
| DSGVO Löschung, Auskunft und Zugriffstrennung  | Retention-/Anonymisierungsjobs, Kontakt-Datenexport und RLS-/App-Level-Tenant-Gates; siehe `docs/compliance/dsgvo-konzept.md`                                                                                                    |
| GwG Identifizierungspflicht                    | `gwg_check`-Tabelle + GwG-Onboarding-Wizard (Selbst-Identifizierung des Mandanten); Transparenzregister-Auszug als Dokumenttyp `TRANSPARENZREGISTER_AUSZUG` manuell ablegbar (kein Excel-Import, kein Registerabruf)             |
| GwG Risikoanalyse                              | `gwg_risk_score`, regelbasierte Engine, Gewichtungen pro Kanzlei                                                                                                                                                                 |
| GwG Vorgangs-Block                             | DB-Trigger auf `client.allow_active = false` plus App-Guard                                                                                                                                                                      |
| GwG Vernichtungspflicht (§ 8 Abs. 4)           | Review-Queue `/staff/admin/gwg-retention` für Datei-Belege + DB-Aufzeichnungen, tägliche `GWG_DELETION_DUE`-Notification (siehe `docs/compliance/gwg.md`)                                                                        |
| Elektronische Vollmachten                      | Magic-Link + E-Mail-Code, explizite Inhaltsbestätigung und gebundener Versand-Snapshot (ADR-0009); keine Produktzusage als AES/QES, qualifizierter Anbieter nicht implementiert                                                  |

## Querverweise

- ADR 0001: Monorepo-Setup
- ADR 0002: RLS und App-Level-Tenancy
- ADR 0003: Zwei Auth-Surfaces
- ADR 0004: Evidence-Chain mit RFC-3161
- ADR 0005: Storage (SeaweedFS, Object-Lock, ClamAV) — inkl. Addendum
  `gwg`-Bucket + app-proxied Uploads
- Vollständige Liste: [docs/adr/README.md](adr/README.md)
