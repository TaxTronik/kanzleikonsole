# ADR 0009 — Elektronischer Vollmachtsnachweis via Token und E-Mail-Code

**Status**: Revidiert (Iteration 107; frühere AES-Einstufung zurückgenommen)

**Datum**: 2026-05-10, revidiert 2026-08-01

**Kontext**: Vollmachtgeber sollen eine konkrete Vollmachtsfassung elektronisch
bestätigen können. Für eine fortgeschrittene elektronische Signatur verlangt
Art. 26 eIDAS unter anderem eine belastbare Identifizierung, alleinige Kontrolle
der Signaturerstellungsdaten und die Erkennbarkeit nachträglicher Änderungen.

## Entscheidung

Die Anwendung stellt einen elektronischen Bestätigungs- und Nachweisprozess
bereit, stuft ihn aber **nicht als AES oder QES** ein:

1. Ein 32-Byte-Zufallstoken wird gehasht gespeichert und als Magic-Link an die
   hinterlegte E-Mail-Adresse gesendet (TTL 72 Stunden).
2. Nach ausdrücklicher Bestätigung des angezeigten Inhalts wird ein
   sechsstelliger Code gehasht gespeichert und separat an dasselbe Postfach
   gesendet (TTL 10 Minuten).
3. Bereits beim Versand wird ein unveränderlicher JSON-Snapshot erzeugt. Bei
   PDF-Vollmachten enthält er die exakte Dokumentversions-ID und deren SHA-256;
   bei Textvollmachten den vollständigen angezeigten Text. Die öffentliche
   Ansicht liefert ausschließlich diesen Snapshot.
4. Beim Abschluss werden Token, Code, Snapshot-Hash, Zeitpunkt, IP und
   User-Agent geprüft beziehungsweise protokolliert. Statuswechsel und
   Evidence-Record erfolgen in derselben Datenbanktransaktion.

Magic-Link und Code gehen an dasselbe Postfach. Sie sind daher keine
unabhängigen Faktoren und ersetzen keine belastbare Identitätsfeststellung.

## Konsequenzen

**Vorteile**

- Exakte Bindung an die beim Versand angezeigte Text- oder PDF-Version
- Serverseitig zwingende ausdrückliche Inhaltsbestätigung
- Begrenzte Token-/Code-Laufzeit und begrenzte Fehlversuche
- Hash-verkettete Beweisspur für die abgegebene elektronische Erklärung

**Grenzen**

- Keine bestätigte fortgeschrittene oder qualifizierte elektronische Signatur
- Kompromittierung des E-Mail-Postfachs kann Link und Code offenlegen
- Rechtliche Formanforderungen des konkreten Vorgangs müssen außerhalb dieser
  technischen Funktion bewertet werden
- Für AES/QES ist ein entsprechend bewerteter Signaturdienst erforderlich

## Erweiterungspfad

Eine zukünftige Integration eines geeigneten Signaturdienstes muss dessen
Identitätsprüfung, Signaturdaten, Zertifikats-/Validierungsnachweise und die
Bindung an denselben Inhalts-Snapshot übernehmen. Eine solche Integration ist
derzeit nicht implementiert.

## Nicht gewählte Alternativen

- Nur Magic-Link ohne zusätzlichen Code
- Ungeprüfte Behauptung, zwei E-Mails an dasselbe Postfach seien zwei
  unabhängige Faktoren
- Produktzusage als AES/QES ohne externe fachliche Konformitätsbewertung
