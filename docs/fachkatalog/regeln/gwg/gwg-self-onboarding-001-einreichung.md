---
id: GWG-SELF-ONBOARDING-001
title: Mandantendaten per gebundener Einladung nur als Prüfentwurf einreichen
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
    Der öffentliche Wizard bindet Uploads und Submit an eine gültige Einladung
    und einen unveränderten Mandanten- oder Entwurfsstand, validiert Personen-
    und Dokumentreferenzen und persistiert Einreichung, Snapshot, Audit und
    Einwilligung atomar. Die Einreichung aktiviert den Mandanten nicht und ist
    keine fachliche GwG-Freigabe.
sources:
  - kind: product_documentation
    citation: GwG-Pflichten und technische Umsetzung in TaxTronik
    path: docs/compliance/gwg.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: Anwenderdokumentation — erster Mandant und GwG-Onboarding
    path: docs/anwenderdoku/erste-schritte.md
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: §§ 10 bis 12 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/BJNR182210017.html
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/app/gwg-onboarding/wizard-steps.tsx
  - apps/web/src/app/gwg-onboarding/wizard.tsx
  - apps/web/src/server/gwg-onboarding/invite-lifecycle.ts
  - apps/web/src/server/gwg-onboarding/owner-submission.ts
  - apps/web/src/server/gwg-onboarding/representative-submission.ts
  - apps/web/src/server/gwg-onboarding/service.ts
  - apps/web/src/server/gwg-onboarding/submission-master-data.ts
  - apps/web/src/server/gwg-onboarding/wizard-validation.ts
  - apps/web/src/server/gwg-onboarding/migrate-invite-v2-audit.ts
  - apps/web/src/server/gwg-onboarding/manual-capture.ts
  - apps/web/src/server/gwg-onboarding/identity-persistence.ts
  - apps/web/src/lib/gwg/identity-viewport.ts
  - apps/web/src/app/gwg-onboarding/actions.ts
  - apps/web/src/server/gwg-onboarding/invite-binding.ts
  - apps/web/src/server/gwg-onboarding/submission-validation.ts
  - apps/web/src/server/gwg-onboarding/submission-transaction.ts
  - apps/web/src/server/gwg/reverification.ts
  - packages/db/prisma/migrations/20260801004100_onboarding_gwg_review_workflow/migration.sql
  - packages/db/prisma/migrations/20260819000000_gwg_onboarding_document_discard/migration.sql
test_refs:
  - apps/web/src/server/gwg-onboarding/__tests__/owner-submission.test.ts
  - apps/web/src/server/gwg-onboarding/__tests__/representative-submission.test.ts
  - apps/web/src/server/gwg-onboarding/__tests__/service.test.ts
  - apps/web/src/server/gwg-onboarding/__tests__/wizard-validation.test.ts
  - apps/web/src/server/gwg-onboarding/__tests__/invite-lifecycle.test.ts
  - apps/web/src/server/gwg-onboarding/__tests__/submission-master-data.test.ts
  - apps/web/src/server/gwg/__tests__/lifecycle-lock-call-sites.test.ts
  - apps/web/src/app/gwg-onboarding/__tests__/identity-source.test.ts
  - apps/web/src/server/gwg-onboarding/__tests__/manual-capture.test.ts
  - apps/web/src/server/gwg-onboarding/__tests__/identity-persistence.test.ts
  - apps/web/src/server/gwg-onboarding/__tests__/submission-transaction-structure.test.ts
  - apps/web/src/server/gwg-onboarding/__tests__/submission-validation.test.ts
  - apps/web/src/app/gwg-onboarding/__tests__/bound-draft-submit.test.ts
  - apps/web/src/app/gwg-onboarding/__tests__/actions-expiry.test.ts
feature_refs:
  - FEATURES.md
  - docs/compliance/gwg.md
  - docs/anwenderdoku/erste-schritte.md
related_rules:
  - GWG-OCR-ASSIST-001
  - GWG-ACTIVATION-GATE-001
  - GWG-IDENTIFICATION-EVIDENCE-001
  - GWG-REPRESENTATIVE-AUTHORITY-001
  - GWG-BENEFICIAL-OWNERS-001
  - GWG-RISK-REVIEW-001
tags:
  - self-onboarding
  - einladung
  - submit
  - upload
---

# GWG-SELF-ONBOARDING-001 — Mandantendaten per gebundener Einladung nur als Prüfentwurf einreichen

## Kurzfassung

Der öffentliche GwG-Wizard erlaubt einer eingeladenen Person, Stammdaten,
wirtschaftlich Berechtigte, Vertreter, Identitätsbelege und Zusatzunterlagen
ohne Portal-Konto zu übermitteln. Jeder Schreibzugriff ist an den geheimen,
noch gültigen Link, den Mandanten und einen bei Einladungsausgabe gebundenen
Ausgangsstand gekoppelt.

Ein erfolgreicher Submit erzeugt oder aktualisiert ausschließlich einen
bearbeitbaren Prüfsnapshot. Er setzt weder `VERIFIED` noch `allowActive`; die
fachliche Prüfung und Freigabe bleiben bei Kanzleimitarbeitern und dem
zugeordneten Berufsträger.

## Wann gilt die Regel?

Die Regel gilt für den öffentlichen Pfad `/gwg-onboarding` von der
Einladungsausgabe bis zum einmaligen Submit. Eine ungebundene Einladung ist nur
vor der ersten GwG-Prüfung zulässig. Existiert bereits ein Entwurf, wird die
Einladung kryptografisch an genau dessen Revision gebunden.

Nach Ablauf, Widerruf, Ablösung durch eine neuere Einladung oder erfolgreichem
Submit sind weitere Uploads und erneute Einreichungen über denselben Link nicht
zulässig.

## Benötigte Angaben

- geheimer Einladungstoken und serverseitiger Token-Hash
- Tenant, Mandant und Mandantentyp der Einladung
- Ablaufzeit, Status und gegebenenfalls gebundene Entwurfsrevision
- Stammdaten des Mandanten
- wirtschaftlich Berechtigte und Vertreter einschließlich lokaler stabiler IDs
- invitegebundene Dokument-IDs und deren Zweckzuordnung
- Rechtsträgererklärung und Zusatznachweise
- angezeigte Datenschutzhinweise, Auswahl, Revisionshash und bestätigender Name
- IP-Adresse und User-Agent, soweit technisch verfügbar

## Entscheidungslogik

| Wenn                                                                         | Dann                                                                                                        | Begründung                                               |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Token fehlt, ist falsch, abgelaufen, widerrufen oder bereits verbraucht      | Generische Ablehnung; keine Datenänderung                                                                   | Geheimnis- und Replay-Schutz                             |
| Einladung ist an einen veränderten oder nicht mehr neuesten Entwurf gebunden | Submit fail-closed ablehnen                                                                                 | Parallele Staff-Änderung darf nicht überschrieben werden |
| Dokument wurde nicht über diese Einladung hochgeladen                        | Referenz ablehnen                                                                                           | Mandanten- und Einladungsscope                           |
| Dokument ist mehreren Personen oder Zwecken zugeordnet                       | Submit ablehnen                                                                                             | Eindeutige Nachweiszuordnung                             |
| Pflichtangaben oder erforderliche Ausweisseiten fehlen                       | Submit ablehnen                                                                                             | Unvollständiger Prüfentwurf                              |
| Noch nicht eingereichter Upload wird bewusst verworfen                       | Exakte Objektversion und DB-Verknüpfung kontrolliert entfernen                                              | Mandant darf Vorab-Fehler korrigieren                    |
| Alle Prüfungen bestehen                                                      | Einladung einmalig claimen und alle Phasen in einer Transaktion ausführen                                   | Atomarer Submit                                          |
| Submit erfolgreich                                                           | Daten als `DRAFT` speichern, Risiko zurücksetzen, Audit/Einwilligung persistieren und Staff benachrichtigen | Noch keine fachliche Entscheidung                        |

## Ausnahmen und Grenzfälle

- Bei einem verlorenen Commit-Acknowledgement rekonstruiert der Uploadpfad den
  persistenten Stand, statt einen bereits gebundenen Beleg zu löschen.
- Eine Person mit Doppelrolle als Vertreter und wirtschaftlich Berechtigter
  verwendet eine explizite lokale ID-Verknüpfung; der Name allein genügt nicht.
- Der Transparenzregisterauszug ist im Mandantenwizard bewusst kein Pflichtfeld;
  die Kanzlei muss ihn vor der finalen Freigabe beschaffen, soweit erforderlich.
- Die anonyme Einreichung ordnet dem Audit keinen authentifizierten
  Portal-Kontakt zu. Token, IP/User-Agent und eingegebener Name ersetzen keine
  verlässliche Personenidentität.
- Die verpflichtende Datenschutzanzeige ist ein eigener Rechtsbereich und
  keine GwG-Freigabe.

## Beispiele

### Normalfall

Eine GmbH erhält eine an ihren aktuellen Entwurf gebundene Einladung. Die
eingeladene Person ergänzt zwei wirtschaftlich Berechtigte, eine Vertreterin
und die zugehörigen Belege. Der Submit claimt die Einladung einmalig, speichert
alles atomar als Entwurf und benachrichtigt die Kanzlei. Der Mandant bleibt
inaktiv.

### Grenzfall

Während die Einladung offen ist, ändert ein Mitarbeiter denselben Entwurf.
Beim Submit stimmt der gebundene Revisionshash nicht mehr. TaxTronik lehnt die
Einreichung ab und überschreibt weder Personen noch Dokumentzuordnungen.

## Umsetzung in TaxTronik

Einladung und „In der Kanzlei erfassen“ sind gleichwertige Einstiege. Der
Kanzleiweg öffnet einen vorhandenen DRAFT-/IN_REVIEW-Stand unverändert oder
legt nach einem abgeschlossenen Stand einen neuen Entwurf an. Offene Links
werden unter dem Mandanten-Lifecycle-Lock mit Grund widerrufen und auditiert;
Kontakte, Aktivierungsbedingungen und Berufsträgerfreigabe werden nicht
übersprungen. Es erfolgt kein automatischer Versand eines Ersatzlinks.

Beide Wege nutzen dieselbe lokale Ausweishilfe (GWG-OCR-ASSIST-001). Zwei
Seitenverweise dürfen dasselbe PDF-Original verwenden, wenn Version und
unterschiedliche Seiten/Ausschnitte gültig sind. Personenfremde oder mehrfach
verwendete Originale bleiben verboten. Öffentliche Einreichungen speichern
keine Identitätsbestätigung. Auch ohne OCR trägt jede Ausweisseite zwingend die
aktuelle saubere Quellversion. Vollständige manuelle Originalansichten benötigen
keine PDF-Dekodierung; explizite PDF-Seiten, Ausschnitte und Drehungen werden am
Original validiert. Ein veralteter Seitenverweis wird niemals still ersetzt.
Der koordinierte Versionswechsel widerruft alte
offene Einladungen; bereits eingereichte Daten und historische Hashes bleiben
erhalten. Details stehen in der Betriebsdokumentation zur Erweiterung.

Einladungsausgabe und -nutzung verwenden gehashte Tokens, Ablaufstatus,
Rate-Limits und einen Mandanten-Lifecycle-Lock. Uploads werden vor der
Verknüpfung gescannt und auf eine offene Einladung gescopt; fehlerhafte
Vorab-Uploads können über einen kontrollierten Vernichtungspfad entfernt werden.

Der Submit validiert zuerst sämtliche Personen- und Dokumentreferenzen. Danach
claimt eine Datenbanktransaktion die Einladung, löst den gebundenen Entwurf auf,
speichert Stammdaten, Personen, Identitätssätze und Nachweise, schreibt Audit,
Benachrichtigung und den angezeigten Einwilligungssnapshot. Ein Fehler vor
Transaktionsabschluss rollt die fachlichen Datenänderungen zurück.

## Bekannte Abweichungen und Grenzen

Innerhalb des beschriebenen öffentlichen Einreichungspfads sind keine
bekannten technischen Abweichungen festgestellt. Der Pfad hat bewusst folgende
Grenzen:

- Er ist Datenerhebung und keine Identitätsfeststellung durch einen amtlichen
  oder beaufsichtigten elektronischen Identifizierungsdienst.
- Die Person hinter dem geheimen Link wird nicht als Portal-Kontakt
  authentifiziert.
- Registerabfragen, Echtheitsprüfung und fachliche Plausibilisierung erfolgen
  nicht automatisch.
- Eine Bestätigung der Datenschutzhinweise ist keine Aussage über die
  GwG-Richtigkeit der Angaben.

## Fachliche Prüffragen

- Welche Person darf eine Einladung erhalten und wie wird die Berechtigung vor
  Versand geprüft?
- Reichen Tokenbindung und Auditdaten für das gewünschte Beweisniveau?
- Welche Belege darf der Mandant selbst liefern und welche muss die Kanzlei
  unabhängig beschaffen?
- Welche Angaben dürfen bei einem Re-Onboarding aus dem alten Entwurf
  vorausgefüllt werden?

## Technische Nachweise

Einladungsbindung, Preflight und Transaktionsskript belegen Scope, CAS und
Phasenreihenfolge. Die Tests prüfen invitefremde und doppelte Dokumente,
abgelaufene Links, geänderte gebundene Entwürfe, stabile Personen-IDs,
Upload-Cleanup und die Claim-zuerst-/Einwilligung-zuletzt-Reihenfolge. Sie
belegen keine fachliche Wahrheit der eingereichten Angaben.
