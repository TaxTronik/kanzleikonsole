-- iter72: clientId-führender Index auf client_reminder
--
-- Die Mandanten-Detailseite (clients/[id]) lädt die Wiedervorlagen via
--   WHERE client_id = $1  ORDER BY done_at ASC, due_date ASC
-- Die bestehenden Indizes führen mit assignee_staff_id bzw. tenant_id (+due_date)
-- — keiner mit client_id. Über RLS wird zwar tenant_id ergänzt, aber der
-- client_reminder_due_idx muss dann alle Wiedervorlagen des Tenants scannen, um
-- die eines Mandanten herauszufiltern. Bei vielen Wiedervorlagen pro Tenant ist
-- das auf einer pro-Seitenaufruf-Query spürbar.
--
-- (client_id, done_at, due_date) bedient Filter UND Sortierung der Detailseite
-- direkt (btree ASC = NULLS LAST, deckt sich mit dem Default des orderBy).

CREATE INDEX "client_reminder_client_idx" ON "client_reminder" ("client_id", "done_at", "due_date");
