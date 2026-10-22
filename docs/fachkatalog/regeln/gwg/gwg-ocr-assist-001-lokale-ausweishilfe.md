---
id: GWG-OCR-ASSIST-001
title: Lokale Ausweiserkennung liefert ausschließlich ungeprüfte Vorschläge
domain: gwg
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Geldwäscheprävention und Datenschutz
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    Kanzlei und öffentlicher Wizard verwenden dieselbe lokale Ausweishilfe.
    Originale bleiben unverändert; Seitenansichten binden Quelle, Version,
    PDF-Seite, Ausschnitt und Drehung. OCR und Speichern bestätigen keine Identität.
    Nur für die Erkennung wird eine Kopie vergrößert, in Graustufen gewandelt und
    im Kontrast gestreckt. Der Parser kennt das Layout des aktuellen
    Personalausweises; die maschinenlesbare Zone wird tolerant gegen gelesene
    Füllzeichen ausgewertet, übernommen wird nur, was eine gültige Prüfziffer hat.
    Die Angaben beider Ausweisseiten werden gegen diese Zone abgeglichen.
    Mandanten sehen im öffentlichen Wizard verständliche Hinweise ohne
    Fachbegriffe, den Ausweisausschnitt neben den Vorschlägen und die
    übernommenen Felder grün markiert, bis sie sie selbst bearbeiten.
sources:
  - kind: product_documentation
    citation: Umsetzung und Betriebsgrenzen der GwG-Erweiterung
    path: docs/development/gwg-erfassung-steuerdaten.md
    checked_at: '2026-08-31'
    primary: true
code_refs:
  - apps/web/src/components/gwg/identity-capture.tsx
  - apps/web/src/lib/gwg/identity-hints.ts
  - apps/web/src/app/gwg-onboarding/wizard-steps.tsx
  - apps/web/src/lib/gwg/identity-image.ts
  - apps/web/src/lib/gwg/identity-ocr-worker.ts
  - apps/web/src/lib/gwg/identity-ocr.ts
  - apps/web/src/lib/gwg/identity-mrz.ts
  - apps/web/src/lib/gwg/identity-viewport.ts
  - apps/web/src/server/gwg/identity-source.ts
  - apps/web/src/server/gwg-onboarding/identity-persistence.ts
  - apps/web/src/app/gwg-onboarding/actions.ts
  - apps/web/src/app/api/staff/gwg/identity-source/route.ts
  - apps/web/scripts/prepare-identity-assets.mjs
  - packages/db/prisma/migrations/20260831103000_gwg_identity_viewports/migration.sql
test_refs:
  - apps/e2e/tests/16-identity-local.spec.ts
  - apps/web/src/app/gwg-onboarding/__tests__/identity-source.test.ts
  - apps/web/src/app/api/staff/gwg/identity-source/__tests__/route.test.ts
  - apps/web/src/server/gwg/__tests__/identity-source.test.ts
  - apps/web/src/lib/gwg/__tests__/identity-ocr.test.ts
  - apps/web/src/lib/gwg/__tests__/identity-mrz.test.ts
  - apps/web/src/lib/gwg/__tests__/identity-hints.test.ts
  - apps/web/src/app/gwg-onboarding/__tests__/identity-applied.test.tsx
  - apps/web/src/server/gwg-onboarding/__tests__/identity-persistence.test.ts
  - apps/web/src/server/gwg-onboarding/__tests__/submission-validation.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
feature_refs:
  - docs/development/gwg-erfassung-steuerdaten.md
related_rules:
  - GWG-IDENTIFICATION-EVIDENCE-001
  - GWG-SELF-ONBOARDING-001
  - GWG-RISK-REVIEW-001
tags:
  - lokale-ocr
  - ungepruefte-vorschlaege
  - originalerhalt
---

# GWG-OCR-ASSIST-001 — Lokale Ausweiserkennung liefert ausschließlich ungeprüfte Vorschläge

## Kurzfassung

Die Ausweishilfe unterstützt das Abtippen deutscher Personalausweise. Sie ist
keine Echtheits-, Identitäts- oder Qualifikationsprüfung. Der Nutzer vergleicht
Vorschläge mit dem Original und entscheidet feldweise über die Übernahme.

## Wann gilt die Regel?

Beim Erfassen von Personalausweisen in der Kanzlei oder über eine gültige
öffentliche Einladung. Andere bisher unterstützte Nachweise bleiben manuell.

## Benötigte Angaben

Originaldatei als JPG, PNG oder PDF; konkrete Person; Version der sauberen
Dateiquelle; bei einem Ausschnitt Seitenzahl, normalisierte Koordinaten und
Drehung. Die Hilfe verarbeitet höchstens 25 MiB und 100 PDF-Seiten; der
öffentliche Upload behält seine engere bestehende Grenze.

## Entscheidungslogik

| Wenn                                                       | Dann                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| OCR liefert Werte                                          | Als ungeprüfte, einzeln auswählbare Vorschläge zeigen                            |
| Bestehender Wert unterscheidet sich                        | Bestehenden Wert zeigen; nur ausgewählte Felder ersetzen                         |
| Datum, Prüfziffer oder Feld ist widersprüchlich            | Warnen; keine Bestätigung ableiten                                               |
| MRZ-Wert hat eine gültige Prüfziffer                       | Als Vorschlag nutzen; abweichende Sichtnummer ersetzen und warnen                |
| Verwechselbare Zeichen (T/7, Z/2, O/0, I/1, S/5, B/8)      | Nur korrigieren, wenn genau eine Lesart die Prüfziffern erfüllt                  |
| Andere Seite oder bisherige Angabe widerspricht der MRZ    | Warnen; keinen Wert ersetzen                                                     |
| Ausstellungsdatum mit zweistelliger Jahreszahl             | Kein Vorschlag; Hinweis, vom Original zu übernehmen                              |
| Mandant übernimmt Vorschläge im öffentlichen Wizard        | Felder markieren, bis er sie bearbeitet; keine Vorauswahl, keine Bestätigung     |
| Zwei Seiten stammen aus derselben Quelle                   | Nur bei verschiedenen Seiten oder Ausschnitten derselben Version akzeptieren     |
| Quelle ist fremd, veraltet oder nicht sauber               | Ansicht bzw. Speicherung abweisen; manuelle Neuerfassung bleibt möglich          |
| Daten werden übernommen oder gespeichert                   | Prüfbestätigung nicht setzen; eine bestehende Bestätigung bei Änderung entwerten |
| Mitarbeiter bestätigt den gespeicherten Stand ausdrücklich | Identitätsprüfung nach den bestehenden Gates dokumentieren                       |

## Ausnahmen und Grenzfälle

Ein Jahrhundert wird nicht aus einer zweistelligen MRZ-Jahreszahl erraten,
ebenso wenig aus dem auf dem Ausweis zweistellig gedruckten Ausstellungsdatum.
Transliterierte Namen müssen am Original geprüft werden. G und 6 ändern keine
Prüfziffer; diese Verwechslung wird daher nie korrigiert, die gelesene Fassung
bleibt. Eine Staatsangehörigkeit wird nur in Adjektivform (z. B. DEUTSCH) oder
aus dem MRZ-Code D übernommen. Umlaute, die die OCR verliert (KOLN statt KÖLN),
werden nicht ergänzt. OCR kann Felder
auslassen oder falsch lesen. Ein Erkennungsfehler oder Abbruch verhindert die
manuelle Eingabe nicht. Unlesbare oder verschlüsselte PDFs müssen durch einen
lesbaren Nachweis ersetzt werden, falls eine verlässliche Ansicht benötigt wird.

## Beispiele

Eine PDF enthält beide Ausweisseiten auf getrennten Seiten. Der Nutzer wählt
für die Vorderseite PDF-Seite 1 und für die Rückseite PDF-Seite 2. Ein Original
wird gespeichert, beide Ansichten verweisen auf dieselbe Version. Ein erkannter
Name bleibt zunächst nur ein Vorschlag; ohne Auswahl bleibt die Eingabe erhalten.

Wird dieselbe Seite ohne anderen Ausschnitt als Rückseite gewählt, lehnt der
öffentliche Vertrag die doppelte Ansicht ab. Eine andere Drehung allein reicht
nicht als zweite Ausweisseite.

## Umsetzung in TaxTronik

Tesseract, Worker, WASM, Sprachmodelle und PDF-Runtime werden aus dem Lockfile
lokal bereitgestellt. Es gibt keinen OCR-Dienst, kein CDN und keine persistierte
OCR-Rohtextspalte. Die kurzlebigen Browser-Worker werden bei Abbruch beendet.
Nur Seitenverweise und ausdrücklich übernommene strukturierte Angaben werden
gespeichert. Höchstens zwei Originale gehören zu einem Satz; ein PDF-Original
wird trotz zweier Seitenverweise nur einmal zugeordnet. Originalzugriff,
Scanprüfung, Mandanten- und Tokenbindung werden serverseitig kontrolliert.

## Bekannte Abweichungen und Grenzen

Es wird keine Erkennungsquote zugesagt. OCR ist nicht für die rechtliche
Feststellung der Identität geeignet und ersetzt keine Prüfung am geeigneten
Original. Format- und MRZ-Prüfungen beweisen keine Echtheit. Vor produktiver
Nutzung sind Kanzleiablauf und Aufbewahrung fachlich zu beurteilen.

## Fachliche Prüffragen

- Welche organisatorischen Anforderungen gelten für die Sichtprüfung?
- Sind Hinweise und manuelle Korrekturen für die eingesetzten Scans ausreichend?

## Technische Nachweise

Tests prüfen Kalenderdaten, fehlende und widersprüchliche Werte, begrenzte
Seitenverweise, eindeutige Zuordnung, eine PDF mit zwei Ansichten und die
fehlende automatische Bestätigung. Die Betriebsdokumentation benennt die
tatsächlich ausgeführten Prüfungen getrennt von noch offenen Abnahmen.
Mehrsprachige Namensüberschriften werden vollständig als Beschriftung erkannt;
eine folgende Beschriftung wird nicht als fehlender Namenswert übernommen.
Bei gültiger MRZ-Prüfziffer wird YYMMDD mit dem erkannten Sichtdatum verglichen:
eine Abweichung erzeugt eine Warnung und überschreibt weder Datum noch Jahrhundert.
Derselbe Abgleich läuft zwischen den Ausweisseiten: die MRZ der Rückseite gegen
übernommene oder eingegebene Angaben und gegen die Vorschläge der Vorderseite.
Testgrundlage sind echte Tesseract-Ausgaben des veröffentlichten Musterausweises
(nur Text, kein Bild) sowie gelesene Füllzeichen, Ziffernverwechslungen,
mehrdeutige Lesarten mit gleicher Prüfziffer und das zweispaltige Layout. Eine
synthetische Rückseite mit MRZ läuft als Browserfall durch den echten Worker.
Mit dem Muster lieferte die Hilfe im Browser vorher ein falsches Ablaufdatum und
PLZ/Ort, danach Name und Ablaufdatum (Vorderseite) sowie Behörde, PLZ, Ort,
Ausweisnummer, Staatsangehörigkeit und Name (Rückseite) ohne Widerspruch. Eine
Erkennungsquote wird damit nicht zugesagt; reale Scans sind gesondert zu prüfen.
Hinweise tragen einen festen Code; Kanzlei und Mandant sehen zum selben Code
eine fachliche bzw. verständliche Fassung (Test: jeder Code hat eine eigene
Mandantenfassung ohne Begriffe wie MRZ oder Prüfziffer). Ein Komponententest des
Wizards prüft die Mandantenfassung, die Markierung übernommener Felder samt
zugeordnetem Hinweis und ihr Ende bei eigener Bearbeitung; eine weitere
Übernahme (zweite Ausweisseite) hebt frühere Markierungen nicht auf.
