CREATE OR REPLACE FUNCTION app.legal_final_reason_sufficient(p_reason text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  -- TAX-CONTROL-STATUS-001: Bestandskraft verlangt eine nachvollziehbare
  -- Begründung von mindestens zehn Zeichen. Am Rand entfallen genau die Zeichen,
  -- die String.prototype.trim() in JavaScript entfernt (ECMAScript WhiteSpace
  -- und LineTerminator); length() zählt Zeichen. NULL ist keine Begründung.
  SELECT COALESCE(
    length(
      btrim(
        p_reason,
        E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'
      )
    ) >= 10,
    false
  )
$function$;
