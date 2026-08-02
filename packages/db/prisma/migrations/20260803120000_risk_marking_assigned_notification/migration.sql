-- Neue Notification-Art: Zuweisung einer Subsumtions-Markierung.
--
-- Bisher loeste weder der Weg ueber "Verantwortlich" noch der ueber "Zuweisen"
-- eine Benachrichtigung aus. Der Delegationsweg legte lediglich eine
-- Wiedervorlage an, deren erste Meldung fruehestens am Faelligkeitstag
-- (Default +14 Tage) durch den Tages-Worker kam — der Empfaenger erfuhr also
-- zwei Wochen lang nichts von seiner Aufgabe.
--
-- Eigenes Migration-File, weil ALTER TYPE ... ADD VALUE nicht zusammen mit
-- Tabellen-DDL in derselben Transaktion laufen darf.

ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'RISK_MARKING_ASSIGNED';
