# Fachkatalog – Regelindex

<!-- Diese Datei wird durch `pnpm fachkatalog:generate` erzeugt. Nicht manuell bearbeiten. -->

> Der fachliche Status und der technische Umsetzungsstand sind unabhängig.
> „Umgesetzt“ bedeutet nicht „fachlich freigegeben“.
> `approved` authentifiziert die eingetragene Person nur mit separater Repository-Governance oder signierter Attestation.

## Fristen und Bescheide

### [TAX-CONTROL-STATUS-001 — Offene und erledigte Fristen aus dem Quellstatus ableiten](regeln/fristen-und-bescheide/tax-control-status-001-fristenkontrollbuch.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Das Fristenkontrollbuch führt keinen eigenen Erledigt-Schalter. Es liest den Erledigungsstand aus dem jeweiligen Fachmodul, damit Kontrollsicht und Originalvorgang nicht auseinanderlaufen. Offene überfällige Fristen bleiben ohne zeitliche Untergrenze sichtbar, bis der Quellvorgang einen definierten Erledigungsstatus erreicht.

### [TAX-DEADLINE-AUTOREQUEST-001 — Automatische Mandantenanforderung vor Steuerterminen steuern](regeln/fristen-und-bescheide/tax-deadline-autorequest-001-automatische-anforderung.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik darf zu einem bevorstehenden Steuertermin automatisch genau eine Mandantenanforderung anlegen, sofern die Kanzlei die Automatik aktiviert und nicht zuvor gestoppt hat. Nach Ablauf des Fälligkeitstags wird keine neue Anforderung mehr erzeugt. „Gesendet“ bezeichnet derzeit die angelegte Portal-Anforderung, nicht den nachgewiesenen Zugang einer E-Mail.

### [TAX-DEADLINE-WORKDAY-001 — Fristende auf den nächsten Werktag verschieben](regeln/fristen-und-bescheide/tax-deadline-workday-001-werktagsverschiebung.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: Fällt das Ende einer steuerlichen Frist auf einen Samstag, Sonntag oder am maßgeblichen Ort geltenden gesetzlichen Feiertag, verschiebt TaxTronik das Ergebnis auf den nächsten berücksichtigten Werktag. Das Ergebnis bleibt ein Kontrollvorschlag, weil örtliche und historische Feiertagsbesonderheiten nicht vollständig modelliert sind.

### [TAX-NOTICE-APPEAL-001 — Einspruchsfrist im dokumentierten Bekanntgabe-Regelfall berechnen](regeln/fristen-und-bescheide/tax-notice-appeal-001-einspruchsfrist-regelfall.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: ab 2025-01-01
- Kurzfassung: TaxTronik ermittelt für dokumentierte Standard-Bekanntgabewege zunächst einen Bekanntgabetag und berechnet ab diesem grundsätzlich eine Monatsfrist. Bei fehlender oder unrichtiger Rechtsbehelfsbelehrung wird stattdessen eine Jahresfrist vorgeschlagen. Das Ergebnis ist ausdrücklich ein Kontrollvorschlag, kein Ersatz für die Prüfung des tatsächlichen Zugangs und des konkreten Bescheids.

## Rechnungen

### [INV-ARCHIVE-EINVOICE-001 — E-Rechnungsformate aus einer kanonischen Archivfassung bereitstellen](regeln/rechnungen/inv-archive-einvoice-001-kanonische-archivfassung.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Bei der Ausstellung einer In-App-E-Rechnung erzeugt TaxTronik die menschenlesbare ZUGFeRD-PDF und die separate XRechnung-XML aus demselben fachlichen Snapshot und archiviert beide eindeutig verknüpft. Spätere Downloads liefern die gespeicherten Bytes und rendern den ausgestellten Beleg nicht mit heutigen Stammdaten oder Branding-Einstellungen neu.

### [INV-LIFECYCLE-FREEZE-001 — Rechnungsinhalt nach Verlassen des Entwurfs festschreiben](regeln/rechnungen/inv-lifecycle-freeze-001-festschreibung.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Solange eine In-App-Rechnung Entwurf ist, dürfen ihre Geschäftsdaten technisch geändert werden. Sobald sie den Entwurfsstatus verlässt, sind Nummer, Beträge, Daten, Steuerangaben und Positionen unveränderlich. Eine fachliche Korrektur erfolgt über den vorgesehenen Storno- und Neuausstellungsprozess, nicht durch Überschreiben des Originalbelegs.

### [INV-PORTAL-SHARING-001 — Rechnungen erst nach Ausstellung im Mandantenportal zeigen](regeln/rechnungen/inv-portal-sharing-001-mandantensicht.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Weicht ab**
- Geltung: nicht eingegrenzt
- Kurzfassung: Ein Rechnungsentwurf ist ausschließlich kanzleiintern und darf dem Mandanten nicht als Rechnung angezeigt oder als Archivbeleg geteilt werden. Wurde eine Rechnung bereits versendet, bleibt sie auch nach einem späteren Storno als historischer Beleg im Portal sichtbar. Ein nie versendeter stornierter Entwurf bleibt dagegen intern.
