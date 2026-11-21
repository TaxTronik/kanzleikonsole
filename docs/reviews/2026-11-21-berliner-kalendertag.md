# Nachprüfung vom 21. November 2026 – Berliner Kalendertag

## Welchen Prüfpunkt der erste Bericht offengelassen hat

Die Vollprüfung vom 20. November erkannte den Jahreswechsel in der Aufbewahrung
und in der BWA-Hochrechnung. Für die Bedienelemente fehlte eine Prüfung mit
derselben Uhrzeit. Auf dem damaligen Prüfstand `899137a7` kontrollierte
`22-reminder-tickets.spec.ts` bei der Ticketanlage das Pflichtfeld und leerte es
anschließend. Beim verknüpften Ticket überschrieb der Test das Datum. Dadurch
konnten beide Tests mit einem falschen Vorschlag bestehen.
[Vollprüfung und datierter Nachtrag](2026-11-20-vollpruefung.md) ·
[Ursprünglicher Ticketbericht](2026-09-07-wiedervorlagen-tickets.md) ·
[Checkliste der visuellen Nachprüfung](2026-11-21-ui-nachpruefung.md)

Geprüft wurde der lokale Arbeitsstand auf Basis von `8966e602` mit den
Änderungen dieser Nachprüfung. Fachliche Sollwerte und Arbeitsschritte stehen
bei den einzelnen Nachweisen. Die Datumsfelder wurden vor der ersten Änderung
gelesen. Für Tagesvergleiche wurde die Uhr fest eingestellt.

## Erledigte Prüfpunkte

- [x] **Ursprüngliche Regressionen.** Die Aufbewahrungstests aus Archiv und GwG
      ordnen den Zeitpunkt ab Berliner Mitternacht dem neuen Jahr zu. Die
      BWA-Hochrechnung wechselt dann auch die sichtbare Jahresüberschrift.
      [Archiv](../../packages/storage/src/__tests__/retention.test.ts) ·
      [GwG](../../packages/gwg/src/__tests__/retention.test.ts) ·
      [BWA-Dashboard](../../apps/web/src/components/bwa/__tests__/dashboard-projection.test.tsx)
- [x] **Wiedervorlagen (REMINDER-TICKET-001).** Die globale Anlage schlägt
      am 19. November um 23:30 UTC den 20. November vor. Ein verknüpftes
      Ticket schlägt über die März-Zeitumstellung hinweg den 3. April vor.
      In der Telefonnotiz ist beim Öffnen kurz nach Berliner Mitternacht am 29. März der 30. März vorgeschlagen, der 29. ist auswählbar. In der
      Mandantenakte weist der Browser den Vortag zurück. In Akte und Übersicht
      trägt von drei offenen Tickets mit Fälligkeit gestern, heute und morgen
      ausschließlich das gestrige die Kennzeichnung „überfällig“.
      [Chromium-Prüfungen an den Ticketformularen und Listen](../../apps/e2e/tests/22-reminder-tickets.spec.ts)
- [x] **Rechnungsanlage (INV-NUMBER-ALLOCATION-001).** Am 31. Dezember 2026
      um 23:30 UTC zeigen alle drei Einstiege den 1. Januar 2027. Die manuelle
      Rechnung und die Rechnung aus Zeiteinträgen sind mit dem 31. Januar
      vorbelegt, die externe Rechnung mit dem 15. Januar. Alle drei wurden
      auch an beiden Zeitumstellungen geprüft. Die Stundenabrechnung übermittelt
      sowohl unveränderte als auch manuell geänderte Felder an die Anlage.
      [Zentrale Rechnungsseite](<../../apps/web/src/app/staff/(protected)/invoices/new/__tests__/page.test.tsx>) ·
      [Stundenabrechnung](<../../apps/web/src/app/staff/(protected)/clients/[id]/billing/__tests__/billing-form-dates.test.tsx>)
- [x] **Neue BWA-Planung (BWA-PROJECTION-001).** Zum Jahreswechsel zeigten
      beide Einstiege im Feld „Planjahr“ noch 2027. Auf den korrigierten
      Kanzlei- und Portalseiten steht dort unmittelbar vor Berliner Mitternacht
      2027, ab Mitternacht 2028. Der vorgeschlagene Planname wechselt mit.
      [Test beider Planungsseiten](../../apps/web/src/components/bwa/__tests__/plan-page-basis.test.tsx)
- [x] **Vollmacht (POA-LIFECYCLE-001).** Der am Server bestimmte Vorschlag
      „Gültig ab“ lautet am 31. Dezember 2026 um 23:15 UTC auf den 1. Januar 2027. Er bleibt nach dem Laden im Browser editierbar, auch wenn dessen
      Uhr inzwischen einen anderen Tag zeigt.
      [Formulartest beider Vollmachtsmodi](<../../apps/web/src/app/staff/(protected)/poa/__tests__/client-context.test.tsx>)
- [x] **Vollmachtsdatenbank und Mandatsende (VDB-PREPARATION-001,
      CLIENT-OFFBOARDING-001, CLIENT-MANDATE-LIFECYCLE-001).** Vorschlag und
      höchster zulässiger Tag wechseln in beiden Formularen um Berliner
      Mitternacht. Der Server akzeptiert dann den neuen Tag, lehnt morgen
      und unmögliche Kalenderdaten ab. Ein am 15. Juni vorbereiteter Entwurf
      behält beim späteren Öffnen sein eingetragenes Enddatum.
      [Formularfelder](<../../apps/web/src/app/staff/(protected)/mandate-expansion/__tests__/calendar-dates.test.tsx>) ·
      [Mandatsende](../../apps/web/src/server/mandate-expansion/__tests__/model.test.ts) ·
      [VDB-Aufzeichnung](../../apps/web/src/server/mandate-expansion/__tests__/service.test.ts)
- [x] **Workflowpause und Pendelordner (WORKFLOW-LIFECYCLE-001,
      TAX-CONTROL-STATUS-001).** Beim Öffnen gilt der heutige Berliner Tag
      als frühester Wiederaufnahme- bzw. Rückgabetag. Gestern sperrt das
      Absenden. Heute und eine leere optionale Angabe werden angenommen.
      Bei einem ausgegebenen Ordner ist die gestern erwartete Rückgabe als
      überfällig markiert, die heute erwartete Rückgabe ist noch fristgerecht.
      [Chromium-Prüfung der Eingabe, Übergabe und Anzeige](../../apps/e2e/tests/client-operational-dates.spec.ts)
- [x] **Kanzleitermin und Terminwünsche im Portal (APPT-BERLIN-WALLCLOCK-001).**
      Am 2. Juli um 00:30 Uhr in Berlin zeigt ein auf UTC gestellter Browser
      den Kanzleitermin mit 00:30 Uhr an. Das Portal schlägt für morgen den 3. Juli von 10 bis 11 Uhr vor und für den nächsten Wunsch den 4. Juli.
      Der Datumspicker und die übermittelten Felder verwenden dieselben Tage.
      [Prüfung der Formulare](../../apps/web/src/components/__tests__/berlin-form-defaults.test.tsx) ·
      [Produktkonvention für Termine](../fachkatalog/regeln/mandat-und-zugriff/appt-berlin-wallclock-001-berliner-terminzeiten.md)
- [x] **Anforderungsvorlagen (REQ-LIFECYCLE-001).** Bei einem Tag Vorlauf
      liefert dieselbe Uhr den 3. Juli um 00:30 Uhr. Auch eine gültige
      Berliner 02:30-Uhr-Vorgabe am US-Zeitumstellungstag bleibt im
      New Yorker Browser sichtbar und editierbar. Der Formularwert behält
      die gewählte Ortszeit.
      [Formularwerte an beiden Zeitumstellungen](../../apps/web/src/components/__tests__/berlin-form-defaults.test.tsx)

## Bestehende UTC-Konventionen und offene Punkte

- [x] **Gespeicherte Kalendertage.** Eine Datenbankangabe vom Typ `DATE`
      bezeichnet einen Tag. Die Kalenderansicht liest diese Werte weiter mit
      UTC-Grenzen für die Monatsabfrage. Für die bestehende Tageseinteilung
      des Fristenbuchs gibt es ebenfalls einen ausdrücklichen UTC-Test. Beide
      Testsuiten wurden wieder ausgeführt.
      [Kalenderabfrage](<../../apps/web/src/app/staff/(protected)/calendar/__tests__/page-render.test.tsx>) ·
      [Fristenbuch](../../apps/web/src/server/fristen/__tests__/eintrag.test.ts)
- [ ] **Auswahlzeitraum beim Quantenlos.** Der Fachkatalog beschreibt
      UTC-Tagesgrenzen. Ob die Kanzlei für einen Auftrag lokale Kalendertage
      meint, muss sie fachlich entscheiden. Für diesen Fall ist vor einer
      Umstellung die Auswahlmenge an beiden Tagesgrenzen abzugleichen.
      [Offene Prüffrage zum Stichprobenrahmen](../fachkatalog/regeln/subsumtion-und-tcms/tcms-sample-proof-001-rahmenbindung.md#ausnahmen-und-grenzfälle)
- [ ] **Gespeicherte Schutzfristen.** Die Bestandsprüfung vor einer
      Produktivfreigabe aus der Vollprüfung bleibt offen. Der nächste Schritt
      ist der Abgleich der betroffenen gespeicherten Versionen und ihrer
      Schutzfristen durch die Kanzlei. Die technischen Tests verwenden
      synthetische Fälle.
      [Prüfauftrag für die Kanzlei](../development/module/dokumentenarchiv.md#jahreswechsel-und-bereits-gespeicherte-schutzfristen)

## Prüfläufe auf diesem Stand

Im gemeinsamen Schlusslauf bestanden 34 Chromium-Fälle für BWA, Wiedervorlagen,
Workflowpausen und Pendelordner sowie 211 Webtests in 20 Dateien. Die beiden
Aufbewahrungssuiten bestanden mit 28 Archiv- und 15 GwG-Fällen. Bei Vollmacht,
VDB und Mandatsende wurden zusätzlich acht Prüfungen an den gerenderten
Datumsfeldern in Chromium und Firefox ausgeführt. Die ergänzenden Browserläufe
arbeiteten mit synthetischen Daten und separat geprüften Serveraktionen.
Die 240 Fälle des ungefilterten Playwright-Laufs gehören zum vorherigen
visuellen Prüfstand. [Checkliste dieses Laufs](2026-11-21-ui-nachpruefung.md)

Die lokalen Protokolle des Schlusslaufs liegen unter
`.codex-run/bericht-checkliste-20261121/`, darunter `chromium.log` und
`regressionen-final.log`. Der frische Linux-Installationslauf mit leerem
Store, der Supply-Chain-Guard und die Betriebsskripttests sind in
`linux-debian-final.log` protokolliert.

**Nachtrag vom 21. November 2026.** Die CI prüft die Formularwerte nun in
Chromium und Firefox. Die Gegenproben mit dem früheren Quellstand und die
zugehörigen Prüffälle stehen in der [CI-Nachprüfung](2026-11-21-ci-bedienpruefung.md).

**Nachtrag vom 21. November 2026 zur BWA.** Die Berliner Jahreswechseltests für Dashboard und neue Planung wurden nach Zusammenlegung der Berechnungen erneut ausgeführt. [Nachprüfung von Imagepflege und Codeabbau](2026-11-21-nachpruefung-imagepflege-und-codeabbau.md#codeabbau-und-vertragswechsel)
