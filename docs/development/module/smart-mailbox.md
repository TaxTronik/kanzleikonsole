# Smart-Mailbox: interner Eingangskorb

Das Modul `smartMailbox` wird standardmäßig deaktiviert ausgeliefert. Es verwendet den bestehenden Worker und BullMQ, unabhängig von der älteren n8n-Mailanbindung. `INBOUND_MAIL_MANAGE` ist zusätzlich zur Mitarbeiteranmeldung erforderlich; nur ADMIN/PARTNER dürfen Postfächer anlegen oder verbinden. Die Auswahl eines Mandanten ersetzt dessen Zugriffskontrolle nicht.

Der Worker fragt aktivierte Postfächer alle fünf Minuten ab. TLS-Zertifikate werden geprüft; Ordner werden read-only geöffnet. Es gibt keine MOVE-, DELETE- oder Seen-Operation. Postfachprofil, Ordner, UIDVALIDITY und UID bilden eine dauerhafte Empfangsidentität. Ein geänderter UIDVALIDITY-Wert pausiert das Profil und verlangt einen kontrollierten Neuabgleich über ein neues Profil. Ein Worker-Claim begrenzt parallele Abrufe, dauerhaft gespeicherte Empfangsnachweise fangen Wiederholungen ab. Ein Lauf verarbeitet höchstens zehn Nachrichten; nachfolgende Läufe setzen fort.

## Microsoft 365

Je Kanzlei ist eine eigene, auf deren Entra-Tenant begrenzte vertrauliche Web-App erforderlich. Ihre Redirect-URI ist die konfigurierte TaxTronik-Basis-URL plus `/api/staff/mailbox/oauth`. Das Client-Secret bleibt serverseitig verschlüsselt. Die Anmeldung verwendet Authorization Code mit PKCE und einen zeitlich begrenzten, verschlüsselten HttpOnly-State-Cookie, gebunden an die aktuell angemeldete Administration. Scope: delegierter IMAP-Zugriff sowie offline_access, openid und profile. Der MSAL-Token-Cache wird verschlüsselt gespeichert.

Nach dem Tokenaustausch prüft der Callback die aktuelle aktive Administration und
Modulfreigabe erneut unter Datenbanksperren. Bei zwischenzeitlichem Entzug wird
kein Cache gespeichert; der Callback kann nicht auf SYSTEM-Rechte zurückfallen.
Die reguläre stille Token-Erneuerung durch den Worker bleibt im Systemkontext.

Bei freigegebenen Postfächern steht deren Adresse im Postfachprofil; die Microsoft-Anmeldung erfolgt durch eine dort berechtigte Person. Widerrufene Autorisierung pausiert den Abruf. Ein gesperrtes IMAP-Protokoll wird nicht durch Basic Authentication oder das Abschalten von Sicherheitsrichtlinien umgangen. Die reale Entra-/Exchange-Integration muss mit einem Kanzlei-Testpostfach einschließlich Token-Erneuerung und Widerruf abgenommen werden.

## Anhänge und Ablage

Nachrichten sind unbestätigte Eingangsdaten. Absender, Empfänger, Alias und Betreff werden nicht als Mandantenauthentifizierung verwendet. HTML wird nicht ausgeführt; es wird nur Klartext angezeigt. Exakte Übereinstimmungen mit aktiven Kontaktadressen zugänglicher Mandanten erzeugen ausschließlich Hinweise; die Auswahl bleibt leer bis zur ausdrücklichen Bestätigung. Empfängeralias-Adressen werden nur berücksichtigt, soweit sie als Kontaktadresse bekannt sind; es gibt keine geratenen Mandantennummern oder Wildcard-Zuordnungen.

Pro Nachricht gelten maximal 25 MiB und 50 Anhänge. Nur unterstützte, anhand der Originalbytes erkannte PDF-/Bild-/XML-Formate werden geprüft. Archive, Office-Container, unbekannte Dateitypen und erkannte verschlüsselte PDFs werden gesperrt; es findet keine automatische Entpackung statt. Ein Scannerausfall hält den Import offen und sperrt die Bereitstellung. Infizierte Bytes werden nicht bereitgestellt. Vorläufige Ablagepfade werden vor dem Object-Write gespeichert und anhand von Prüfsummen wieder aufgenommen.

Erst eine berechtigte Mitarbeiteraktion bestätigt Mandant und Dokumenttyp. Sie scannt erneut, verifiziert den Originalhash und verwendet die vorhandene wiederaufnehmbare Dokumentablage. Die Zuordnung wird beim ersten Archivierungsjournal fest gebunden. Wiederholungen erzeugen kein zweites Archivdokument. Es wird keine Portalfreigabe gesetzt. Ist ein bereits zugeordneter Mandant nicht mehr sichtbar, ist auch die zugehörige Nachricht über die Datenbankpolicy unsichtbar.

## Betrieb und Grenzen

Die App-Rolle darf Postfachprofile und ihre Empfangs- und Anhangsnachweise nicht
löschen. Die additive Migration `20260831290000_mailbox_receipt_delete_guard`
entzieht auch aus Bootstrap-Standardrechten geerbte DELETE-Rechte, damit bekannte
UIDs nicht durch Löschen ihrer Empfangsidentität erneut importiert werden.

Postfachstatus, letzter erfolgreicher Abruf und Fehler sind auf `/staff/mailbox` sichtbar; Warteschlange und Rückstände stehen in der bestehenden Betriebsansicht. Pausieren stoppt weitere Nachrichtenabrufe. Es gibt keinen automatischen Aufbewahrungs-/Löschlauf für den neuen Eingangskorb; vor Produktivaktivierung ist dessen mandatsbezogene Aufbewahrung organisatorisch festzulegen. Der Eingangskorb ist kein unveränderbares Mailarchiv und kein Zustell- oder Antwortnachweis eines Mandanten.

Nachweise: `MAIL-INBOX-001`, `ACCESS-TENANT-RLS-001`, Transport-/Scanner-Regressionen in `packages/mail/src/__tests__/imap.test.ts` und echte App-RLS-Tests in `packages/db/src/__tests__/mailbox-rls.test.ts`. M365-Liveabnahme, beschädigte komplexe MIME-Beispiele, große reale Anhänge und organisatorische Aufbewahrung bleiben ausdrückliche Pilotvoraussetzungen.

## Dauerhafte Empfangslimits

MAIL-INBOX-001: Mehr als 50 Anhänge sperren den einzelnen Empfangsnachweis
terminal. Wie beim Größenlimit läuft der UID-Cursor anschließend weiter.
Nachfolgende zulässige Nachrichten werden weiterhin eingelesen; erneute Polls
verwenden die bestehenden Empfangsnachweise. Scanner- und Transportausfälle
bleiben wiederholbar und geben keine ungeprüften Dateien frei.
