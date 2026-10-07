CREATE OR REPLACE FUNCTION app.reset_stale_answer_progress()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  -- P-19: Antworten geändert, Fortschritt nicht im selben Update neu berechnet.
  IF NEW.answers IS DISTINCT FROM OLD.answers
     AND NEW.answer_progress_at IS NOT DISTINCT FROM OLD.answer_progress_at THEN
    NEW.answer_progress_at := NULL;
    NEW.answer_progress_filled := NULL;
    NEW.answer_progress_total := NULL;
    NEW.answer_progress_required_filled := NULL;
    NEW.answer_progress_required_total := NULL;
  END IF;
  RETURN NEW;
END $function$;
