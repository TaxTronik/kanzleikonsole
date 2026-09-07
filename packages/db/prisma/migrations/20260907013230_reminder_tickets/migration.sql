-- Fachkatalog: REMINDER-TICKET-001, ACCESS-TENANT-RLS-001, TAX-CONTROL-STATUS-001.
-- Additive Ticketidentität und operatives Archiv; bestehende UUIDs bleiben gleich.
BEGIN;

-- Stabiler Bestands-Snapshot und keine parallele unnummerierte Neuanlage.
LOCK TABLE public.client_reminder IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.client_reminder
  ADD COLUMN ticket_number INTEGER,
  ADD COLUMN archived_at TIMESTAMPTZ(6),
  ADD COLUMN archived_by_staff UUID,
  ADD COLUMN origin_risk_marking_id UUID;

-- Nur ein eindeutiger aktueller FK belegt die Herkunft; keine Textheuristik.
WITH origins AS (
  SELECT marking.reminder_id, (array_agg(marking.id ORDER BY marking.id))[1] AS marking_id
  FROM public.risk_marking marking
  JOIN public.client_reminder reminder
    ON reminder.id = marking.reminder_id AND reminder.tenant_id = marking.tenant_id
  GROUP BY marking.reminder_id HAVING count(*) = 1
)
UPDATE public.client_reminder reminder
SET origin_risk_marking_id = origins.marking_id
FROM origins WHERE reminder.id = origins.reminder_id;

ALTER TABLE public.risk_marking
  ADD CONSTRAINT risk_marking_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE public.client_reminder
  ADD CONSTRAINT client_reminder_risk_origin_fk FOREIGN KEY (tenant_id, origin_risk_marking_id)
    REFERENCES public.risk_marking(tenant_id, id)
    ON DELETE SET NULL (origin_risk_marking_id) ON UPDATE NO ACTION;
CREATE INDEX client_reminder_risk_origin_idx
  ON public.client_reminder(tenant_id, origin_risk_marking_id);

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id)::INTEGER AS number
  FROM public.client_reminder
)
UPDATE public.client_reminder reminder
SET ticket_number = numbered.number FROM numbered WHERE reminder.id = numbered.id;

ALTER TABLE public.client_reminder
  ALTER COLUMN ticket_number SET NOT NULL,
  ALTER COLUMN ticket_number SET DEFAULT 0,
  ADD CONSTRAINT client_reminder_ticket_number_positive CHECK (ticket_number > 0),
  ADD CONSTRAINT client_reminder_tenant_id_id_key UNIQUE (tenant_id, id),
  ADD CONSTRAINT client_reminder_tenant_ticket_number_key UNIQUE (tenant_id, ticket_number),
  ADD CONSTRAINT client_reminder_archive_completed CHECK (archived_at IS NULL OR (done_at IS NOT NULL AND done_by_staff IS NOT NULL)),
  ADD CONSTRAINT client_reminder_archive_actor CHECK ((archived_at IS NULL) = (archived_by_staff IS NULL));

CREATE INDEX client_reminder_archive_due_idx
  ON public.client_reminder(tenant_id, archived_at, done_at, due_date);

CREATE TABLE public.client_reminder_counter (
  tenant_id UUID NOT NULL,
  last_number INTEGER NOT NULL,
  CONSTRAINT client_reminder_counter_pk PRIMARY KEY (tenant_id),
  CONSTRAINT client_reminder_counter_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenant(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT client_reminder_counter_positive CHECK (last_number > 0)
);
INSERT INTO public.client_reminder_counter(tenant_id, last_number)
SELECT tenant_id, MAX(ticket_number) FROM public.client_reminder GROUP BY tenant_id;

ALTER TABLE public.client_reminder_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_reminder_counter FORCE ROW LEVEL SECURITY;
CREATE POLICY client_reminder_counter_tenant_isolation ON public.client_reminder_counter
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
-- Keine direkte Lesbarkeit oder Manipulation des tenantspezifischen Zählers.
REVOKE ALL ON public.client_reminder_counter FROM PUBLIC, taxtronik_app;

CREATE FUNCTION app.allocate_reminder_ticket_number() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- 0 ist ausschließlich INSERT-Sentinel, niemals ein gespeicherter Wert.
  IF NEW.ticket_number IS NOT NULL AND NEW.ticket_number <> 0 THEN
    RAISE EXCEPTION 'Ticketnummern werden ausschließlich automatisch vergeben.' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.client_reminder_counter AS counter (tenant_id, last_number)
  VALUES (NEW.tenant_id, 1)
  ON CONFLICT (tenant_id) DO UPDATE SET last_number = counter.last_number + 1
  RETURNING last_number INTO NEW.ticket_number;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.allocate_reminder_ticket_number() FROM PUBLIC, taxtronik_app;
CREATE TRIGGER client_reminder_allocate_ticket_number
  BEFORE INSERT ON public.client_reminder
  FOR EACH ROW EXECUTE FUNCTION app.allocate_reminder_ticket_number();

CREATE FUNCTION app.guard_reminder_ticket_identity() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.ticket_number IS DISTINCT FROM OLD.ticket_number THEN
    RAISE EXCEPTION 'Die Identität eines Tickets ist unveränderlich.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.origin_risk_marking_id IS DISTINCT FROM OLD.origin_risk_marking_id
    AND (NEW.origin_risk_marking_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM public.risk_marking WHERE id = OLD.origin_risk_marking_id
    )) THEN
    RAISE EXCEPTION 'Die Rechercheherkunft eines Tickets ist unveränderlich.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_reminder_ticket_identity() FROM PUBLIC, taxtronik_app;
CREATE TRIGGER client_reminder_ticket_identity
  BEFORE UPDATE OF id, tenant_id, ticket_number, origin_risk_marking_id ON public.client_reminder
  FOR EACH ROW EXECUTE FUNCTION app.guard_reminder_ticket_identity();

CREATE TABLE public.client_reminder_reference (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  source_reminder_id UUID NOT NULL,
  target_reminder_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT client_reminder_reference_pk PRIMARY KEY (id),
  CONSTRAINT client_reminder_reference_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenant(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT client_reminder_reference_source_fk FOREIGN KEY (tenant_id, source_reminder_id)
    REFERENCES public.client_reminder(tenant_id, id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT client_reminder_reference_target_fk FOREIGN KEY (tenant_id, target_reminder_id)
    REFERENCES public.client_reminder(tenant_id, id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT client_reminder_reference_pair_key UNIQUE (source_reminder_id, target_reminder_id),
  CONSTRAINT client_reminder_reference_not_self CHECK (source_reminder_id <> target_reminder_id)
);
CREATE INDEX client_reminder_reference_backlink_idx
  ON public.client_reminder_reference(tenant_id, target_reminder_id, created_at);
ALTER TABLE public.client_reminder_reference ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_reminder_reference FORCE ROW LEVEL SECURITY;
CREATE POLICY client_reminder_reference_tenant_isolation ON public.client_reminder_reference
  USING (tenant_id = app.current_tenant_id() AND app.current_actor_type() IN ('STAFF', 'SYSTEM'))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.current_actor_type() IN ('STAFF', 'SYSTEM'));
-- Erwähnungen werden hinzugefügt, nicht überschrieben oder still entfernt.
-- Ein späterer fachlich geprüfter Hard-Delete erfolgt über den Owner-Pfad;
-- die Composite-FKs entfernen dann nur die zugehörigen Kanten.
REVOKE ALL ON public.client_reminder_reference FROM PUBLIC, taxtronik_app;
GRANT SELECT, INSERT ON public.client_reminder_reference TO taxtronik_app;

COMMIT;
