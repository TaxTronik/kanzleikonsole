-- iter73: Mandatsende am Mandanten (GwG § 8 Abs. 4 Pflichtlöschung)
--
-- Die 5-Jahres-Aufbewahrungsfrist für GwG-Belege beginnt mit dem Schluss des
-- Kalenderjahres, in dem die Geschäftsbeziehung ENDET (nicht bei Dokument-
-- erstellung — darauf setzt nur das Object-Lock-Retain-Until). Ohne ein
-- Mandatsende-Datum lässt sich die gesetzliche Löschfrist nicht berechnen.
-- Gesetzt = Mandat beendet → startet die Lösch-Uhr für die Review-Queue.

ALTER TABLE "client" ADD COLUMN "mandate_ended_at" TIMESTAMPTZ(6);
