CREATE OR REPLACE FUNCTION app.deadline_daily_review_validate_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  server_now TIMESTAMPTZ := clock_timestamp();
  transaction_started_at TIMESTAMPTZ := transaction_timestamp();
  berlin_review_date DATE := (server_now AT TIME ZONE 'Europe/Berlin')::date;
  snapshot_entry JSONB;
  entry_due_date DATE;
  snapshot_open_count INTEGER := 0;
  snapshot_overdue_count INTEGER := 0;
  snapshot_due_today_count INTEGER := 0;
BEGIN
  IF NEW.review_date IS DISTINCT FROM berlin_review_date THEN
    RAISE EXCEPTION
      'review_date must equal the current Europe/Berlin date (%)',
      berlin_review_date;
  END IF;

  -- Der fachliche Snapshot gehört zum konsistenten Lesestand der umgebenden
  -- Transaktion. Weder snapshot_at noch reviewed_at werden als angelieferte
  -- Tatsachen übernommen: ersterer ist der Transaktions-, letzterer der
  -- tatsächliche Insert-/Abschlusszeitpunkt.
  NEW.snapshot_at := transaction_started_at;
  NEW.reviewed_at := server_now;

  IF jsonb_typeof(NEW.entries_snapshot) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'entries_snapshot must be a JSON object';
  END IF;
  IF NEW.entries_snapshot->'version' IS DISTINCT FROM '1'::jsonb THEN
    RAISE EXCEPTION 'entries_snapshot.version must be 1';
  END IF;
  IF jsonb_typeof(NEW.entries_snapshot->'reviewDate') IS DISTINCT FROM 'string'
     OR NEW.entries_snapshot->>'reviewDate'
        IS DISTINCT FROM to_char(NEW.review_date, 'YYYY-MM-DD') THEN
    RAISE EXCEPTION 'entries_snapshot.reviewDate must match review_date';
  END IF;
  IF jsonb_typeof(NEW.entries_snapshot->'entries') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'entries_snapshot.entries must be a JSON array';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_object_keys(NEW.entries_snapshot) AS snapshot_key(key)
     WHERE snapshot_key.key NOT IN ('version', 'reviewDate', 'entries')
  ) THEN
    RAISE EXCEPTION
      'entries_snapshot may only contain version, reviewDate and entries';
  END IF;

  FOR snapshot_entry IN
    SELECT value
      FROM jsonb_array_elements(NEW.entries_snapshot->'entries') AS item(value)
  LOOP
    IF jsonb_typeof(snapshot_entry) IS DISTINCT FROM 'object'
       OR jsonb_typeof(snapshot_entry->'quelle') IS DISTINCT FROM 'string'
       OR snapshot_entry->>'quelle' NOT IN (
         'STEUERTERMIN',
         'EINSPRUCHSFRIST',
         'KLAGEFRIST',
         'ANFORDERUNG',
         'WIEDERVORLAGE'
       )
       OR jsonb_typeof(snapshot_entry->'kontrollart') IS DISTINCT FROM 'string'
       OR snapshot_entry->>'kontrollart' NOT IN (
         'CALCULATED_CONTROL_PROPOSAL',
         'REVIEW_PENDING_CONTROL_PROPOSAL',
         'INTERNAL_RISK',
         'OPERATIONAL_DUE_DATE'
       )
       OR (
         snapshot_entry->>'quelle' IN ('EINSPRUCHSFRIST', 'KLAGEFRIST')
         AND snapshot_entry->>'kontrollart' NOT IN (
           'CALCULATED_CONTROL_PROPOSAL',
           'REVIEW_PENDING_CONTROL_PROPOSAL',
           'INTERNAL_RISK'
         )
       )
       OR (
         snapshot_entry->>'quelle' IN ('STEUERTERMIN', 'ANFORDERUNG', 'WIEDERVORLAGE')
         AND snapshot_entry->>'kontrollart' <> 'OPERATIONAL_DUE_DATE'
       )
       OR jsonb_typeof(snapshot_entry->'id') IS DISTINCT FROM 'string'
       OR length(btrim(COALESCE(snapshot_entry->>'id', ''))) = 0
       OR jsonb_typeof(snapshot_entry->'clientId') IS DISTINCT FROM 'string'
       OR length(btrim(COALESCE(snapshot_entry->>'clientId', ''))) = 0
       OR jsonb_typeof(snapshot_entry->'faelligAm') IS DISTINCT FROM 'string'
       OR NOT (snapshot_entry ? 'verantwortlichId')
       OR (
         jsonb_typeof(snapshot_entry->'verantwortlichId') IS DISTINCT FROM 'string'
         AND jsonb_typeof(snapshot_entry->'verantwortlichId') IS DISTINCT FROM 'null'
       )
       OR (
         jsonb_typeof(snapshot_entry->'verantwortlichId') = 'string'
         AND length(btrim(snapshot_entry->>'verantwortlichId')) = 0
       ) THEN
      RAISE EXCEPTION 'entries_snapshot contains an invalid entry';
    END IF;

    -- Der append-only Kontrollnachweis darf keine Klartextbezeichnungen oder
    -- beliebigen Zusatzfelder dauerhaft duplizieren. Die Positivliste hält den
    -- Snapshot auf pseudonyme Referenzen und fachliche Kontrolldaten beschränkt.
    IF EXISTS (
      SELECT 1
        FROM jsonb_object_keys(snapshot_entry) AS snapshot_key(key)
       WHERE snapshot_key.key NOT IN (
         'quelle',
         'kontrollart',
         'id',
         'clientId',
         'faelligAm',
         'verantwortlichId'
       )
    ) THEN
      RAISE EXCEPTION
        'entries_snapshot entries may only contain pseudonymous control fields';
    END IF;

    -- Auch unter erlaubten Schlüsseln darf kein Klartext als vermeintliche ID
    -- gespeichert werden. Der Roundtrip über den nativen UUID-Typ erzwingt die
    -- kanonische, pseudonyme Schreibweise; verantwortlichId bleibt nullable.
    BEGIN
      IF ((snapshot_entry->>'id')::UUID)::TEXT
           IS DISTINCT FROM lower(btrim(snapshot_entry->>'id'))
         OR ((snapshot_entry->>'clientId')::UUID)::TEXT
           IS DISTINCT FROM lower(btrim(snapshot_entry->>'clientId'))
         OR (
           jsonb_typeof(snapshot_entry->'verantwortlichId') = 'string'
           AND ((snapshot_entry->>'verantwortlichId')::UUID)::TEXT
             IS DISTINCT FROM lower(btrim(snapshot_entry->>'verantwortlichId'))
         ) THEN
        RAISE EXCEPTION 'entries_snapshot identifiers must be canonical UUIDs';
      END IF;
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'entries_snapshot identifiers must be canonical UUIDs';
    END;

    BEGIN
      entry_due_date := (snapshot_entry->>'faelligAm')::date;
    EXCEPTION
      WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'entries_snapshot contains an invalid faelligAm date';
    END;

    IF snapshot_entry->>'faelligAm' IS DISTINCT FROM to_char(entry_due_date, 'YYYY-MM-DD') THEN
      RAISE EXCEPTION 'entries_snapshot.faelligAm must use YYYY-MM-DD';
    END IF;
    IF entry_due_date > NEW.review_date THEN
      RAISE EXCEPTION 'entries_snapshot must not contain future deadlines';
    END IF;

    snapshot_open_count := snapshot_open_count + 1;
    IF entry_due_date < NEW.review_date THEN
      snapshot_overdue_count := snapshot_overdue_count + 1;
    ELSE
      snapshot_due_today_count := snapshot_due_today_count + 1;
    END IF;
  END LOOP;

  IF NEW.open_count IS DISTINCT FROM snapshot_open_count
     OR NEW.overdue_count IS DISTINCT FROM snapshot_overdue_count
     OR NEW.due_today_count IS DISTINCT FROM snapshot_due_today_count THEN
    RAISE EXCEPTION
      'deadline daily review counters do not match entries_snapshot (% open, % overdue, % due today)',
      snapshot_open_count,
      snapshot_overdue_count,
      snapshot_due_today_count;
  END IF;

  RETURN NEW;
END;
$function$;
