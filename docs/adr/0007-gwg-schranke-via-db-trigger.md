# ADR 0007 — GwG-Schranke via DB-Trigger (Defense in Depth)

**Status**: Akzeptiert (Iter. 1 als Stub, vollständig in Iter. 4)
**Datum**: 2026-05-13
**Kontext**: Nach § 10 GwG dürfen Vorgänge mit einem Mandanten erst beginnen,
wenn dessen Identifizierung erfolgreich abgeschlossen ist. App-Logik allein
ist nicht ausreichend — ein vergessener `if`-Check bedeutet Bußgeld bis
1 Mio. €.

## Entscheidung

Drei-Schicht-Sicherung:

1. **Application-Layer**: Server Actions prüfen `client.allowActive` vor jeder
   Mandant-bezogenen Operation
2. **DB-Trigger** auf `document`, `request`, `invoice`:
   - `BEFORE INSERT` → wirft `RAISE EXCEPTION` wenn `client.allow_active = FALSE`
3. **DB-Trigger** auf `client.allow_active`:
   - `BEFORE UPDATE OF allow_active` → erlaubt `TRUE` nur wenn ein
     `gwg_check` mit Status `VERIFIED` und gültigem `valid_until` existiert
   - INSERT bleibt erlaubt mit `allow_active = TRUE` (Migration / Seed)

Der zweite Trigger (DB-seitige GwG-Invariante) ist die echte Garantie:
Selbst wenn die App-Logik vergisst, einen GwG-Check zu fordern, schaltet
die DB den Mandanten nicht scharf.

## Konsequenzen

**Vorteile**
- Doppelte Verteidigung — App-Bug wird vom Trigger gefangen
- Konsistenz garantiert: kein "halb-aktiver" Mandant denkbar
- Beweisbar in Audits (DB-Trigger ist im Schema dokumentiert)

**Nachteile**
- Trigger-Errors müssen in der App freundlich gefangen werden
  (sonst „RAISE EXCEPTION" als 500)
- Trigger erschwert Massen-Migrationen (Workaround: temporär als
  Owner laufen + BYPASSRLS)

## Alternativen verworfen

- Nur App-Check: zu fragil, Compliance-Risiko zu hoch
- CHECK CONSTRAINT: kann keine Cross-Tabellen-Bedingungen prüfen
- Postgres `EXCLUDE`-Constraints: deckt den Fall nicht
