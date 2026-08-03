-- Zuweisung einer Wiedervorlage: die zuständige Person erfährt sofort davon.
-- Bisher gab es nur die tägliche Fälligkeits-Erinnerung — eine frisch
-- delegierte Aufgabe blieb bis zum nächsten Tageslauf unbemerkt.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'CLIENT_REMINDER_ASSIGNED';
