# Fachregeln erstellen und prüfen

## Rollen

- **Autor:** strukturiert die Regel, belegt den tatsächlichen Programmstand und
  sammelt Quellen. Das kann auch ein Entwickler oder KI-Werkzeug sein.
- **Fachlicher Verantwortlicher:** beantwortet offene Fachfragen und bestimmt
  den fachlichen Geltungsbereich.
- **Freigebender Berufsträger:** prüft Regel, Quellen, Ausnahmen und Beispiele
  und dokumentiert die Freigabe. Autor und Freigebender müssen organisatorisch
  unterschiedliche Personen sein. Das Katalogwerkzeug allein kann diese
  Identitäten nicht authentifizieren.
- **Technischer Reviewer:** prüft, ob Code- und Testnachweise die behauptete
  Umsetzung tatsächlich tragen.

## Ablauf

1. [VORLAGE.md](VORLAGE.md) nach
   `regeln/<fachbereich>/<regel-id>-<kurztitel>.md` kopieren.
2. Aussage so eng formulieren, dass die Entscheidungstabelle eindeutig und
   testbar bleibt. Mehrere voneinander unabhängige Entscheidungen werden in
   mehrere Regeln geteilt.
3. Primärquellen bevorzugen. Norm, Verwaltungsauffassung,
   Kanzlei-Auslegung und Produktentscheidung nicht vermischen.
4. Den tatsächlichen Umsetzungsstand anhand von Code und Tests bestimmen.
   Fehlende oder abweichende Fälle offen benennen.
5. Mindestens eine einschlägige Testdatei mit dem Kommentar
   `Fachkatalog: <REGEL-ID>` der Regel zuordnen.
6. `pnpm fachkatalog:generate` und anschließend
   `pnpm fachkatalog:check` ausführen.
7. Fachreview durchführen. Erst danach darf ein Berufsträger den Hash mit
   `pnpm fachkatalog:review-hash -- <REGEL-ID>` ermitteln und zusammen mit
   `professional_review.status: approved`, Name und Prüfdatum eintragen.

## Authentizität einer Freigabe

`reviewed_content_hash` bindet die Freigabe an genau den geprüften Inhalt. Er
beweist aber weder die Identität noch die Berufsqualifikation der eingetragenen
Person, weil jeder Repository-Schreibberechtigte einen SHA-256-Hash berechnen
kann. Vor der ersten echten Freigabe muss die Repository-Administration deshalb
geschützte Branches und eine verpflichtende Freigabe der Regelpfade durch eine
Berufsträger-CODEOWNERS-Gruppe einrichten oder eine gleichwertige signierte
Attestation etablieren. Bis dahin bleibt auch ein technisch gültiger
`approved`-Eintrag nur eine nicht authentifizierte Dokumentationsbehauptung.

Bei einer rein technischen, nachweislich verhaltensneutralen Änderung an einem
überwachten Fachpfad wird statt einer Regeländerung ein neuer strukturierter
Datensatz im YAML-Kopf von [AENDERUNGEN.md](AENDERUNGEN.md) ergänzt. Pfade,
Regel-IDs, Begründung, Tests und prüfende Person sind Pflicht; bestehende
Ausnahmen sind unveränderlich. Diese Ausnahme darf keine fachliche Entscheidung
oder bekannte Abweichung verstecken.

## Checkliste für Berufsträger

- Ist die **Kurzfassung** ohne technische Vorkenntnisse verständlich?
- Sind Normtext, fachliche Auslegung, Kanzleientscheidung und Produktablauf
  richtig typisiert und voneinander getrennt?
- Passt der angegebene Rechts- und Geltungsstand zum geprüften Fall?
- Enthält die Entscheidungstabelle alle benötigten Eingaben und Ergebnisse?
- Sind Sonderfälle, Beweisfragen, Ermessensentscheidungen und manuelle
  Kontrollen sichtbar?
- Zeigen die Beispiele mindestens einen Normalfall und einen Grenzfall?
- Werden Automatik-Ergebnisse nur dort als verbindlich bezeichnet, wo das
  fachlich tatsächlich vertretbar ist?
- Sind bekannte Abweichungen zwischen Soll und Software vollständig genannt?
- Sind Quellen erreichbar, einschlägig und am angegebenen Tag geprüft?

## Statuswechsel

```text
unreviewed → in_review → approved → superseded
      ↑           │
      └───────────┘  bei wesentlichem Überarbeitungsbedarf
```

Eine inhaltliche Änderung an einer freigegebenen Regel lässt den gespeicherten
`reviewed_content_hash` fehlschlagen und setzt sie grundsätzlich zurück auf
`in_review`. Rein redaktionelle Korrekturen ohne Bedeutungsänderung können erst
nach dokumentierter Bestätigung mit einem neuen Hash freigegeben bleiben.

Eine abgelöste Regel bleibt im Git-Verlauf und möglichst als Datei erhalten.
Sie verweist über `related_rules` auf ihre Nachfolge. Geltungszeiträume dürfen
sich nur überschneiden, wenn die Abgrenzung im Text ausdrücklich erklärt ist.

## KI-gestützte Entwicklung

KI-Werkzeuge nutzen zuerst `fachkatalog.json`, lesen dann jede betroffene
Regel vollständig und vergleichen Anforderung, Code, Test und Dokumentation.
Bei Widersprüchen muss die Abweichung gemeldet werden. Eine KI darf weder
Quelleninhalte ergänzen, die sie nicht geprüft hat, noch fachliche Freigaben
erteilen oder Reviewidentitäten eintragen.
