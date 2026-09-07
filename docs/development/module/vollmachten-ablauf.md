# Vollmachten: technischer Ablaufworker

`apps/worker/src/jobs/poa-expiry-check.ts` verarbeitet ausschließlich signierte
Vollmachten mit gesetztem `validUntil`. Das Datum gilt einschließlich des
Berliner Kalendertags; erst am Folgetag ist der technische Ablauf fällig.
Das Warnfenster bleibt bei 30 Tagen. Maßgeblich ist `POA-LIFECYCLE-001`;
materiell-rechtliche Wirkung und außerhalb des Produkts erklärte Widerrufe
werden dadurch nicht bewertet.

Der Worker lädt zunächst nur Kandidatenkennungen. Eine Transaktion pro
Vollmacht sperrt die Fachzeile und liest ihren aktuellen Zustand erneut.
Widerrufene, gelöschte oder nicht mehr fällige Kandidaten erzeugen keine
veralteten Hinweise. Der gemeinsame Accessfilter prüft aktuelle aktive
Verantwortliche, hilfsweise ADMIN/PARTNER (`ACCESS-NOTIFICATION-RECIPIENT-001`).

EXPIRED, Auflösung der bisherigen Ablaufwarnung, `poa.expire` und neue Hinweise
liegen in derselben Transaktion. Schlägt ein Hinweis fehl, bleibt der Vorgang
SIGNED und ist vollständig wiederholbar. Ohne Empfänger werden Status und
Evidence trotzdem geschrieben; eine persönliche Nachricht kann dann nicht
entstehen. Die Ergebniszähler `soon`/`expired` zählen weiterhin Empfängerhinweise,
nicht Statuswechsel. Kein SMTP- oder n8n-Aufruf erfolgt in diesem Job.

Die Worker-Tests prüfen inklusive Datumsgrenzen, Zuständigkeiten, gemeinsamen
Transaktionskontext, verlorenen Status-Claim sowie Rollback/Retry im synthetischen
Transaktionsmodell. Ein ergänzender isolierter PostgreSQL-18-Lauf am 07.09.2026
hat vier Fälle mit echten SQL-Schreiboperationen geprüft: ein nach dem
Notification-Insert ausgelöster SQL-Fehler rollt Status, Audit und Hinweis
zurück; Retry und Wiederholung erzeugen sie genau einmal. Ohne aktive Empfänger
bleibt der Status-/Auditfortschritt erhalten. Zwei konkurrierende Widerrufe
(Ablauf und Warnung) belegen über `pg_blocking_pids` das tatsächliche Warten auf
den Row-Lock und das anschließende Verwerfen des überholten Kandidaten. Der
Test ruft den echten Prozessor mit abgefangenem BullMQ-Start auf; er prüft keinen
Queue-Transport oder externen Versand.
