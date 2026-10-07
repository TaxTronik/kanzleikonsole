-- YEAR-END-CAMPAIGN-001 (Fortschrittsanzeige der Jahreswechsel-Übersicht),
-- FORM-SCHEMA-SNAPSHOT-001 (eingefrorener Formularstand bleibt unverändert).
--
-- Review-Finding P-19. Die Übersicht berechnete den technischen
-- Bearbeitungsfortschritt je angezeigtem Eintrag im Render aus eingefrorenem
-- Schema und Antworten (beides JSON, je Feld eine Validierung). Jetzt
-- berechnen ihn die Schreibpfade, die Antworten ändern (Portal: Entwurf,
-- Abgabe, Datei anfügen/lösen; Kampagnen-Rollout), mit derselben Funktion
-- (formAnswerProgress) aus genau den gespeicherten Antworten und schreiben ihn
-- im selben Update in diese Spalten. Die Übersicht liest nur noch die Zahlen.
--
-- answer_progress_at: Zeitpunkt der Berechnung; NULL = kein gespeicherter Wert
-- (Altbestand, andere Schreibpfade) – dann rechnet die Übersicht wie bisher
-- selbst. Gesetzt mit leeren Zahlen = Formularstand nicht auswertbar („nicht
-- berechenbar“).
--
-- Backfill: nur dort, wo der Wert ohne die Validierungslogik der Anwendung
-- feststeht – Jahreswechsel-Einreichungen (einziger Leser) mit leeren
-- Antworten ('{}', z. B. noch nicht begonnene Rollout-Einträge) und einem
-- Snapshot im Format von readFormSchema (Version 1, jedes Feld vollständig).
-- Für sie ergibt formAnswerProgress 0 von N Eingabefeldern (ohne INFO_TEXT)
-- und 0 von M Pflichtfeldern. Einreichungen mit Antworten hängen an der
-- Feldvalidierung (validateFormAnswers); ein SQL-Nachbau könnte davon abweichen.
-- Sie bleiben NULL, bis sie das nächste Mal gespeichert werden; bis dahin
-- rechnet die Übersicht für sie seitenweise selbst (wie vor dieser Migration).
--
-- Der Trigger setzt den Wert zurück, wenn ein Update die Antworten ändert,
-- ohne den Fortschritt neu zu berechnen (answer_progress_at unverändert, z. B.
-- DSGVO-Anonymisierung). So zeigt die Übersicht nie einen Fortschritt zu
-- früheren Antworten. Der eingefrorene Schema-Snapshot bleibt unveränderlich
-- (app.freeze_submission_schema unverändert).
--
-- Aufwand beim Deploy: neue Spalten ohne Default sind reine Katalogänderungen;
-- der CHECK prüft den Bestand in einem Lauf über form_submission (alle NULL).
-- Der Backfill schreibt je betroffener Einreichung eine Zeilenversion (keine
-- Änderung an answers, schema_snapshot oder updated_at).
BEGIN;

ALTER TABLE public.form_submission
  ADD COLUMN answer_progress_at TIMESTAMPTZ(6),
  ADD COLUMN answer_progress_filled INTEGER,
  ADD COLUMN answer_progress_total INTEGER,
  ADD COLUMN answer_progress_required_filled INTEGER,
  ADD COLUMN answer_progress_required_total INTEGER,
  ADD CONSTRAINT form_submission_answer_progress_check CHECK (
    (answer_progress_filled IS NULL
      AND answer_progress_total IS NULL
      AND answer_progress_required_filled IS NULL
      AND answer_progress_required_total IS NULL)
    OR (answer_progress_at IS NOT NULL
      AND answer_progress_filled IS NOT NULL
      AND answer_progress_total IS NOT NULL
      AND answer_progress_required_filled IS NOT NULL
      AND answer_progress_required_total IS NOT NULL
      AND answer_progress_filled BETWEEN 0 AND answer_progress_total
      AND answer_progress_required_filled BETWEEN 0 AND answer_progress_required_total
      AND answer_progress_required_total <= answer_progress_total
      AND answer_progress_required_filled <= answer_progress_filled)
  );

COMMENT ON COLUMN public.form_submission.answer_progress_at IS
  'P-19: Berechnungszeitpunkt des gespeicherten Fortschritts (formAnswerProgress der gespeicherten Antworten); NULL = nicht gespeichert, Zahlen leer = nicht berechenbar.';

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

CREATE TRIGGER form_submission_answer_progress_stale
  BEFORE UPDATE OF answers ON public.form_submission
  FOR EACH ROW EXECUTE FUNCTION app.reset_stale_answer_progress();

-- P-19 Backfill (Anfang). Die Gültigkeitsprüfung entspricht dem zod-Schema in
-- apps/web/src/server/forms/schema-snapshot.ts; fehlende Schlüssel ergeben NULL
-- und damit „nicht nachtragen“ (IS NOT TRUE). Die Zählungen im SET laufen nur
-- für Zeilen, die die Prüfung bestanden haben (fields ist dann ein Array).
UPDATE public.form_submission AS submission
   SET answer_progress_at = now(),
       answer_progress_filled = 0,
       answer_progress_required_filled = 0,
       answer_progress_total = (
         SELECT count(*)
           FROM jsonb_array_elements(submission.schema_snapshot -> 'fields') AS f(field)
          WHERE f.field ->> 'type' <> 'INFO_TEXT'
       ),
       answer_progress_required_total = (
         SELECT count(*)
           FROM jsonb_array_elements(submission.schema_snapshot -> 'fields') AS f(field)
          WHERE f.field ->> 'type' <> 'INFO_TEXT'
            AND f.field -> 'required' = 'true'::jsonb
       )
 WHERE submission.answer_progress_at IS NULL
   AND submission.answers = '{}'::jsonb
   AND EXISTS (
     SELECT 1
       FROM public.year_end_campaign_entry AS entry
      WHERE entry.submission_id = submission.id
   )
   AND jsonb_typeof(submission.schema_snapshot) = 'object'
   AND submission.schema_snapshot -> 'version' = '1'::jsonb
   AND jsonb_typeof(submission.schema_snapshot -> 'name') = 'string'
   AND jsonb_typeof(submission.schema_snapshot -> 'description') IN ('string', 'null')
   AND jsonb_typeof(submission.schema_snapshot -> 'introMd') IN ('string', 'null')
   AND CASE
         WHEN jsonb_typeof(submission.schema_snapshot -> 'fields') = 'array' THEN NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(submission.schema_snapshot -> 'fields') AS f(field)
            WHERE (
                    jsonb_typeof(f.field) = 'object'
                    AND jsonb_typeof(f.field -> 'id') = 'string'
                    AND jsonb_typeof(f.field -> 'key') = 'string'
                    AND jsonb_typeof(f.field -> 'label') = 'string'
                    AND jsonb_typeof(f.field -> 'type') = 'string'
                    AND f.field ->> 'type' IN (
                      'TEXT', 'TEXTAREA', 'EMAIL', 'PHONE', 'NUMBER', 'MONEY', 'DATE',
                      'SELECT', 'MULTISELECT', 'CHECKBOX', 'FILE', 'INFO_TEXT'
                    )
                    AND jsonb_typeof(f.field -> 'required') = 'boolean'
                    AND jsonb_typeof(f.field -> 'helpText') IN ('string', 'null')
                    AND jsonb_typeof(f.field -> 'defaultValue') IN ('string', 'null')
                    AND jsonb_typeof(f.field -> 'minValue') IN ('string', 'null')
                    AND jsonb_typeof(f.field -> 'maxValue') IN ('string', 'null')
                  ) IS NOT TRUE
         )
         ELSE false
       END;
-- P-19 Backfill (Ende).

COMMIT;
