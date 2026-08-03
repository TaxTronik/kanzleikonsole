-- Mandanten anlegen ist nicht mehr für jede:n Mitarbeiter:in offen:
-- Admin/Partner implizit, EMPLOYEE nur mit explizitem Grant (auditiert
-- über die Benutzerverwaltung) — gleiches Muster wie INVOICE_MANAGE.
ALTER TYPE "staff_permission_name" ADD VALUE IF NOT EXISTS 'CLIENT_CREATE';
