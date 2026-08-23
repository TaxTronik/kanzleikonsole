# Kalender, Steuerfristen und Bescheide

Das Modul bündelt Kanzleitermine, gesetzliche Steuertermine und
Bescheidfristen. Automatisch berechnete Fristen sind Kontrollvorschläge und
müssen bei abweichender Bekanntgabe oder besonderen Rechtsbehelfsregeln
fachlich geprüft werden.

## 1. Kanzleikalender und Terminanfragen

Unter **Kalender** werden Kanzleitermine, Steuertermine und weitere
fristenführende Einträge in einer Monatsansicht zusammengeführt. Die fokussierte
Ansicht **Steuertermine** gruppiert nach Steuerart und Zeitraum.

Portalnutzer sehen bestätigte eigene Termine. Neue Wunschtermine können sie nur
anfragen, wenn das Portal-Feature **Terminanfragen** aktiviert ist. Eine Anfrage
ist noch kein bestätigter Termin; die Kanzlei nimmt sie an, ändert oder lehnt
sie ab. Als Wunsch-Bearbeiter werden im offenen Zugriffsmodus alle aktiven
Mitarbeiter angeboten. Im eingeschränkten Modus und bei vertraulichen Mandanten
beschränkt sich die Auswahl auf Admin/Partner und zuständige Mitarbeiter; die
gleiche Prüfung erfolgt nochmals serverseitig.

## 2. Steuertermine und Auto-Anforderungen

Der Worker materialisiert Termine aus der aktiven Kanzleikonfiguration. Vor
einer automatischen Mandantenanforderung erscheint eine interne Vorwarnung; die
Kanzlei kann den Lauf stoppen, wenn Unterlagen bereits vorliegen. Erzeugung und
Verknüpfung sind idempotent: parallele Worker-/Webläufe dürfen nur eine
Anforderung erzeugen.

Am Fälligkeitstag bleibt ein Termin bis zum Tagesende offen. Erst danach wird
er überfällig. Feiertags- und Bundeslandkonfigurationen sollten vor dem ersten
Produktivlauf geprüft werden.

## 3. Bescheid erfassen

Im Mandantenprofil unter **Bescheide & Steuererklärungen** werden Steuerart,
Zeitraum, Bescheiddatum, Übermittlungsweg und der für diesen Weg maßgebliche
Bekanntgabe-/Zugangszeitpunkt erfasst. Der Übermittlungsweg ist entscheidend:

- Post beziehungsweise elektronische Übermittlung im Inland,
- Post ins Ausland,
- Datenabruf,
- förmliche, persönliche oder sonst nachgewiesene Bekanntgabe.

Für bis einschließlich 31.12.2025 erlassene Verwaltungsakte im Datenabruf
werden Benachrichtigungsdatum und gegebenenfalls tatsächlicher Abruf benötigt.
Für nach dem 31.12.2025 erlassene Verwaltungsakte gilt die Vier-Tage-Fiktion
ab Bereitstellung.
Bei fehlender/unrichtiger Rechtsbehelfsbelehrung wird statt der Monatsfrist die
gesetzliche Jahresfrist berücksichtigt.

## 4. Rechtsbehelfsstatus

Der abgebildete Lebenszyklus lautet:

`NEU → GEPRÜFT → EINSPRUCH → ABGEHOLFEN / TEILABHILFE /
ZURÜCKGEWIESEN → KLAGE oder RECHTSKRÄFTIG`.

`ABGEHOLFEN` kann unmittelbar rechtskräftig abgeschlossen werden.
`TEILABHILFE` und `ZURÜCKGEWIESEN` eröffnen die gesondert überwachte
Klagefrist nach § 47 FGO. Der Status `KLAGE` verlangt den dokumentierten
Einreichungszeitpunkt; erst danach ist die Klagefrist als erledigt behandelt.

## 5. Kontrollpflicht

Prüfen Sie insbesondere tatsächlichen späteren Zugang, Bundesland/Feiertage,
Auslandsfälle, Rechtsbehelfsbelehrung und nachträglich erfasste Altbescheide.
TaxTronik ersetzt keine rechtliche Einzelfallprüfung und keine
Fristenkontrollorganisation der Kanzlei.
