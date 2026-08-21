# ADR 0004 — Manipulationsevidenz: Hash-Chain + RFC-3161

**Status**: Akzeptiert (Iteration 1, Rolling-Anker ergänzt 2026-08-21)
**Datum**: 2026-05-10
**Kontext**: § 146 AO, GoBD Tz. 58 ff. — die Steuerberatungssoftware muss
nachweislich gewährleisten, dass aufzeichnungspflichtige Daten unveränderlich
sind. Eine reine Datenbank-Constraint genügt nicht, weil sie aus dem Backup
manipuliert werden kann.

## Entscheidung

Vier-Schicht-Modell:

1. **Append-only Audit-Log** (`audit_log`) auf DB-Ebene
   - Postgres-Trigger `audit_log_no_modify` blockt UPDATE/DELETE/TRUNCATE
   - App-Role hat kein UPDATE/DELETE-Recht (REVOKE in Migration)
   - Owner-Role kann Trigger nicht umgehen (BEFORE-Trigger feuert für alle)

2. **Hash-Chain** pro Tenant
   - `this_hash = SHA-256(prev_hash || canonical_json(eintrag))`
   - Genesis: `prev_hash = SHA-256("taxtronik-genesis:" || tenant_id)`
   - Pro-Tenant pg_advisory_xact_lock serialisiert Inserts → keine Race-Conditions
   - Verifikation per CLI (`pnpm verify:chain`) und Admin-UI

3. **Nicht blockierende externe Anchor-Kette mit RFC 3161**
   - Worker `audit-anchor` läuft alle zwei Sekunden und stempelt den neuesten
     bereits committeten lokalen Ketten-Präfix; Rechnungs- und GwG-Ereignisse
     werden bei Rückstand zuerst verarbeitet
   - Der TSA-Aufruf läuft außerhalb der Fachtransaktion und hält den lokalen
     Advisory-Lock nicht. Neue Einträge bleiben während der Anfrage möglich
   - `audit_anchor` ist selbst append-only. Jeder Payload enthält Tenant,
     lokalen ID-Bereich, rekonstruierten lokalen Spitzen-Hash und den Hash des
     vorherigen TSA-Tokens; damit bilden die externen Checkpoints eine zweite,
     dünne und mit der vollständigen lokalen Kette gekoppelte Hash-Kette
   - Ein bedingtes Insert und der DB-Constraint
     `UNIQUE(tenant_id, previous_anchor_hash)` lassen bei Parallelität nur einen
     Nachfolger je externer Spitze zu — auch bei identischem MVCC-Snapshot.
     Andere Tokens werden verworfen und später neu angefordert; ein
     persistierter Zweig entsteht nicht
   - Retry-/Rückstandsstatus ist im Admin-Panel sichtbar. Ein Rückstand über fünf
     Minuten geht in den Betriebs-Health-Alarm ein, blockiert aber keine
     Fachoperation

4. **Tagesversiegelung mit RFC-3161 (Defense in Depth)**
   - Worker-Job `evidence-seal` läuft täglich 02:30 UTC (BullMQ Repeat-Scheduler)
   - Holt Tages-Spitzen-Hash, sendet ihn an eine TSA, archiviert die signierte
     Antwort in `audit_seal`
   - Produktivbetrieb verwendet eine externe TSA; `LocalTimestampAdapter` ist
     ausschließlich ein transparenter Dev-/Test-Fallback

## Konsequenzen

**Vorteile**

- Manipulation am Audit-Log durch Owner ist sichtbar (Hash-Chain bricht).
- Manipulation an `audit_seal` ist für die Vergangenheit unmöglich, weil die
  TSA eine externe vertrauenswürdige Quelle ist.
- Wirtschaftsprüfer können die Kette unabhängig nachrechnen.
- Das bisher bis zur Tagesversiegelung offene Fenster schrumpft im Normalfall
  auf die Laufzeit von Scheduler und TSA. Es kann prinzipbedingt nicht auf null
  fallen; die TSA-`genTime` ist eine vertrauenswürdige obere Existenzgrenze,
  keine Attestierung des exakten lokalen Ereigniszeitpunkts.

**Nachteile**

- TSA-Anbindung in Produktion ist Pflicht (sonst: Self-Stempel = nicht
  beweiskräftig vor Gericht).
- Schreibtransaktionen werden serialisiert (Lock pro Tenant) → bei extremen
  Schreiblasten Engpass. Mitigation: Audit-Inserts sind klein, Lock-Dauer < 1ms.
- TSA-Ausfall erzeugt einen sichtbaren lokalen Restbestand und Betriebsalarm,
  aber keinen Schreibstillstand. Nach Erholung wird die aktuelle Spitze
  nachgezogen; sie bindet über die lokale Kette auch alle Zwischenereignisse.
- Backup-Restore bricht die Kette. Dokumentation in
  `docs/compliance/gobd.md`: jede Wiederherstellung erfordert eine
  fortlaufende neue Kette + Beweis-Snapshot der alten.

## Alternativen verworfen

- Blockchain (zu komplex, kein Mehrwert für Single-Tenant-On-Premise)
- WORM-Storage allein (kein Beweis vor Gericht ohne Zeitstempel)
