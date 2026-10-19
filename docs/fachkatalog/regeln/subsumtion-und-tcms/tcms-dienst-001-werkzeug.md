---
id: TCMS-DIENST-001
title: Tax-CMS als Werkzeug – fachliche Entscheidungen trifft der Dienst, die kanzleikonsole zeigt an
domain: subsumtion-und-tcms
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger TCMS und Qualitätssicherung
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Rechte, Vier-Augen-Prinzip, §-153-Würdigung, Vertraulichkeit und
    Statusübergänge entscheidet der Tax-CMS-Dienst. Die Oberflächen der
    kanzleikonsole zeigen dessen Antworten an, bilden Fehler über feste Texte
    ab und rechnen nichts nach. Umgesetzt sind Cockpit, Kontakte & Rollen,
    Portfolio und Portal-Übersicht; die übrigen Bereiche folgen.
sources:
  - kind: product_documentation
    citation: Leitfaden Tax-CMS-Oberflächen
    path: docs/development/tcms-oberflaechen.md
    checked_at: '2026-10-19'
    primary: true
  - kind: product_documentation
    citation: Anwenderdokumentation Tax-CMS
    path: docs/anwenderdoku/tax-cms.md
    checked_at: '2026-10-19'
    primary: false
  - kind: internal_policy
    citation: TCMS-Einordnung und Abgrenzung zu einer unabhängigen Prüfung
    path: docs/compliance/idw-ps980-tcms.md
    checked_at: '2026-10-19'
    primary: false
code_refs:
  - apps/web/src/server/tcms/zustand.ts
  - apps/web/src/server/tcms/seite.ts
  - apps/web/src/server/tcms/aktion.ts
  - apps/web/src/components/tcms/feststellung.tsx
  - apps/web/src/components/tcms/disclaimer.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/cockpit.tsx
  - apps/web/src/lib/navigation-registry.ts
  - apps/web/src/app/staff/(protected)/layout.tsx
  - apps/web/src/app/portal/(protected)/layout.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/durchfuehrungen/[did]/ansicht.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/feststellungen/[fid]/ansicht.tsx
  - apps/web/src/components/tcms/feststellungen/formulare.tsx
  - apps/web/src/app/staff/(protected)/tcms/arbeitskorb/ansicht.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/einrichtung/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/profil/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/beschreibung/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/beschreibung/teile.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kommunikation/page.tsx
  - apps/web/src/components/tcms/programm/beschreibung.tsx
  - apps/web/src/components/tcms/bereich-b/seite.ts
  - apps/web/src/components/tcms/bereich-b/laden.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/risiken/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/risiken/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kontrollen/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kontrollen/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kalender/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/pruefung/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/laender/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/laender/actions.ts
  - apps/web/src/server/tcms/abruf/auslieferung.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/ereignisse/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/ereignisse/triage.tsx
  - apps/web/src/server/tcms/portal/anlagen.ts
  - apps/web/src/server/tcms/portal/aufgabe.ts
  - apps/web/src/app/portal/(protected)/tcms/aufgaben/[id]/actions.ts
  - apps/web/src/app/portal/(protected)/tcms/ereignis/actions.ts
  - apps/web/src/app/portal/(protected)/tcms/freigaben/actions.ts
  - apps/web/src/components/tcms/portal/freigabe-formulare.tsx
  - apps/web/src/app/staff/(protected)/tcms/audit/actions.ts
test_refs:
  - apps/web/src/server/tcms/__tests__/zustand.test.ts
  - apps/web/src/server/tcms/__tests__/seite.test.ts
  - apps/web/src/server/tcms/__tests__/aktion.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/__tests__/seiten.test.tsx
  - apps/web/src/app/staff/(protected)/tcms/__tests__/portfolio.test.tsx
  - apps/web/src/app/portal/(protected)/tcms/__tests__/portal.test.tsx
  - apps/web/src/lib/__tests__/navigation-registry.test.ts
  - apps/web/src/app/__tests__/protected-layouts.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/__tests__/page-streaming.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/durchfuehrungen/__tests__/seiten.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/feststellungen/__tests__/seiten.test.tsx
  - apps/web/src/app/staff/(protected)/tcms/arbeitskorb/__tests__/seite.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/einrichtung/__tests__/seite.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/profil/__tests__/seite.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/beschreibung/__tests__/seite.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kommunikation/__tests__/seite.test.tsx
  - apps/web/src/app/staff/(protected)/tcms/katalog/__tests__/seite.test.tsx
  - apps/web/src/components/tcms/programm/__tests__/programm.test.tsx
  - apps/web/src/components/tcms/bereich-b/__tests__/hilfen.test.ts
  - apps/web/src/components/tcms/bereich-b/__tests__/aktion.test.tsx
  - apps/web/src/server/tcms/bereich-b/__tests__/formular.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/risiken/__tests__/seite.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/risiken/__tests__/actions.test.ts
  - apps/web/src/components/tcms/risiken/__tests__/anzeige.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kontrollen/__tests__/seite.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kontrollen/__tests__/actions.test.ts
  - apps/web/src/components/tcms/kontrollen/__tests__/kontrollen.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kalender/__tests__/seite.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/pruefung/__tests__/seite.test.tsx
  - apps/web/src/components/tcms/kalender/__tests__/zeitfenster.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/laender/__tests__/seite.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/laender/__tests__/actions.test.ts
  - apps/web/src/components/tcms/laender/__tests__/laender.test.tsx
  - apps/web/src/server/tcms/bereich-b/__tests__/laender-formular.test.ts
  - apps/web/src/server/tcms/__tests__/abruf.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/__tests__/ereignisse-seite.test.tsx
  - apps/web/src/server/tcms/__tests__/portal-anlagen.test.ts
  - apps/web/src/server/tcms/__tests__/bereich-d-helfer.test.ts
  - apps/web/src/server/tcms/__tests__/bereich-d-db.test.ts
  - apps/web/src/app/portal/(protected)/tcms/__tests__/portal-seiten.test.tsx
  - apps/web/src/app/staff/(protected)/tcms/__tests__/audit.test.tsx
feature_refs:
  - FEATURES.md
  - docs/anwenderdoku/tax-cms.md
related_rules:
  - TCMS-AKTEUR-001
  - TCMS-SAMPLE-PROOF-001
tags:
  - tcms
  - werkzeug
  - anzeige
  - vertraulichkeit
---

# TCMS-DIENST-001 — Tax-CMS als Werkzeug – fachliche Entscheidungen trifft der Dienst, die kanzleikonsole zeigt an

## Kurzfassung

Das Tax-CMS strukturiert und belegt das Tax-Compliance-Programm eines
Mandanten. Ob eine Person bearbeiten oder würdigen darf, ob ein Vier-Augen-
Schritt zulässig ist, wie eine §-153-Würdigung festgehalten wird, was
vertraulich bleibt und welcher Status folgt, entscheidet allein der Dienst.
Die kanzleikonsole zeigt Daten und Rechte-Kennzeichen des Dienstes an, bildet
Fehler über feste Texte ab und erfindet keine Ersatzlogik. Weder Werkzeug
noch Oberfläche treffen eine Aussage über Angemessenheit oder Wirksamkeit
(Ausschluss TCMS-EFFECTIVENESS-001).

## Wann gilt die Regel?

Für alle Oberflächen und Aktionen des Moduls „Tax-CMS“ in der
kanzleikonsole. Nicht erfasst ist das Modul „Subsumtion / TCMS“ (Modul
`risk`), dessen Stichproben TCMS-SAMPLE-PROOF-001 beschreibt.

## Benötigte Angaben

- Antwort des Dienstes einschließlich Rechte-Kennzeichen (`rechte.bearbeiten`,
  `rechte.wuerdigen`, Portal: `portalLesen`, `melden`)
- Fehlerantwort des Dienstes (Status und Code)
- Personennamen aus der kanzleikonsole (TCMS-AKTEUR-001)

## Entscheidungslogik

| Wenn                                                             | Dann                                                                                                                              | Begründung                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| der Dienst eine Feststellung maskiert liefert (`maskiert: true`) | Anzeige „<Nummer> · Vertrauliche Feststellung“, keine weiteren Felder                                                             | Vertraulichkeit entscheidet der Dienst; nichts erraten            |
| der Dienst mit 403 antwortet                                     | feste Meldung je Schritt (z. B. Vier-Augen, Würdigung), nie der Text des Dienstes                                                 | keine Rohtexte, keine Personendaten in Meldungen                  |
| der Dienst mit 409 antwortet                                     | „Wurde zwischenzeitlich geändert – bitte neu laden.“                                                                              | Konflikte löst der Dienst, nicht die Oberfläche                   |
| der Dienst mit 404 antwortet                                     | Seite nicht gefunden bzw. „noch nicht angelegt“ (Cockpit)                                                                         | keine Existenz verraten                                           |
| der Dienst nicht erreichbar ist                                  | Hinweis „derzeit nicht erreichbar“ mit Vorgangsnummer; bei Schreibzugriffen ohne verlässliche Antwort Hinweis auf offenen Ausgang | keine Ersatzentscheidung, keine Wiederholung schreibender Aufrufe |
| Modul an, Dienst nicht konfiguriert                              | kein Menüpunkt; Seiten zeigen „nicht eingerichtet“                                                                                | Betrieb entscheidet über die Anbindung                            |
| Kennzahlen, Phasen, Klassen, Fälligkeiten                        | Anzeige aus der Antwort; die Oberfläche filtert und sortiert nur                                                                  | keine zweite Berechnung neben dem Dienst                          |

## Ausnahmen und Grenzfälle

Die Oberfläche blendet Aktionen nach den Rechte-Kennzeichen des Dienstes aus
oder zeigt sie an; wo eine Antwort keine Kennzeichen trägt (z. B. Kontakte &
Rollen, Mandant anlegen), zeigt sie die Aktion und bildet die Ablehnung des
Dienstes ab. Die Auswahl „fällig in 14 Tagen“ im Cockpit ist eine
Anzeigeauswahl auf den vom Dienst berechneten Status.

## Beispiele

### Normalfall

Eine Mitarbeiterin ohne Würdigungsrecht öffnet das Cockpit. Der Dienst
liefert `rechte.wuerdigen: false`; der Hinweis „§-153-Würdigung offen“ führt
zur Feststellung, die Würdigung selbst lehnt der Dienst ab, wenn sie versucht
wird, und die Oberfläche zeigt die feste Meldung.

### Grenzfall

Der Dienst antwortet auf das Einreichen einer Durchführung nicht innerhalb
des Zeitlimits. Die Oberfläche meldet, dass der Ausgang offen ist, und bittet
um Neuladen; sie wiederholt den Aufruf nicht und nimmt keinen Erfolg an.

## Umsetzung in TaxTronik

`server/tcms/zustand.ts` enthält die einzige Abbildung von Fehlern auf
Seiten- und Aktionszustände mit festen Texten; Logs enthalten nur
Klassifikation und Vorgangsnummer. `components/tcms/feststellung.tsx` zeigt
maskierte Feststellungen, `components/tcms/disclaimer.tsx` das Pflicht-
Framing aus `@taxtronik/tcms-domain`. Labels und Formatierung stammen aus
dem vendorten Domain-Paket des Dienstes. Menüpunkte und der Reiter der
Mandantenakte erscheinen nur bei eingeschaltetem Modul und konfiguriertem
Dienst (`dienst: 'tcms'` in `lib/navigation-registry.ts`, gespeist in den
geschützten Layouts und der Mandantenakte aus `tcmsKonfiguriert()`).

## Bekannte Abweichungen und Grenzen

Die fachliche Freigabe steht aus. Die übrigen Bereiche des Tax-CMS sind noch
nicht in der kanzleikonsole; die Demo-Oberfläche des TCMS-Repos ist kein
Produkt. Die Anzeige historischer Stände (`?stand=`) übernimmt die Angaben des
Dienstes ohne eigene Prüfung.

## Fachliche Prüffragen

- Sind die festen Meldungen bei fehlender Berechtigung für Anwender
  verständlich genug, ohne interne Gründe offenzulegen?
- Reicht der Hinweis auf den offenen Ausgang bei gestörten Schreibzugriffen?
- Ist das Pflicht-Framing an allen Stellen mit Statusangaben sichtbar genug?

## Technische Nachweise

`navigation-registry.test.ts`, `protected-layouts.test.tsx` und
`page-streaming.test.tsx` belegen, dass Menüpunkte und Reiter ohne
konfigurierten Dienst fehlen. `zustand.test.ts` belegt jede Abbildung einschließlich offener Ausgänge und
fehlender Rohtexte in Meldung und Log; `seite.test.ts` und `aktion.test.ts`
die Anwendung in Seiten und Aktionen. Die Render-Tests der Seiten zeigen die
maskierte Feststellung ohne Titel, Zustände statt Daten und die Übernahme der
Rechte-Kennzeichen des Dienstes.
