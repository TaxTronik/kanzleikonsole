-- Neue Notification-Art: interne Vorwarnung vor dem automatischen Versand
-- einer Steuertermin-Anforderung ("Auto-Anforderung an <Mandant> geht am ...
-- raus"). Empfaenger sind die HAUPTBEARBEITER des Mandanten (Fallback
-- ADMIN/PARTNER); die Benachrichtigung verlinkt auf die Gruppen-Ansicht mit
-- der Stopp-Aktion.
--
-- Eigenes Migration-File, weil ALTER TYPE ... ADD VALUE nicht zusammen mit
-- Tabellen-DDL in derselben Transaktion laufen darf.

ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'TAX_DEADLINE_REQUEST_PENDING';
