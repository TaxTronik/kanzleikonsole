# ADR 0004 — Manipulationsevidenz: Hash-Chain + RFC-3161

**Status**: Akzeptiert (Iteration 1, verifiziert in Iter. 7)
**Datum**: 2026-05-10
**Kontext**: § 146 AO, GoBD Tz. 58 ff. — die Steuerberatungssoftware muss
nachweislich gewährleisten, dass aufzeichnungspflichtige Daten unveränderlich
sind. Eine reine Datenbank-Constraint genügt nicht, weil sie aus dem Backup
manipuliert werden kann.

## Entscheidung

Drei-Schicht-Modell:

1. **Append-only Audit-Log** (`audit_log`) auf DB-Ebene
   - Postgres-Trigger `audit_log_no_modify` blockt UPDATE/DELETE/TRUNCATE
   - App-Role hat kein UPDATE/DELETE-Recht (REVOKE in Migration)
   - Owner-Role kann Trigger nicht umgehen (BEFORE-Trigger feuert für alle)

2. **Hash-Chain** pro Tenant
   - `this_hash = SHA-256(prev_hash || canonical_json(eintrag))`
   - Genesis: `prev_hash = SHA-256("taxtronik-genesis:" || tenant_id)`
   - Pro-Tenant pg_advisory_xact_lock serialisiert Inserts → keine Race-Conditions
   - Verifikation per CLI (`pnpm verify:chain`) und Admin-UI

3. **Tagesversiegelung mit RFC-3161**
   - Worker-Job `evidence-seal` läuft täglich 02:30 UTC (BullMQ Repeat-Scheduler)
   - Holt Tages-Spitzen-Hash, sendet ihn an eine TSA, archiviert die signierte
     Antwort in `audit_seal`
   - MVP: `LocalTimestampAdapter` (Self-Stempel) → Drop-in-Wechsel auf
     D-Trust/swisscom über `Rfc3161StubAdapter`

## Konsequenzen

**Vorteile**
- Manipulation am Audit-Log durch Owner ist sichtbar (Hash-Chain bricht).
- Manipulation an `audit_seal` ist für die Vergangenheit unmöglich, weil die
  TSA eine externe vertrauenswürdige Quelle ist.
- Wirtschaftsprüfer können die Kette unabhängig nachrechnen.

**Nachteile**
- TSA-Anbindung in Produktion ist Pflicht (sonst: Self-Stempel = nicht
  beweiskräftig vor Gericht).
- Schreibtransaktionen werden serialisiert (Lock pro Tenant) → bei extremen
  Schreiblasten Engpass. Mitigation: Audit-Inserts sind klein, Lock-Dauer < 1ms.
- Backup-Restore bricht die Kette. Dokumentation in
  `docs/compliance/gobd.md`: jede Wiederherstellung erfordert eine
  fortlaufende neue Kette + Beweis-Snapshot der alten.

## Alternativen verworfen

- Blockchain (zu komplex, kein Mehrwert für Single-Tenant-On-Premise)
- WORM-Storage allein (kein Beweis vor Gericht ohne Zeitstempel)
