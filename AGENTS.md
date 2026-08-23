# Arbeitsregeln für fachliche Logik

Diese Regeln gelten für Änderungen an steuerlicher, rechtlicher,
compliance-relevanter oder kanzleifachlicher Workflow-Logik.

1. Vor einer Änderung die passenden Einträge in
   `docs/fachkatalog/fachkatalog.json` suchen und die vollständigen Regeldateien
   lesen.
2. Regel-ID(s) in Tests und in der Änderungsdokumentation nennen, soweit eine
   bestehende Regel betroffen ist.
3. Ändert sich fachliches Verhalten, müssen Regel, Umsetzungshinweise und
   Nachweise im selben Commit aktualisiert werden. Ein fehlender Eintrag wird
   als ungeprüfter Entwurf ergänzt.
4. Rechtsquellen, Norminhalte und Freigaben niemals erfinden. Konflikte zwischen
   Katalog, Code, Test und Dokumentation ausdrücklich melden, nicht still
   zugunsten einer Quelle auflösen.
5. KI-Werkzeuge dürfen `professional_review.status` niemals auf `approved`
   setzen und weder `reviewer` noch `reviewed_at` als fachlichen Nachweis
   ausfüllen oder `reviewed_content_hash` für eine Freigabe eintragen. Das ist
   ausschließlich eine dokumentierte Entscheidung eines Berufsträgers.
   Der Hash bindet Inhalte, authentifiziert aber keine Person.
6. Vor Abschluss `pnpm fachkatalog:check` und `pnpm fachkatalog:diff`
   ausführen.

Der Fachkatalog ersetzt weder die Einzelfallprüfung noch die organisatorische
Fristenkontrolle der Kanzlei. Bedienungs- oder Layoutänderungen ohne fachliche
Auswirkung benötigen keinen neuen Katalogeintrag.
