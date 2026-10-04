# Technische Modulbeschreibung: Audit-Protokollierung

## Zweck

Manipulationsevidente Protokollierung aller compliance-relevanten Aktionen
(GoBD-Nachvollziehbarkeit/Unveränderlichkeit) als vollständige lokale
SHA-256-Hash-Chain plus gekoppelter externer RFC-3161-Anchor-Kette,
Tagesversiegelung und unveränderlicher Langzeit-Archivierung.

## Mechanik (packages/evidence)

1. `record()` schreibt append-only in `audit_log`:
   `this_hash = SHA-256(prev_hash ‖ canonical_json(event))`, serialisiert
   pro Tenant via Advisory-Lock, **in derselben Transaktion wie die
   Fachoperation** (kein Event ohne Daten, keine Daten ohne Event).
2. Kanonisierung deterministisch (`canonical-json.ts`, BigInt/Decimal-
   Normalisierung); IP/User-Agent bewusst außerhalb des Hashes.
3. Rolling-Verankerung (`anchorLatest`): Der Worker stempelt außerhalb der
   Fachtransaktion einen committeten Präfix. Der Anchor-Payload bindet lokalen
   ID-Bereich, rekonstruierten Spitzen-Hash und vorheriges TSA-Token; ein
   bedingtes Insert plus Unique-Constraint auf Tenant/Vorgänger-Hash verhindert
   Zweige auch bei parallelen Läufen mit demselben MVCC-Snapshot.
   `anchorLatestWithLease` hält dabei je Tenant einen committeten Lease
   (`audit_anchor_lease`, 30 s, vor der Anfrage und nach der Antwort
   bestätigt, sonst wird das Token verworfen; Insert daran gebunden), aber
   während der TSA-Anfrage weder Transaktion noch Verbindung,
   sodass überlappende Läufe dieselbe Spitze nicht erneut bei der TSA anfragen;
   nur TSA-/Tokenfehler starten den Backoff. `tenantsDueForAnchoring` wählt
   Tenants mit Mindestabstand (60 s) zum letzten Anker; Rechnungs- und
   GwG-Aktionen (`IMMEDIATE_ANCHOR_ACTIONS`: `invoice.*`, `gwg.*`,
   `stbvv.invoice.*`, `client.update.gwg_relevant`,
   `client.deactivate.gwg_expired`) ohne Wartezeit.
4. Tagesversiegelung (`sealDay`): RFC-3161-Zeitstempel über den
   Tages-Spitzen-Hash in `audit_seal` (idempotent, Backfill verpasster Tage).
5. `verifyChain()` rechnet jede Zeile nach (cursor-basiert, 1000er-Chunks)
   und prüft Anchor-Kette und Tagesversiegelungen kryptografisch (pkijs) gegen den
   **rekonstruierten** Spitzen-Hash; `requireExternalTsa` macht
   Self-Timestamps in Produktion zum Verstoß. TSA-Antworten der Anker werden
   blockweise geladen. CLI, Prüfer-Link und Backup-Drill nutzen diese
   checkpointfreie Vollprüfung.
6. Tägliche Prüfung mit Prüf-Checkpoint (`verify-checkpoint.ts`, Tabelle
   `audit_verify_checkpoint`, Schreiben nur Owner, App-Rolle nur SELECT):
   Der Worker prüft zuerst, ob der gespeicherte Stand noch zur Kette passt
   (Zeile und Hash an seiner Position, Anzahl Einträge/Siegel/Anker, letzter
   Anker), und rechnet dann nur den Zuwachs nach — abschnittsweise
   (`verifyChainSegment`, höchstens 5.000 Einträge bzw. 250 Anker je
   Transaktion), Fortschritt nach jedem Abschnitt gespeichert. Nachträglich
   angelegte Siegel/Anker unterhalb des Checkpoints werden per
   Einzel-Nachrechnung geprüft. Sobald die letzte abgeschlossene Vollprüfung
   mindestens 7 Tage zurückliegt (im täglichen Takt in der Regel im achten
   Lauf), und bei jedem manuellen Lauf folgt eine fortsetzbare Vollprüfung ab
   Genesis (10 Minuten Budget je Lauf), die den beim Start eingefrorenen
   Checkpoint exakt bestätigen muss.
   Jede Abweichung ist ein negativer Befund; ein nicht bestätigter Checkpoint
   wird verworfen und die Kette ab Genesis neu geprüft. Siegel- und
   Ankerbefunde stoppen die Prüfung wie bei `verifyChain` nicht; der
   Checkpoint hält sie (`findings`) und jeder Lauf meldet sie erneut, ein
   Kettenbruch hat Vorrang. Jede Zeile trägt eine HMAC-SHA256-Prüfsumme
   (`mac`, Schlüssel per HKDF aus `SECRET_BOX_KEY` bzw. `AUTH_SECRET`,
   `deriveAuditCheckpointMacKey`); fehlende/falsche Prüfsumme oder
   Zeitstempel in der Zukunft gelten als Manipulationsverdacht. Fortgeschrieben
   wird per Compare-and-set, jeder Schreibvorgang setzt `verified_at` streng
   später: Ein parallel überholter Lauf übernimmt den authentischen, später
   geschriebenen Stand und prüft weiter (kein Überspringen); eine während des
   Laufs gelöschte, verfälschte oder durch einen älteren Stand ersetzte Zeile
   ist Manipulationsverdacht. Die Kennung der laufenden Vollprüfung steht
   prüfsummengeschützt im Zuwachs-Checkpoint; ein fehlender, fremder oder
   wieder eingespielter Vollprüfungsstand ist ein Befund. Eine laufende
   Vollprüfung ohne Fortschritt seit drei Tagen meldet „Vollprüfung stockt“
   und beginnt neu; ohne laufende Vollprüfung meldet jeder Lauf mehr als
   21 Tage nach der letzten abgeschlossenen „Vollprüfung überfällig“. Siegel mit Spitze jenseits des Kettenendes zählen und melden
   wie bei `verifyChain`, gehen aber nicht in den Prüfstand ein; gespeichert
   werden je Art die 1.000 Befunde mit den niedrigsten IDs. Ein manueller Lauf
   meldet bis zum Abschluss der Vollprüfung nur ihren Fortschritt.
7. Wöchentliche Archiv-Rotation: deterministische NDJSON-Segmente in den
   GOBD-Bucket (Object-Lock COMPLIANCE 10 J.), Segment-Verifikation mit
   derselben Hash-Funktion (keine Record/Verify-Drift). Vorhandene externe
   RFC-3161-Tokens werden gegen den tatsächlichen Datei-Hash und konfigurierte
   Trust-Roots geprüft; ein fehlender Token bleibt sichtbar, statt als
   erfolgreicher TSA-Nachweis zu gelten.

## Betrieb / Oberflächen

### Kanonisierung und betroffene historische Sonderfelder

Die Kanonisierung erhält eigene JSON-Schlüssel wie `__proto__` in einem
Objekt ohne geerbte Setter. Die frühere Objektzuweisung ließ dieses Feld aus
und band damit seine Daten weder im Ereignishash noch zuverlässig in der
Archivkopie. Die korrigierte gemeinsame Serialisierung gilt für Record,
Onlineprüfung und Archivierung; normale Eingaben behalten ihre bisherigen
Bytes einschließlich numerischer Schlüsselreihenfolge.

Altbestände mit noch gespeichertem Sonderfeld können nun eine Hashabweichung
melden. Bestehende Ereignisse, Hashes und Archivobjekte bleiben unverändert;
es gibt keinen Rückfall auf die fehlerhafte Prüfung und keine automatische
Neubesiegelung. Ein bereits in einer alten Archivkopie verlorener Feldinhalt
kann daraus nicht rekonstruiert werden. Solche Befunde müssen unter Erhaltung
der Originalnachweise geprüft und dokumentiert werden. Die direkten
Regressionen und Property-Tests bilden diese Grenzen ab
(`AUDIT-HASH-CHAIN-001`, `AUDIT-ARCHIVE-001`).

### Laufende Dienste und Ansichten

- Worker: `audit-anchor` (Takt alle 2 Sekunden; je Tenant höchstens ein
  Stempel pro Minute, offene Rechnungs-/GwG-Einträge sofort und bevorzugt;
  committeter Tenant-Lease während des TSA-Aufrufs; Backoff nur bei TSA-Fehlern),
  `evidence-seal` (02:30 UTC), `audit-verify-check` (02:45 UTC, Zuwachs ab
  Prüf-Checkpoint plus fällige Vollprüfung, persistiert Ergebnis als
  `tenant_setting` inkl. Prüfumfang `incremental`, Notification an Admins bei
  Bruch **und bei einer Exception des Prüflaufs**), `audit-rotate` (So 03:00 UTC). HARD-Mode (DB-Kürzung) bewusst
  nicht implementiert.
- Admin-UI: getrennte Status-Karten für lokalen Verify und externen
  Anchor-Rückstand (Auto-Refresh; kein Chain-Walk im
  Render-Pfad; einzige Ausnahme: Einzel-Hash-Nachrechnung auf der
  Detailseite), Filter/Detail mit before/after, manueller Prüf-Trigger
  (selbst auditiert), CSV-Export (ratenlimitiert, gekappt, auditiert, inkl.
  Hashes), zeitlich begrenzter Prüfer-Link (HMAC, nur Chain-Attestierung,
  kein Datenzugriff).
- TSA-Konfiguration je Tenant (kostenlose und kommerzielle Presets; keine
  pauschale Qualifikationszusage allein aus dem Anbieternamen; SSRF-Check auf
  Custom-URLs); Auflösung Tenant → ENV → GlobalSign-Default.
  Statusprüfung und Worker verwenden dieselbe Auflösung. In Produktion gibt es
  keinen stillen Self-Timestamp-Fallback. Nicht-GlobalSign-Anbieter benötigen
  ihren Betreiber-Trust-Anchor über `TSA_TRUSTED_ROOTS_FILE`.
- CLI `pnpm verify:chain` (alle Tenants + Archiv-Segmente, Exit-Codes für CI).

## Traceability

Die zentrale Ansicht und ihr CSV-Export teilen Kategorien, Sortierung nach
Audit-ID und Datumsfilter in `server/audit/query.ts`. Kategorien sind rein
abgeleitet; historische Ereignisse und Hashes werden nicht umgeschrieben.
Unbekannte Actions bleiben unter „Sonstige“ sichtbar. Berliner Tagesgrenzen
werden inklusive Beginn und exklusiv bis zur nächsten Mitternacht ausgewertet,
auch an Zeitumstellungstagen. Der CSV-Auszug ist bei Filtern keine vollständige
Hash-Kette. Die Berechtigung bleibt auf ADMIN/PARTNER begrenzt.

Die Seitendatei prüft zuerst die Berechtigung und komponiert anschließend
getrennte Daten-, Filter-, Tabellen- und Statusbausteine. `audit-page-data.ts`
bündelt alle Reads in demselben Tenantkontext; `audit-page-state.ts` hält
Filtervalidierung, Cursorbildung und die Zuordnung des persistierten
Prüfergebnisses. `audit-chain-status.tsx` stellt ungeprüfte, intakte,
historisch abgegrenzte und neue negative Befunde getrennt dar. Die
Server-Actions und die Hash-/Ankerprüfung bleiben unverändert.

Der Gesamtzähler ist auch ungefiltert ein exakter, explizit tenantgebundener
Count. Die frühere `pg_class.reltuples`-Schätzung zählte die gesamte Tabelle
und konnte Bestände anderer Kanzleien in der Anzeige offenlegen. Seitenliste,
Ressourcenfilter und Count setzen den Tenant zusätzlich zum RLS-Kontext.
Count und CSV-Auswahl bleiben cursorfrei; Pagination verwendet weiterhin
50 sichtbare Zeilen plus eine Probezeile. Der vorhandene
`audit_log_tenant_id_id_idx` unterstützt die Tenantbegrenzung; der Count muss
trotzdem den sichtbaren Bestand des Tenants zählen und kann bei großen Logs
aufwendiger werden. Es gibt keine neue Vollkettenprüfung im Renderpfad.
`page.test.tsx` belegt die Scopekorrektur, Rollenprüfung, Filter-/Cursorverträge
und gerenderte Statusübergänge mit simulierten DB-Grenzen
(`AUDIT-HASH-CHAIN-001`, `ACCESS-TENANT-RLS-001`, `AUDIT-VERIFY-ALERT-001`).

Die historische Einordnung der Statuskarte verlangt den persistierten
`recovered`-Wert; ein Checkpoint allein verdeckt keinen neu gemeldeten Fehler.
Bei einem historischen Hash-/Link-Bruch verifiziert der Worker die Teilkette
ab dem konkreten Checkpoint. Bei einer Tail-Truncation gilt nur ein nach dem
negativen Ergebnis auditierter Checkpoint als neue Vergleichsbasis. Einmal
beobachtete lokale und externe Spitzen-IDs werden auch bei Schrumpf, frühem
Kettenabbruch oder Lauf-Exception monoton erhalten (`AUDIT-VERIFY-ALERT-001`).

| Anforderung                                                                | Implementierung                 | Test                                                                        |
| -------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| Ketten-Integrität + Bruch-Erkennung                                        | chain/service                   | `hash-chain.test.ts`, `service-verifychain.test.ts`                         |
| Record==Verify für alle Werttypen                                          | canonical-json/chain            | `chain.test.ts`, `canonical-json.test.ts`                                   |
| RFC-3161 kryptografisch korrekt                                            | rfc3161-verify                  | echtes Fixture + synthetische Negativ-CA + Differenztest gegen `openssl ts` |
| Gekoppelte Rolling-Anchor-Kette ohne Zweige                                | anchor/service + audit-anchor   | `anchor.test.ts`, `service-anchor.test.ts`, `service-verifychain.test.ts`   |
| Backfill fehlender Tages-Seals (kein Restamp bestehender `NULL`-Zeilen)    | evidence-seal-Worker            | `evidence-seal.test.ts`                                                     |
| Archiv-Segmente unveränderlich; TSA-Token geprüft oder fehlend ausgewiesen | audit-rotate + verify:chain     | `archive.test.ts`, `audit-rotate.test.ts`                                   |
| Jede record-Action hat ein Label                                           | labels.ts                       | `audit-label-coverage.test.ts` (AST-Guard)                                  |
| Restore-Beweis auf wiederhergestellter DB                                  | backup-drill + restore-selftest | CI-Job `restore` + Drill-E2E (verifiziert 2026-06-10)                       |
| Monotone Spitzen, Recovery-Abgrenzung und Exception-Alarm                  | audit-verify-check              | `audit-verify-check.test.ts` (`AUDIT-VERIFY-ALERT-001`)                     |
| Checkpoint-Prüfung gleichwertig zu verifyChain, Manipulation erkannt       | verify-checkpoint/service       | `verify-checkpoint-db.test.ts`, `audit-verify-checkpoint.test.ts`           |

## Bekannte Grenzen

`audit_log` wächst unbegrenzt (SOFT-Rotation behält DB-Zeilen); Prüfer-Link
nur global widerrufbar; `audit-verify-check` prüft TSA-Policy gegen die
ENV-/Default-TSA (bewusst — verify validiert nur). Eine Manipulation unterhalb
des Prüf-Checkpoints, die weder dessen Zeile noch die Zähler verändert, findet
erst die nächste Vollprüfung (in der Regel im achten täglichen Lauf nach der
letzten, plus deren Laufzeit; ein manueller Lauf startet sie sofort); ebenso
ein geändertes Prüfergebnis bereits verarbeiteter Siegel/Anker (z. B.
Trust-Store-Wechsel). Wer Worker-Geheimnis und Owner-Rechte besitzt, kann
authentische, aber falsche Checkpoints schreiben. Liegt ein
Bruch vor einem Recovery-Checkpoint, wird die Recovery-Teilkette weiterhin bei
jedem Lauf vollständig nachgerechnet.
