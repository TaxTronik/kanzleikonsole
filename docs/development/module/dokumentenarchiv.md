# Technische Modulbeschreibung: Dokumentenarchiv

## Zweck

Revisionssichere Ablage aller Mandanten- und Kanzlei-Dokumente mit
Schutzstufen (GoBD/GwG/ohne), Versionierung, Virenscan vor Annahme und
kontrollierter Mandanten-Freigabe.

## Datenmodell

`Document` (Titel, Typ/Klassifikation, clientId optional, Freigabe
`sharedWithClientAt`, Soft-Delete-Felder) → `DocumentVersion` (bucket/key,
SHA-256, Größe, `immutable`, Scan-Status; unique je documentId+versionNo) →
`DocumentFolder` (Baum; Löschen reparentiert, nie kaskadierend) →
`DocumentType` (Admin-gepflegt; Schutzstufe und bei GoBD die 6-/8-/10-
Jahresfrist bei Anlage fixiert, 7 Kern-Typen read-only).

## Programminterne Kontrollen

| Kontrolle          | Umsetzung                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Annahme-Pipeline   | zentral `packages/storage/src/service.ts`: ClamAV-Scan **synchron vor** jedem Upload (INFECTED→422, Scanner-Fehler→502, fail-closed — nichts wird gespeichert), SHA-256, Magic-Byte-MIME-Vorrang, 25-MiB-Cap (`MAX_UPLOAD_BYTES`; Teilbereiche 10 MB)                                                                                      |
| Unveränderlichkeit | Object-Lock je Stufe: GOBD→COMPLIANCE mit typabhängig 6/8/10 J. (§ 147 AO/§ 14b UStG), GWG→GOVERNANCE und fachlicher Lösch-Queue; DB-Trigger `document_version_immutable_protect` (auch Owner); Herabstufung/Fristverkürzung sowie GWG→GOBD blockiert, Höherstufung aus NONE oder GOBD-Fristverlängerung re-stored in den gelockten Bucket |
| Soft-Delete        | nur Sichtbarkeit (Papierkorb, wiederherstellbar), keine S3-Löschung; endgültige Vernichtung ausschließlich im GwG-Verfahren (Admin-Review-Queue, je Beleg bestätigt, Audit `gwg.evidence.destroy`)                                                                                                                                         |
| Freigabe           | serverseitig erzwungen: Portal-Liste/-Download/-Preview filtern `sharedWithClientAt != null` + Session-clientId; Staff-Freigabe nur für Mandanten-Dokumente, auditiert                                                                                                                                                                     |
| Auslieferung       | app-proxied (Object-Store nie öffentlich, 127.0.0.1-Bind); Inline-Preview-Whitelist (pdf/Bilder/text-plain; html/svg/js nie inline), `nosniff` + CSP `sandbox` für text/plain, Dateinamen-Header sanitisiert, ZIP-Export mit Größen-/Parallel-Caps und Zip-Slip-Härtung                                                                    |
| Zugriff            | Staff: Tenant-Filter + RESTRICTED-Zuständigkeit (Liste, Download, Preview, Detailseite); Portal: nur eigene, freigegebene Dokumente                                                                                                                                                                                                        |
| Protokollierung    | `document.upload/.download/.preview/.delete/.restore/.retag/.share/.unshare/.move_folder/.acknowledge`, `document.version.add`, Sammelausgaben `document.download.bulk` und `client.belege.export` mit Dokument-ID-Liste (siehe Abrufnachweise), Ordner-/Typ-Events, GwG-Vernichtungs-Events                                               |

Der Sammeldownload vergibt nach Bereinigung eindeutige ZIP-Namen. Auch bereits
vergebene Suffixnamen wie `beleg_1.pdf`, Groß-/Kleinschreibung und
Unicode-Normalisierung werden bei der Kollisionsprüfung berücksichtigt.
Benötigte Verzeichnisse und ihre Elternpfade werden vorab reserviert: Eine
Datei `Belege` erhält einen anderen Transportnamen, wenn zugleich
`Belege/2026/Original.pdf` enthalten ist. Regressionen prüfen diesen Fall
einschließlich tatsächlicher Dateisystemextraktion.
Dadurch bleiben sämtliche ausgewählten Inhalte beim üblichen Entpacken
erhalten. Archivierte Dokumentnamen, Originalbytes, Auswahl und Zugriffsprüfung
werden nicht verändert. Der Routentest `bulk-download-filenames.test.ts`
prüft die tatsächlichen ZIP-Einträge und deren entpackte Inhalte.

Mehrfachauswahl im Explorer (Verschieben, Freigeben/Entziehen, Löschen, Typ
ändern) läuft als eine Server Action mit ID-Liste (`server/documents/document-bulk.ts`,
Review-Finding P-18): je bis zu 200 Einträge eine Transaktion, die zuerst alle
betroffenen Zeilen sperrt und erst danach Audit-Events schreibt (dieselbe
Sperrreihenfolge wie die Einzelaktionen, kein Deadlock mit dem tenantweiten
Audit-Lock), Zugriffsprüfung (je Mandant einmal je Transaktion) und Audit-Event
je Dokument wie bei der Einzelaktion, eine Revalidierung ohne zusätzlichen
Router-Refresh. Fachliche
Ablehnungen betreffen nur ihren Eintrag; scheitert die Transaktion an der
Datenbank (z. B. Freigabesperre für Lohnarchive), wird je Eintrag einzeln
wiederholt und die Meldung „N erledigt, M abgelehnt“ bleibt genau.
Reine Metadaten-Umklassifizierungen laufen gemeinsam in einer Transaktion;
Höherstufungen mit Re-Store bleiben je Dokument journal-first
(DOC-UPLOAD-JOURNAL-001) und laufen in einem Zeitbudget je Aufruf, offene
Einträge reicht der Client nach. Nachweise: `bulk-actions.test.ts`,
`bulk-actions-db.test.ts` (CI-db-Job), `document-bulk.test.ts` und
`apps/e2e/tests/19-document-explorer-state.spec.ts`.

## Abrufnachweise (Download, Vorschau, Sammel- und DATEV-Export)

DOC-VERSION-IMMUTABILITY-001 / DOC-UPLOAD-JOURNAL-001: Einzeldownload,
Vorschau, Sammeldownload und DATEV-Belegexport des Dokumentenarchivs erzeugen je
Auslieferung genau einen Abrufnachweis in der Audit-Hash-Chain. Diese
Nachweisform hat der Product Owner am 2026-10-07 bestätigt (Review-Finding A10,
Folgepunkt aus P-12).

| Ausgabe                | Ereignis                 | Ressource    | Nachher-Zustand                                                                                        |
| ---------------------- | ------------------------ | ------------ | ------------------------------------------------------------------------------------------------------ |
| Einzeldownload         | `document.download`      | Dokument-ID  | —                                                                                                      |
| Vorschau               | `document.preview`       | Dokument-ID  | — (nur der Byte-Request `?stream=1`, nicht der Metadaten-Request)                                      |
| Sammeldownload als ZIP | `document.download.bulk` | leer         | `documentCount`, `documentIds` (Archivreihenfolge, jedes Dokument einmal), `folderIds`                 |
| DATEV-Belegexport      | `client.belege.export`   | Mandanten-ID | `documents` (Anzahl), `documentIds` (Archivreihenfolge = laufende Nummer in `index.csv`), `from`, `to` |

- Sammeldownload und DATEV-Export schreiben ihren Nachweis erst nach Größen-,
  Eintrags- und Slot-Prüfung und vor dem ersten Objektabruf; ein mit 413 oder
  429 abgelehnter Export erzeugt keinen. Eine einzelne lose Datei bleibt ein
  `document.download`.
- Die ID-Liste wird nicht gekürzt. Die Eintragsprüfung vor dem Nachweis begrenzt
  sie auf `ZIP_MAX_ENTRIES` (65.535; beim DATEV-Export abzüglich `index.csv` und
  `manifest.txt`), rund 2,5 MB JSON; `packages/evidence` kennt keine
  Größengrenze für den Nachher-Zustand.
- Die Liste nennt die zur Auslieferung ausgewählten, zugriffsberechtigten und
  fertig geprüften Dokumente (neueste Version `CLEAN` mit `scanCompletedAt`).
  Fehlt beim DATEV-Export ein Objekt erst beim Streamen, bleibt die ID im
  Nachweis; `index.csv` markiert den Beleg als `FEHLT` und `manifest.txt` nennt
  die tatsächlich gelieferte Anzahl.
- Der CSV-Export des Prüfprotokolls (`/api/staff/admin/audit/export`) weist in
  der letzten Spalte „Details“ für beide Sammelereignisse Anzahl und alle IDs
  aus (`N Dokumente: <id> <id> …`). DATEV-Exporte vor dieser Ergänzung tragen
  keine ID-Liste und erscheinen als `N Dokumente (ohne ID-Liste)`.

Nachweise: `bulk-download-audit.test.ts` (2.000 Ordnerdokumente in einem
Ereignis, Doppelauswahl einmal, Einzeldatei), der DATEV-Export-Routentest
(Reihenfolge, fehlender Beleg, 2.000 Belege ohne Kürzung, kein Nachweis bei
413/429) und der Audit-Exporttest (Spalte „Details“).

## Upload-Wege (alle über die zentrale Pipeline)

DOC-UPLOAD-JOURNAL-001 / DOC-VERSION-IMMUTABILITY-001 /
DOC-PORTAL-SHARING-001: Einzel-Download und Vorschau für Staff und Portal,
Sammeldownload und DATEV-Belegexport prüfen die neueste Version vor Audit und
Storage über `delivery-readiness.ts`: `CLEAN` und vorhandenes
`scanCompletedAt`. PENDING-Intents, Fehler-/Quarantänestatus und unvollständige
Abschlussdaten bleiben gesperrt, ohne Rückfall auf eine ältere saubere Version.
Einzelabrufe und leere Sammeldownloads liefern 404; ZIP-Exporte nehmen nur
auslieferbare Dokumente in Auswahl und Zähler auf.

Der Virenscan fremder Uploadbytes bleibt vor dem Store-Write. Die neue
Auslieferungssperre verhindert insbesondere den Abruf eines zwar geschriebenen,
aber noch nicht finalisierten Upload-Intents. Reguläre Upload-/Finalize-Helper
und erzeugte Rechnungs-PDF-/XML-Archive setzen beide Abschlussfelder. Bereits
finalisierte historische Dokumente bleiben ohne zusätzliche Forderung nach
einer Storage-Version-ID lesbar. Unbekannte Altstände ohne Abschlussdaten
werden nicht pauschal freigeschaltet oder nachträglich als geprüft markiert.
Vorhandene Storage-Version-IDs werden dagegen verbindlich an S3-GET
weitergereicht: Ein späterer PUT auf denselben Key darf keinen Download,
Preview, Export, Vollmachts-Snapshot oder Retag-Quellinhalt austauschen.
Eine nicht mehr verfügbare gebundene Version führt zum Fehler ohne Key-Fallback.
Wissensanlagen und akzeptierte Inbox-Anlagen prüfen dieselbe aktuelle
Dokument-Scanfreigabe; der öffentliche Vollmachtsabruf prüft die gebundene Version.
Relevante Nachweise sind `delivery-lifecycle.test.ts`, die Staff-/Portal-
Routentests, `bulk-download-readiness.test.ts`, der DATEV-Export-Routentest und
der Rechnungsarchivtest; sie prüfen echte Handler und tatsächliche ZIP-Inhalte
mit synthetischem Storage/DB-Zugriff.
`packages/storage/src/__tests__/object-version.test.ts` unterscheidet die
Bytes des aktuellen Schlüssels von einer gebundenen S3-Version und prüft beide
Auslieferungsarten; die Route-/Delivery-Tests belegen die Weitergabe der ID.

Staff-Explorer (+ neue Version, mit Race-Schutz 409), Portal-Upload
(Feature-Flag, Rate-Limit, auto-geteilt), Formular-Anhänge (10 MB),
GwG-Onboarding (anonym per Token, GWG-Bucket), Rechnungs-PDFs
(EXTERNAL-Upload + ZUGFeRD-Archiv → GOBD), Steuererklärungs-PDFs (GOBD).

## Traceability

| Anforderung                                               | Implementierung                                                                              | Test                                                                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Kein Inline-XSS über Dokumente                            | preview-mime Whitelist + CSP sandbox                                                         | `server/storage/__tests__/preview-mime.test.ts`                                                                            |
| ZIP-Export sicher + begrenzt                              | export/zip                                                                                   | `server/export/__tests__/zip.test.ts`                                                                                      |
| Ein Abrufnachweis je Sammelausgabe mit allen Dokument-IDs | `documents/download/route.ts`, `datev-belege-export/route.ts`, `admin/audit/export/route.ts` | `bulk-download-audit.test.ts`, `datev-belege-export/__tests__/route.test.ts`, `admin/audit/export/__tests__/route.test.ts` |
| GwG-Fristen + Lösch-Queue                                 | server/gwg/retention                                                                         | `server/gwg/__tests__/retention.test.ts`, Worker-Test gwg-expiry-check                                                     |
| DSGVO-Anonymisierung respektiert GwG-Belege               | dsgvo/client-retention                                                                       | `server/dsgvo/__tests__/client-retention.test.ts`                                                                          |
| Rechnungsarchiv unveränderlich + idempotent               | invoicing/archive                                                                            | `invoicing/__tests__/archive.test.ts`                                                                                      |
| Mandantentrennung                                         | RLS + Filter                                                                                 | `rls-cross-tenant.test.ts` (Document-Fall)                                                                                 |
| Scan-/Größen-Fehlerpfade end-to-end                       | upload-helpers + commit-Routen                                                               | Sicherheitsaudit 2026-06 (verifiziert); Unit-Lücke in packages/storage dokumentiert (Gap-Analyse)                          |

## Bekannte Grenzen

- Magic-Bytes überschreiben den Client-MIME, lehnen unbekannte Formate aber
  nicht ab (Preview-Whitelist mildert).
- K-06: Direkte Upload-Pfade (Staff-/Portal-Upload, neue Version,
  Wissensanhang, Umklassifizierung, Fremdrechnung, Erklärungs-PDF,
  Formular-Upload, Rechercheablage, Rechnungsarchiv) laufen über
  `server/documents/journaled-upload.ts`: gemeinsame Vorprüfung vor Scan und
  Write, Speicherabsicht (`storage_orphan.intent`) vor dem PUT, Nachprüfung und
  atomarer Abschluss (`app.settle_storage_intent`) in der Commit-Transaktion.
  Offene Absichten (Prozessabbruch, gescheiterter Commit, verlorenes Race)
  prüft der sechsstündliche `storage-orphan-cleanup` nach der Sicherheitsfrist
  bzw. dem Retention-Ende: referenziert, versionsgenau gelöscht oder — nie
  geschrieben — `ABSENT`. `compensateStorageCommit` bleibt Rückfallebene; schlägt
  auch sie fehl, bleibt nur das strukturierte Log für einen manuellen Abgleich.
  Nicht dokumentgebundene Ablagen (Risiko-Archiv/-Rohdaten, IMAP-Anhänge)
  schreiben weiterhin ohne Vorab-Journal. Kein Streaming-Multipart (RAM-Puffer
  bis Cap).
- GwG-Frühvernichtung vor Lock-Ablauf (GOVERNANCE-Bypass) nicht implementiert.

## Fortschritt trotz fehlerhafter Orphans

DOC-UPLOAD-JOURNAL-001 / DSGVO-OPERATIONAL-RETENTION-001: Der Orphan-Worker
sortiert nach bisheriger Versuchszahl, Erstellungszeit und ID. Ein Batch
dauerhaft fehlender/mehrdeutiger Objekte blockiert damit keine späteren
bereinigungsfähigen Objekte. Ab fünf Fehlern wird ein manueller
Untersuchungsbedarf geloggt. Referenzprüfung, Retention und eindeutige
Storage-Version bleiben unveränderte Löschvoraussetzungen.
