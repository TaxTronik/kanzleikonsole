# Subsumtion, TCMS und Quantenlos

TaxTronik unterstützt ein Tax Compliance Management System, ersetzt aber weder
die Organisation der Kanzlei noch eine unabhängige IDW-Prüfung. Das Risk-Modul
benötigt sowohl die tenantseitige Aktivierung als auch eine konfigurierte
on-premises Risk Engine.

## 1. Sachverhalt und Analyse

Im Mandantenprofil wird ein Sachverhalt direkt erfasst oder aus PDF, DOCX oder
einem vorhandenen Dokument übernommen. Vor der Analyse sind Mandant,
Textvollständigkeit und Dokumentversion zu prüfen.

Die Analyse ist zweistufig:

1. deterministische Wortlaut-, Muster- und Triggerprüfung,
2. optionale asynchrone Embedding-/LLM-Vertiefung.

Ein fehlgeschlagener KI-Lauf wird als Fehler angezeigt und kann wiederholt
werden. KI-Markierungen sind Vorschläge; sie werden nicht automatisch als
fachliche Entscheidung übernommen.

## 2. Governance-Matrix und Zusammenarbeit

Jede Markierung kann mit Normankern, Risikoart, Schadensintensität,
Wahrscheinlichkeit, Kontrolle, Verantwortlichem, Prüfstatus und Notiz
angereichert werden. Eigene Beratermarkierungen bleiben von einer erneuten
Engine-Analyse erhalten.

Delegationen erzeugen interne Wiedervorlagen. Rechercheaufträge an n8n zeigen
vor dem Versand eine editierbare Anonymisierungsvorschau; das Mapping von
Platzhaltern zu Originalwerten bleibt in der Kanzlei. Ergebnisse werden über
gescopte, tenantgebundene Callback-Zugänge zurückgeführt.

## 3. Export und Archivierung

Berichte können als DOCX/PDF erzeugt werden. Vor dem Export wird ausgewählt,
welche Markierungen und Herkunftsarten enthalten sind. Ein archivierter
Snapshot ist schreibgeschützt; spätere fachliche Änderungen erfordern eine
neue Version statt einer stillen Überschreibung.

## 4. Quantenlos

Unter **Administration → Quantenlos** kann eine blinde Stichprobe aus einem
vorher festgelegten Zeitraum und Rahmen gezogen werden. Unterstützt werden
Subsumtions- und Audit-Rahmen sowie die Backends QPU, Simulator und CSPRNG.
QPU-Jobs können asynchron warten und werden später explizit abgeholt.

Der Rahmen wird vor der Ziehung über ein Commitment gebunden. Nachweis,
Rahmen, Backend-Metadaten und gezogene IDs werden im manipulationsgeschützten
Audit-Ereignis gespeichert. **Nachweis prüfen** validiert diesen gespeicherten
Nachweis gegen den damals gebundenen Rahmen; es findet keine neue Ziehung statt.

Der Nachweis belegt nicht:

- dass die Grundgesamtheit vollständig war,
- dass Stichprobengröße oder Zeitraum fachlich angemessen waren,
- dass eine QPU allein eine rechtliche Prüfungsanforderung erfüllt,
- dass ausgewählte Fälle ohne menschliche Nachschau korrekt sind.

Diese Festlegungen und die Nachschau bleiben Aufgabe des verantwortlichen
Berufsträgers.
