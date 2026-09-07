---
id: GWG-RISK-REVIEW-001
title: Regelbasierten Risikoentwurf nur durch zugeordneten Berufsträger freigeben
domain: gwg
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Geldwäscheprävention
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    TaxTronik berechnet aus sechs vollständig zu beantwortenden Faktoren einen
    reproduzierbaren Risikovorschlag, erzwingt bei PEP-Angabe die Stufe HIGH und
    trennt Vorbereitung, Einreichung und ausdrückliche Freigabe durch den dem
    Mandanten zugeordneten Berufsträger. Der Score ersetzt keine gesetzliche
    Risikoanalyse oder verstärkte Sorgfaltspflicht.
sources:
  - kind: product_documentation
    citation: GwG-Pflichten und technische Umsetzung in TaxTronik
    path: docs/compliance/gwg.md
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 10 Abs. 1 Nr. 3 bis 5 und Abs. 2 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__10.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 15 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__15.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 8 Abs. 1 Nr. 2 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__8.html
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/gwg-page-data.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/gwg-page-assessment.tsx
  - apps/web/src/server/mandate-expansion/gwg-structure.ts
  - apps/web/src/server/screening/gwg-gate.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/decision-forms.tsx
  - packages/db/prisma/migrations/20260831102000_staff_professional/migration.sql
  - apps/web/src/server/gwg/risk-score.ts
  - apps/web/src/server/gwg/verification.ts
  - apps/web/src/server/gwg/professional-review.ts
  - apps/web/src/server/gwg/review-snapshot.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/actions.ts
test_refs:
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/page-render.test.tsx
  - apps/web/src/server/mandate-expansion/__tests__/service-db.test.ts
  - apps/web/src/server/screening/__tests__/gwg-gate.test.ts
  - apps/web/src/server/gwg/__tests__/risk-score.test.ts
  - apps/web/src/server/gwg/__tests__/verification.test.ts
  - apps/web/src/server/gwg/__tests__/professional-review.test.ts
  - apps/web/src/server/gwg/__tests__/lifecycle-lock-call-sites.test.ts
  - packages/db/src/__tests__/gwg-professional-lock.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
feature_refs:
  - FEATURES.md
  - docs/compliance/gwg.md
related_rules:
  - MANDATE-STRUCTURE-001
  - GWG-SCREENING-001
  - GWG-ACTIVATION-GATE-001
  - GWG-BENEFICIAL-OWNERS-001
  - GWG-REVERIFICATION-VALIDITY-001
tags:
  - risiko
  - pep
  - berufstraeger
  - vier-augen-prinzip
---

# GWG-RISK-REVIEW-001 — Regelbasierten Risikoentwurf nur durch zugeordneten Berufsträger freigeben

## Kurzfassung

TaxTronik erzeugt aus sechs manuell beantworteten Risikofaktoren einen
reproduzierbaren Vorschlag für `LOW`, `MEDIUM` oder `HIGH`. Eine PEP-Angabe
erzwingt unabhängig vom Summenscore `HIGH`. Erst nach vollständiger
Identifizierungs- und Risikoprüfung kann der Entwurf eingereicht und durch den
dem Mandanten zugeordneten Berufsträger ausdrücklich freigegeben werden.

Faktoren, Gewichte, Schwellen und Wiederholungsintervalle sind Produktregeln,
keine gesetzlich festgelegten Punktwerte. Die Freigabe bestätigt einen
angezeigten Snapshot, ersetzt aber weder die kanzleiweite Risikoanalyse noch
verstärkte oder laufende Sorgfaltspflichten.

## Wann gilt die Regel?

Die Regel gilt für jeden GwG-Prüfsnapshot, der in TaxTronik vom Entwurf in die
Berufsträgerprüfung und anschließend gegebenenfalls auf `VERIFIED` wechseln
soll. Sie gilt nicht als automatische Einstufung eines Sachverhalts ohne
vollständige manuelle Eingaben.

Kanzleiweite Risiken nach §§ 4 und 5 GwG, interne Sicherungsmaßnahmen nach § 6
GwG, konkrete Transaktionsüberwachung und Verdachtsmeldungen sind nicht Teil
dieser Score- und Freigaberegel.

## Benötigte Angaben

- Antworten zu Jurisdiktion, Branche, PEP, Bargeldintensität,
  Eigentümertransparenz und Transaktions-/Geschäftsmodellkomplexität
- hinterlegte Produktgewichte und Schwellenwerte
- vollständiger Identitäts-, Vertretungs- und Berechtigten-Snapshot
- PEP-Angabe je wirtschaftlich Berechtigtem
- Mitarbeiter der Vorbereitung und Zeitpunkt der Einreichung
- zugeordneter aktiver Mitarbeiter mit ausdrücklich gepflegter Berufsträgerqualifikation
- Hash des vollständig angezeigten Review-Snapshots
- ausdrückliche Berufsträgerbestätigung

## Entscheidungslogik

| Wenn                                                                      | Dann                                                          | Begründung                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------- |
| Ein Risikofaktor fehlt oder enthält keinen zulässigen Wert                | Speichern beziehungsweise Einreichen ablehnen                 | Unvollständiger Risikovorschlag               |
| Alle Faktoren liegen vor                                                  | Score als Summe aus Antwortwert mal Gewicht berechnen         | Reproduzierbare Produktlogik                  |
| Score ist kleiner als 10                                                  | Vorschlag `LOW`                                               | Produktschwelle                               |
| Score ist mindestens 10 und kleiner als 25                                | Vorschlag `MEDIUM`                                            | Produktschwelle                               |
| Score ist mindestens 25                                                   | Vorschlag `HIGH`                                              | Produktschwelle                               |
| PEP-Faktor ist positiv                                                    | Unabhängig vom Score `HIGH` erzwingen                         | PEP darf nicht als LOW/MEDIUM durchlaufen     |
| Berechtigten-Snapshot enthält PEP, Faktor oder Stufe passen aber nicht    | Einreichung und Freigabe blockieren                           | Widerspruch im Snapshot                       |
| Vollständiger Entwurf wird eingereicht                                    | Status `IN_REVIEW`, Einreicher und Zeitpunkt speichern        | Nachvollziehbare Übergabe                     |
| Nicht zugeordneter Mitarbeiter oder veralteter Snapshot versucht Freigabe | Freigabe blockieren                                           | Zuständigkeit und Anzeige-CAS                 |
| Zugeordneter Berufsträger bestätigt den aktuellen vollständigen Snapshot  | `VERIFIED`, Prüfer, Zeitpunkt und Produktgültigkeit speichern | Ausdrückliche menschliche Produktentscheidung |

## Ausnahmen und Grenzfälle

- PEP, Familienmitglieder und bekanntermaßen nahestehende Personen müssen
  fachlich richtig eingeordnet werden; die Software prüft nur die übermittelten
  Angaben.
- Die Auswahl „Hochrisikoland“ beruht auf der Eingabe des Mitarbeiters. Es gibt
  keinen automatisch aktualisierten amtlichen Länderlistenabgleich.
- Ein hoher Score löst keine eigenen Workflows für Mittelherkunft,
  Führungsebenenzustimmung oder verstärkte kontinuierliche Überwachung aus.
- Der zugeordnete Berufsträger ist nicht zwingend das nach § 15 GwG erforderliche
  Mitglied der Führungsebene.
- Ein vollständiger Score kann fachlich unzutreffend sein, wenn Tatsachen oder
  Risikofaktoren fehlen.

## Beispiele

### Normalfall

Alle sechs Faktoren sind beantwortet und ergeben einen Score von 8. Der
Vorschlag lautet `LOW`. Nach vollständiger Identifizierung reicht ein
Mitarbeiter den Snapshot ein; der zugeordnete Berufsträger prüft ihn, bestätigt
den aktuellen Hash und gibt ihn frei.

### Grenzfall

Der gewichtete Score wäre 15 und damit `MEDIUM`; ein wirtschaftlich
Berechtigter ist jedoch als PEP erfasst. TaxTronik verlangt einen positiven
PEP-Faktor und erzwingt `HIGH`. Ob zusätzlich alle erforderlichen verstärkten
Sorgfaltspflichten erfüllt wurden, entscheidet und dokumentiert das Scoremodul
nicht.

## Umsetzung in TaxTronik

Der Datenlader der Staff-Einzelprüfung verwendet den gemeinsamen lesenden Berufsträger-Helper für die aktuelle aktive qualifizierte Mandantenzuordnung. Risikobewertung und Entscheidung sind eigene Darstellungsabschnitte; der Freigabehash wird weiterhin aus dem vollständigen unveränderten geladenen Snapshot erzeugt. Transaktionale Entscheidungslogik, Sperren und Auditierung bleiben unverändert.

Bei aktiviertem Zusatzmodul `sanctionsScreening` prüft der bestehende
Freigabepfad vor dem VERIFIED-Claim zusätzlich **GWG-SCREENING-001**: aktuelle
erfolgreich geprüfte Quelle, Nachweise für alle aktuellen Mandanten-/Vertreter-/
Berechtigtenziele, Bindung an den aktuellen Prüfsnapshot, geklärte
Sanktionskandidaten und abgeschlossene manuelle PEP-Recherchen. Ein PEP-Fund
erfordert die vorhandene HIGH-/PEP-Risikoeinstufung. Diese Ergänzung ändert keine
bestehende Freigabe und vergibt selbst keine Berufsträgerfreigabe. Das Modul
bleibt standardmäßig aus; sein Entwurf ist fachlich ungeprüft.

`risk-score.ts` enthält Faktoren, Standardgewichte, Schwellen und PEP-Override.
Die Staff-Action validiert jede Antwort und speichert Score, Stufe und
Aufschlüsselung. Jede inhaltliche Änderung setzt eine laufende Einreichung auf
`DRAFT` zurück.

Das einheitliche Entscheidungsgate prüft Risiko und Identifikation sowohl bei
der Einreichung als auch bei der finalen Entscheidung. Verifizieren darf nur
ein aktiver, als `isProfessional` qualifizierter und dem Mandanten als
`BERUFSTRAEGER` zugeordneter Mitarbeiter mit gültiger Staff-Rolle. Diese Angaben
werden bei Freigabe und Ablehnung frisch aus der Datenbank gelesen. Vorher gilt
die Sperrreihenfolge Mandanten-Lifecycle, Mitarbeiterzeile, Berufsträgerzuordnung,
Staff-Rollenzeilen. Die Zeilen werden mit `FOR SHARE` bis zum Transaktionsende
gehalten. Ein paralleler Qualifikationsentzug, eine Deaktivierung oder Löschung
der Zuordnung beziehungsweise letzten Rolle wird damit vor oder nach der
Entscheidung wirksam, nicht zwischen Berechtigungsprüfung und Commit.
Fehlt eine zu sperrende Zeile, wird die Entscheidung abgewiesen. Reine
UI-Leseprüfungen erwerben diese Sperren nicht. ADMIN/PARTNER oder eine veraltete
Session ersetzen keine der Voraussetzungen. Auch die
Empfängerauswahl bei Einreichung und neue Zuordnungen beachten die Qualifikation.
Ein Entzug sperrt neue Entscheidungen, ändert aber keine früheren Freigaben. Status,
Übergabe, neuester Prüfzyklus, Snapshot-Hash und ausdrückliche Bestätigung werden
im selben Entscheidungspfad geprüft und auditiert.

## Bekannte Abweichungen und Grenzen

Innerhalb des beschriebenen Score- und Produktfreigabe-Scopes sind keine
bekannten technischen Abweichungen festgestellt. Fachlich bleiben wesentliche
Grenzen:

- Die im Kommentar erwähnte Tenant-Konfiguration `gwg.risk_weights` wird vom
  aktuellen Action-Pfad nicht geladen; tatsächlich werden die im Quellcode
  hinterlegten Standardgewichte verwendet.
- Faktoren und Schwellen sind nicht berufsträgerlich freigegeben und nicht aus
  einer amtlichen Bewertungsmatrix abgeleitet.
- Verstärkte Sorgfaltspflichten, Mittelherkunft, Transaktionsüberwachung,
  Führungsebenenentscheidung und FIU-Meldung werden nicht abgearbeitet.
- Die allgemeine Risikoanalyse der Kanzlei und interne Sicherungsmaßnahmen sind
  ausdrücklich nicht implementiert.
- Die Qualifikation ist eine interne Kanzleifestlegung, kein amtlicher
  Zulassungsabgleich. Aus früheren ausdrücklichen Mandatszuordnungen migrierte
  Qualifikationen tragen sichtbar die Herkunft `legacy` bis zur manuellen Bestätigung.

## Fachliche Prüffragen

- Sind Faktoren, Antwortoptionen, Gewichte und Schwellen für die Kanzlei
  geeignet und dokumentiert genehmigt?
- Wer erfüllt bei Hochrisikofällen die erforderliche Führungsebenenfunktion?
- Welche zusätzlichen Maßnahmen müssen vor einer HIGH-Freigabe nachgewiesen
  werden?
- Wie werden Länder-, PEP- und sonstige Risikoinformationen aktuell gehalten?
- Sollen Gewichte tatsächlich tenantbezogen konfigurierbar sein?

## Technische Nachweise

`page-render.test.tsx`: Der SSR-Nachweis prüft Freigabe mit frischer Berufsträgerzuordnung, fehlende Freigabe allein aufgrund ADMIN-Rolle sowie Gleichheit des gerenderten Freigabehashes mit dem vollständigen gespeicherten Snapshot.

Score- und Verifikationstests belegen Schwellen, PEP-Override, vollständige
Antworten, Widerspruchskontrollen und das einheitliche Entscheidungsgate. Die
Action-Tests prüfen Zuordnung, Übergabe, Snapshot-CAS, Statusrennen und Audit.
PostgreSQL-Tests prüfen konkurrierenden Merkmalsentzug und Zuordnungs-/Rollenlöschung
gegen die tatsächlich verwendeten Lesesperren, ohne fachliche Freigaben zu erzeugen.
Kein Test belegt die fachliche Eignung der Risikomatrix oder die Erfüllung
verstärkter Sorgfaltspflichten.

### Ergänzung: neue Strukturübernahme verlangt erneute Einreichung

Die ausdrücklich bestätigte Übernahme einer unveränderlichen Strukturversion nach MANDATE-STRUCTURE-001 verwendet denselben GwG-Lifecycle-Lock und Mutationsclaim wie die bisherigen Fachformulare. Eine laufende Einreichung wird auf DRAFT zurückgesetzt und ihre Einreichungsdaten werden geleert. Nur die neueste offene Prüfung ist zugelassen; abgeschlossene Prüfungen werden nicht verändert. Die Übernahme ist eine dokumentierte Arbeitsgrundlage, keine fachliche Freigabe und keine automatische Ermittlung wirtschaftlich Berechtigter.
