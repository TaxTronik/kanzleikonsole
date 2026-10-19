# Leitfaden: Tax-CMS-Oberflächen

- **Dokumentstatus:** Entwicklerleitfaden (TCMS Stufe 3, alle Bereiche)
- **Bezug:** [Anbindung des Tax-CMS](tcms-anbindung.md), Fachkatalog
  [TCMS-AKTEUR-001](../fachkatalog/regeln/subsumtion-und-tcms/tcms-akteur-001-bestaetigungsumfang.md)
  und
  [TCMS-DIENST-001](../fachkatalog/regeln/subsumtion-und-tcms/tcms-dienst-001-werkzeug.md)
- **Referenzseite:** `apps/web/src/app/staff/(protected)/clients/[id]/tcms/page.tsx`
  (Cockpit)

Dieser Leitfaden beschreibt, wie eine Seite oder Aktion des Tax-CMS in der
kanzleikonsole gebaut wird. Er richtet sich an alle, die weitere Bereiche
(Einrichtung, Risiken, Kontrollen, Durchführungen, Feststellungen, …) aus der
Demo-Oberfläche des TCMS-Repos übernehmen. Die Demo (`apps/web` im TCMS-Repo)
ist Vorlage für Aufbau und Texte, **kein** Produkt: Ihre Datenzugriffe,
Sitzungen und Rechteprüfungen werden nicht übernommen.

## 1. Grundsatz: Der Dienst entscheidet

Das Tax-CMS ist ein headless Dienst (ADR 0001 des TCMS-Repos). Rechte,
Vier-Augen-Prinzip, §-153-Würdigung, Vertraulichkeit, Statusübergänge,
Phasen, Fälligkeiten, Klassen und Kennzahlen berechnet **nur** der Dienst.
Eine Seite der kanzleikonsole

- zeigt die Antwort an und wählt aus, filtert und sortiert sie für die
  Anzeige,
- blendet Aktionen nach den Rechte-Kennzeichen der Antwort aus oder sperrt
  sie sichtbar mit festem Grund (`rechte.bearbeiten`, `rechte.wuerdigen`,
  Stammdaten `kontext.mandant.rechte.bearbeiten`, Kontaktrollen
  `kontakte.rechte.bearbeiten`, Durchführung `{ erlaubt, grund, verweigerung }`,
  Portal `portalLesen`, `melden`); wo eine Antwort keine Kennzeichen trägt,
  zeigt sie die Aktion und bildet die Ablehnung des Dienstes ab,
- nimmt Labels und Formatierung aus `@taxtronik/tcms-domain`
  (`labels.ts`, `format.ts`, `katalog.ts`, `phasen.ts`) statt eigener Texte,
- berechnet **nichts** nach: keine eigene Fälligkeit, keine eigene Phase,
  kein Erraten maskierter Felder, keine eigene Rechteprüfung, keine
  Wiederholung schreibender Aufrufe.

Zulässig sind Anzeigeauswahlen auf vom Dienst gelieferte Werte (z. B. im
Cockpit „fällig in 14 Tagen“ auf dem Status und Datum der Antwort). Was über
eine Auswahl hinausgeht, gehört als Änderungsvorschlag in das TCMS-Repo.

## 2. Aufbau

| Route                                | Einstieg               | Wer                                       |
| ------------------------------------ | ---------------------- | ----------------------------------------- |
| `/staff/clients/[id]/tcms/**`        | `tcmsMandantSeite(id)` | Kanzlei, Zugriff auf den Mandanten        |
| `/staff/tcms/**` (Portfolio, Korb)   | `tcmsKanzleiSeite()`   | Kanzlei, Mandantenliste der Person        |
| `/staff/tcms/**` (Audit, Verwaltung) | `tcmsAdminSeite()`     | nur Admin/Partner, ohne Mandantenbezug    |
| `/portal/tcms/**`                    | `tcmsPortalSeite()`    | Mandantenkontakt; Mandant nur aus Sitzung |
| Datei-Abrufe (Route Handler)         | Abschnitt 11           | wie Mandantenseite bzw. Portal            |

- **Modulbereich `tcms`** (`apps/web/src/lib/module-registry.ts`): Layout-Gate
  und `requireModulePage` liefern bei ausgeschaltetem Modul 404. Der
  Menüpunkt erscheint zusätzlich nur bei konfiguriertem Dienst
  (`dienst: 'tcms'` in `lib/navigation-registry.ts`).
- **Mandanten-Layout** `clients/[id]/tcms/layout.tsx`: ruft
  `tcmsMandantSeite` als Erstes, zeigt Rücksprung, `h1` „Tax-CMS“, den
  Mandantennamen aus der kanzleikonsole und die Unternavigation.
  **Seiten beginnen deshalb mit `h2`.** Das Layout ersetzt die Prüfung der
  Seite nicht: Jede Seite ruft ihren Einstieg selbst (React `cache()` sorgt
  dafür, dass die Prüfkette je Anfrage einmal läuft).
- **Unternavigation:** `TCMS_MANDANT_BEREICHE` in
  `apps/web/src/components/tcms/bereiche.ts` hält die 14 Bereiche in fester
  Reihenfolge (Cockpit, Kontakte & Rollen, Einrichtung, Profil, Beschreibung,
  Risiken, Kontrollen, Durchführungen, Feststellungen, Ereignisse, Länder,
  Kalender, Prüfung, Kommunikation). Ein neuer Bereich legt nur seine Route
  unter dem dort eingetragenen Pfad an; Einträge werden nicht umbenannt.
  `tcmsBereichHref` übernimmt einen gültigen Stichtag (`?stand=`).

## 3. Eine Seite schreiben

Vorlage ist das Cockpit:

```tsx
export default async function TcmsCockpitPage({ params, searchParams }) {
  const { id } = await params;
  const seite = await tcmsMandantSeite(id); // 1. immer zuerst
  if (!seite.ok) return <TcmsZustand zustand={seite.zustand} />;

  const { stand: standRoh } = await searchParams;
  const stand = StandSchema.safeParse(standRoh); // nur gültige Kalendertage
  const kontext = await tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen, {
    query: stand.success ? { stand: stand.data } : {},
  });
  if (!kontext.ok) return <TcmsZustand zustand={kontext.zustand} />;
  if (kontext.daten === null) return <NichtAngelegt seite={seite} />;

  const namen = await tcmsNamenLesen(seite, personIdsAus(/* IDs aus der Antwort */));
  return <Cockpit seite={seite} ctx={kontext.daten} namen={namen} />;
}
```

Regeln:

1. **Einstieg zuerst.** Der erste Aufruf jeder Seite ist der passende
   Einstieg aus `server/tcms/seite.ts`. Er prüft Sitzung bzw.
   Mandantenzugriff (`requireClientPageAccess` als erster Aufruf), Modul,
   Konfiguration und Aktivierung und stellt den Akteur aus. Kein anderer
   Weg zu einem Akteur oder Client ist für Seiten vorgesehen.
2. **Ergebnis behandeln.** Einstiege und Lesezugriffe liefern
   `{ ok: false, zustand }` oder Daten; TypeScript erzwingt die Prüfung vor
   der Verwendung. Redirect (keine Sitzung, kein Mandantenzugriff) und 404
   (Modul aus, Objekt nicht vorhanden) laufen über `next/navigation`.
3. **Lesen nur über `tcmsLesen`/`tcmsLesenOptional`.** Sie setzen Akteur,
   `mandantId` (aus der geprüften Seite) und bei Portfolio/Arbeitskorb die
   Mandantenliste selbst; die Seite gibt nur weitere Pfadparameter und die
   Query an. `tcmsLesen` macht aus einem 404 des Dienstes `notFound()`,
   `tcmsLesenOptional` liefert `daten: null` für Seiten, die „noch nicht
   angelegt“ selbst darstellen. Schreibende Endpunkte, Kanzlei-Endpunkte auf
   Portalseiten und Listen-Endpunkte ohne `tcmsKanzleiSeite()` werfen einen
   Programmierfehler (kein Seitenzustand).
4. **Keine Transaktion um Dienstaufrufe.** Daten der kanzleikonsole
   (Kontakte, Dokumente) liest `tcmsTenantLesen(seite, tx => …)` in einer
   eigenen kurzen Transaktion vor oder nach dem Dienstaufruf.
5. **Stichtag.** Historische Stände nur über `StandSchema` aus dem Vertrag;
   ungültige Werte fallen auf den aktuellen Stand zurück. `TcmsKopf` zeigt den
   Stichtag-Wähler.
6. **Kein Caching.** Keine `unstable_cache`, kein `'use cache'`; die Seiten
   rendern dynamisch.

## 4. Namen und Personen

Das Tax-CMS speichert nur Personen-IDs der kanzleikonsole. Namen kommen
**immer** aus der kanzleikonsole, nie aus Formularfeldern oder dem Dienst.

- **Anzeigen:** `tcmsNamenLesen(seite, ids)` (eine Abfrage je Seite nach dem
  Dienstaufruf; `personIdsAus(...)` sammelt und entdoppelt IDs aus mehreren
  Listen). Gesucht wird unter den Mitarbeitern des Tenants (auch inaktiven)
  und, auf Mandanten- und Portalseiten, unter den Kontakten **genau dieses**
  Mandanten. `namen.name(id)` liefert `UNBEKANNTE_PERSON` für fremde oder
  gelöschte IDs und `KEINE_PERSON` (—) für `null`. Höchstens
  `MAX_NAMEN_JE_ABFRAGE` IDs je Aufruf.
- **Aus Formularen übernehmen:** Personen-IDs (Verantwortliche, Gegenzeichner,
  Kontaktrollen) prüft die Aktion in `vorbereiten` mit
  `kanzleiPersonenFuerMandantTx` (aktive Mitarbeiter mit Zugriff auf den
  Mandanten) bzw. `mandantKontakteTx` (Kontakte dieses Mandanten, optional
  inaktive). Unzulässige IDs werfen `TcmsPersonUnzulaessig` und erscheinen als
  Feldfehler; der Dienst wird dann nicht gerufen.
- **Auswahllisten:** `kontakteDesMandantenTx(tx, bezug)` für Kontakte;
  Mitarbeiterlisten nur mit derselben Zugriffsregel wie
  `kanzleiPersonenFuerMandantTx`.

## 5. Eine Aktion schreiben

Vorlage ist `clients/[id]/tcms/kontakte/actions.ts`:

```ts
'use server';
export async function kontaktRollenSetzenAction(
  mandantId: string, // gebunden: aktion.bind(null, mandantId)
  _vorher: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN', // feste Meldung bei 403
    felder: { rollen: 'rollen', funktion: 'funktion', kontaktId: 'kontaktId' },
    parse: () => parseFormData(RollenFormular, formData, { repeatable: ['rollen'] }),
    vorbereiten: async (tx, k, daten) => {
      const [kontakt] = await mandantKontakteTx(
        tx,
        { tenantId: k.g.tenantId, mandantId },
        [daten.kontaktId],
        { feld: 'kontaktId' },
      );
      return kontakt!.id;
    },
    aufruf: async (dienst, daten, kontaktId) => {
      await dienst.rufe(ENDPUNKTE.kontaktRollenSetzen, {
        body: { kontaktId, rollen: daten.rollen, funktion: daten.funktion },
      });
    },
  });
}
```

Ablauf (erzwungen durch `tcmsKanzleiAktion` bzw. `tcmsPortalAktion` in
`server/tcms/aktion.ts`):

1. Gate von `staffAction`/`portalAction` mit `module: 'tcms'` (bei
   `nurAdmin: true` zusätzlich Admin/Partner), danach `parse`.
2. Eine Tenant-Transaktion: `assertTcmsAktivTx`, Akteur
   (`kanzleiAkteurTx` mit dem Mandanten der Aktion bzw. `portalAkteurTx`),
   dann `vorbereiten`. Ohne Mandantenzugriff entsteht keine Bestätigung und
   kein Aufruf.
3. `aufruf` außerhalb der Transaktion über `dienst.rufe(ENDPUNKTE.x, …)`.
   Akteur und `mandantId` setzt der Helfer; Portal-Aktionen erreichen nur
   Portal-Endpunkte, Lesepfade mit Mandantenliste sind gesperrt.
4. Fehler → `ActionResult` über `aktionsFehlerAus` (Abschnitt 6) mit
   Protokoll ohne Rohtexte.
5. Bei Erfolg Revalidierung nur des TCMS-Bereichs
   (`/staff/clients/<id>/tcms` und `/staff/tcms` bzw. `/portal/tcms`).

Regeln:

- **Mandant gebunden, nie aus dem Formular.** `mandantId` ist das erste,
  per `bind` gebundene Argument (Kanzlei) bzw. kommt aus der Sitzung
  (Portal).
- **`'use server'`-Dateien exportieren nur asynchrone Funktionen**;
  Konstanten (z. B. Auswahlwerte) liegen in `components/tcms/…`.
- **403:** Jede Ablehnung des Dienstes trägt einen maschinenlesbaren Grund
  (`fehler.grund`, `TcmsNichtBerechtigt.verweigerung`, TCMS s5). Der feste
  Text kommt aus `TCMS_KEIN_RECHT[verweigerung]` (ein Text je Grund des
  Vertrags: `BEARBEITEN`, `WUERDIGEN`, `VIER_AUGEN`, `VERWALTUNG`,
  `VERTRAULICH`, `DURCHFUEHREN`, `GEGENZEICHNEN`, `PARTEI`, `PORTAL_ROLLE`,
  `PORTAL_ZUGEORDNET`; Vollständigkeit per `satisfies`). **`keinRecht`** der
  Aktion ist nur noch Rückfall ohne Grund (zusätzlich `STANDARD`,
  `VERWERFEN_BESTAETIGEN`). Rechte-Kennzeichen der Durchführung tragen
  denselben Grund als `verweigerung` (`null`: nur der Zustand steht
  entgegen); Vorprüfungen vor einer Ablage wählen danach denselben Text
  (`keinRechtText`). Neue Texte werden **ergänzt**, nie umformuliert.
- **`felder`** ordnet Feldnamen des Dienstes (`felder` eines 400) den
  Formularfeldern zu; nicht zugeordnete Felder ergeben die allgemeine
  Meldung.
- **Formulare** der Seiten senden über `useTcmsFormular`
  (`components/tcms/formular.ts`), nie über ein nacktes
  `useActionState` mit `<form action>`: React 19 setzt sonst unkontrollierte
  Felder auch nach einer Ablehnung zurück.
- **Keine Wiederholung.** Ein Schreibzugriff ohne verlässliche Antwort
  (Zeitlimit, Transport, Protokollfehler) meldet „Ausgang offen – bitte neu
  laden“; der Helfer wiederholt nicht und nimmt keinen Erfolg an.
- Die Guards `server-action-authz.test.ts` und `server-action-style.test.ts`
  erkennen die Helfer nur als Import aus `@/server/tcms/aktion`.

## 6. Fehler und Zustände

Die einzige Abbildung steht in `server/tcms/zustand.ts`; Seiten und Aktionen
zeigen nie den Text des Dienstes.

| Ursache                                      | Seite (`TcmsZustand`)                                 | Aktion (`ActionResult`)                                    |
| -------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| Dienst nicht konfiguriert oder Modul aus     | „Tax-CMS nicht eingerichtet“                          | „Das Tax-CMS ist für diese Kanzlei nicht aktiv.“           |
| keine Bestätigung (`TcmsAkteurVerweigert`)   | „Kein Zugriff“, bei veralteter Sitzung „neu anmelden“ | „Kein Zugriff auf das Tax-CMS.“, ggf. „neu anmelden“       |
| 403 des Dienstes                             | „Kein Zugriff“                                        | fester Text nach `verweigerung` (Rückfall `keinRecht`)     |
| 404                                          | `notFound()` bzw. `daten: null`                       | „nicht gefunden – bitte neu laden“                         |
| 409                                          | „Anfrage nicht möglich“ mit Vorgangsnummer            | „Wurde zwischenzeitlich geändert – bitte neu laden.“       |
| 400 (mit `felder`)                           | „Anfrage nicht möglich“ mit Vorgangsnummer            | Sammelmeldung, Feldfehler „Bitte prüfen Sie diese Angabe.“ |
| unzulässige Person (`TcmsPersonUnzulaessig`) | –                                                     | Feldfehler am Formularfeld, kein Dienstaufruf              |
| 401, 5xx, offener Breaker                    | „derzeit nicht erreichbar“ mit Vorgangsnummer         | „derzeit nicht erreichbar“                                 |
| Zeitlimit, Transport, Protokollfehler        | „derzeit nicht erreichbar“ mit Vorgangsnummer         | Schreiben: „Ausgang offen – neu laden und prüfen“          |

Ein 401 bedeutet einen Fehler zwischen den Diensten (Token, Schlüssel), nicht
fehlende Rechte der Person; deshalb „nicht erreichbar“ statt „Kein Zugriff“.

Protokolliert werden nur Komponente, Endpunkt, Fehlerklasse, Status, Code,
`requestId` und die feste Klassifikation des Clients bzw. der Akteursabbildung
(z. B. `ZEITLIMIT`, `SITZUNG_VERALTET`; `tcmsLogFelder`), nie `meldung`,
`felder` oder der 403-Grund des Dienstes.

## 7. Bausteine (`apps/web/src/components/tcms`)

| Datei              | Inhalt                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zustand.tsx`      | `TcmsZustand` (Fehlerzustände, `role="status"`, Vorgangsnummer)                                                                                                                                               |
| `leer.tsx`         | `TcmsLeer` (leere Listen)                                                                                                                                                                                     |
| `disclaimer.tsx`   | `TcmsPflichthinweis` (Pflicht-Framing aus `@taxtronik/tcms-domain`) – auf jeder Seite mit Statusangaben                                                                                                       |
| `badges.tsx`       | `KlasseBadge`, `AnzeigeBadge`, `GtBadge`, `HashKurz`, `VertraulichBadge`                                                                                                                                      |
| `feststellung.tsx` | `FeststellungBezeichnung`, `feststellungText`: maskierte Feststellungen als „<Nummer> · Vertrauliche Feststellung“                                                                                            |
| `visual.tsx`       | `PhasenStepper`, `MiniSteps`, `BalkenZeilen`, `Fortschritt`, `SegmentBalken`, `SchwellenAnzeige`, `ZeitraumLeiste`                                                                                            |
| `heatmap.tsx`      | `RisikoHeatmap` (Client-Komponente, serialisierbare Props)                                                                                                                                                    |
| `kopf.tsx`         | `TcmsKopf` (Teilbereich, Phase, Stichtag-Wähler)                                                                                                                                                              |
| `navigation.tsx`   | `TcmsMandantNavigation` (Unternavigation mit `aria-current`)                                                                                                                                                  |
| `bereiche.ts`      | `TCMS_MANDANT_BEREICHE`, `aktiverTcmsBereich`, `tcmsBereichHref`                                                                                                                                              |
| `ton.ts`           | Farbtöne der Badges und Chips aus den Tokens der kanzleikonsole                                                                                                                                               |
| `format.ts`        | Datumsanzeige (`isoDatumText`, `isoZeitText`, …) auf Basis von `@taxtronik/tcms-domain`                                                                                                                       |
| `icon.tsx`         | `KatalogIcon` für die Icon-Namen des Katalogs                                                                                                                                                                 |
| `ergebnis.ts`      | `TcmsAktionsErgebnis` (ActionResult mit `meldung`/`warnung`), `TcmsFormAktion` – ein Typ für alle Bereiche                                                                                                    |
| `formular.ts`      | `useTcmsFormular`: Absenden in einer Transition, Eingaben bleiben bei Ablehnung stehen, Reset nur nach Erfolg (abschaltbar), keine Doppelübermittlung, optional Gefahrendialog und `nachLesen`                |
| `zustellung.tsx`   | `ZustellungAnzeige`, `zustellungGescheitert`, `zustellungText`: Zustellstatus der jüngsten Nachricht zu einer Freigabe (Kommunikation, Beschreibung, Risikoakzeptanz), feste Texte je Status, Grund und Zweck |

Bereichsübergreifend genutzte Bausteine in Unterordnern (eine Darstellung je
Sache für Kanzlei und Portal, Integration Stufe 3):

| Datei                              | Inhalt                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `durchfuehrung/nachweis-liste.tsx` | `NachweisListe`: Nachweise der Durchführung (Kanzlei, mit Abgleich zur Ablage) und Anlagen der Kontrollaufgabe (Portal)                 |
| `durchfuehrung/werte.ts`           | `parseDezimal`, `alsEingabe`, `fmtGroesse`: eine Umwandlung von Beträgen und Größen für beide Flächen                                   |
| `programm/beschreibung.tsx`        | `BeschreibungFassung`, `AbschnittAnsicht`, `BausteinBlock`: Beschreibung lebend oder eingefroren, auch die vorgelegte Fassung im Portal |

Darstellung: nur Tokens der kanzleikonsole (`text-foreground`,
`bg-surface-raised`, `border-border`, Badge-Töne aus `ton.ts`); keine Farben
der Demo. Farbe trägt nie allein Bedeutung (Text oder `aria-label` dazu).
Karten sind `section` mit `aria-labelledby`, Listen `ul`/`li`, Tabellen mit
`th scope`. Bereichseigene Bausteine liegen unter
`components/tcms/<bereich>/`; gemeinsame Bausteine werden nur erweitert, wenn
mindestens zwei Bereiche sie brauchen.

## 8. Tests

- **Fixtures:** `apps/web/src/__tests__/tcms-fixtures` hält gekürzte Antworten
  des Dienstes mit dessen Demo-Daten. Jede Fixture wird beim Laden mit dem
  `antwortSchema` des Endpunkts geprüft; ändert sich der Vertrag, scheitern
  die Tests statt veraltete Daten zu rendern. Neue Fixtures werden
  **ergänzt** (eine Datei je Antwort, ein Eintrag in `tcmsFixtures`).
- **Render-Tests:** Seiten-Helfer aus `@/server/tcms/seite` mocken, Antwort
  aus den Fixtures, Seite mit `renderServer` rendern
  (Vorlage: `clients/[id]/tcms/__tests__/seiten.test.tsx`). Zu prüfen: Daten
  der Antwort, Zustände statt Daten, Rechte-Kennzeichen, maskierte Felder,
  Namen nur aus der kanzleikonsole.
- **Aktions-Tests:** Ablauf und Fehlerabbildung testet
  `server/tcms/__tests__/aktion.test.ts`. Bereichsaktionen testen ihre
  Verdrahtung mit gemocktem `@/server/tcms/aktion` (Vorlage:
  `clients/[id]/tcms/__tests__/actions.test.ts`): Mandant aus dem gebundenen
  Argument (auch wenn das Formular einen anderen sendet), `keinRecht`,
  `vorbereiten` mit den Prüfungen der kanzleikonsole, Body des Aufrufs.
- **DB-Tests** gegen PostgreSQL (App-Rolle unter RLS, Owner nur für
  Fixtures; `DB_TESTS=1` bzw. das genannte Opt-in, `prismaOwner`/`prisma` aus
  `@taxtronik/db`, kein eigener `PrismaClient`):

  | Suite                                                         | Inhalt                                                                  | Opt-in                   |
  | ------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------ |
  | `server/tcms/__tests__/akteur-db.test.ts`                     | Akteursabbildung (Stufe 2)                                              | `TCMS_AKTEUR_DB_TEST`    |
  | `server/tcms/__tests__/namen-personen-db.test.ts`             | Personenprüfung und Namen (Fundament)                                   | `TCMS_SEITE_DB_TEST`     |
  | `server/tcms/programm/__tests__/zustaendigkeit-db.test.ts`    | Zuständigkeiten und Freigabe-Empfänger (Bereich A)                      | `TCMS_SEITE_DB_TEST`     |
  | `server/tcms/bereich-b/__tests__/personen-auswahl-db.test.ts` | Auswahllisten der Zuständigkeiten (Bereich B)                           | `TCMS_SEITE_DB_TEST`     |
  | `server/tcms/__tests__/nachweis-verweis-db.test.ts`           | Verknüpfung, Lösch- und Versionssperre der Nachweise (Bereich C)        | `TCMS_SEITE_DB_TEST`     |
  | `server/tcms/__tests__/bereich-d-db.test.ts`                  | Auslieferung, Portal-Anlagen als Nachweis, Ansprechpersonen (Bereich D) | `TCMS_BEREICH_D_DB_TEST` |

- **Live-Tests** gegen einen laufenden Dienst mit Demo-Daten
  (`TCMS_LIVE_TESTS=1` plus DB-Opt-in, Start wie in
  [Anbindung, Abschnitt 6](tcms-anbindung.md#6-vertragstest-gegen-den-echten-dienst)),
  rendern die Seiten und rufen die Aktionen echt auf. Alle nutzen denselben
  Demo-Tenant und laufen deshalb **nacheinander**, nie parallel:
  `server/tcms/__tests__/oberflaechen-live.test.tsx` (Fundament),
  `server/tcms/programm/__tests__/programm-live.test.tsx` (A),
  `server/tcms/__tests__/bereich-b-live.test.tsx` (B: je Seite Rendering und
  eine Aktion),
  `server/tcms/__tests__/bereich-c-live.test.tsx` (C),
  `server/tcms/__tests__/bereich-d-live.test.tsx` (D). Objekt-IDs des
  Dienstes (Durchführungen, Feststellungen, Ereignisse) lesen die Suiten aus
  dessen Antworten, nie fest verdrahtet: Der Seed des Tax-CMS vergibt sie je
  Datenbank neu. C löscht beim Aufräumen die Abrufnachweise (`audit_log`, nur
  anhängend) und braucht dafür als `DATABASE_URL` eine Verbindung, die
  `session_replication_role` setzen darf (Superuser der Testdatenbank).
- **Guards** erkennen die Helfer: `client-page-authz.test.ts`
  (`tcmsMandantSeite` als geprüfter Wrapper, `requireClientPageAccess` als
  erster Aufruf im Helfer, jedes Layout im Segment), `module-page-guard.test.ts`
  (Einstieg prüft den Modulbereich), `staff-page-authz.test.ts`,
  `server-action-authz.test.ts`, `server-action-style.test.ts`,
  `client-revalidation-scope.test.ts`, für Route Handler
  `tcms-route-authz.test.ts` (Abschnitt 11).
- Regeln des Fachkatalogs: Testdateien, die eine Regel belegen, tragen den
  Marker `Fachkatalog: TCMS-…`.

## 9. Checkliste für einen neuen Bereich

1. Demo-Seite und Endpunkte im TCMS-Repo lesen (`apps/web/src/app/…`, `ENDPUNKTE` in
   `packages/tcms-contract/src`).
2. Route unter dem Pfad aus `TCMS_MANDANT_BEREICHE` anlegen; erster Aufruf
   der passende Einstieg; Überschrift `h2`.
3. Lesen über `tcmsLesen`; Namen über `tcmsNamenLesen`; Zustände über
   `TcmsZustand`; Pflichthinweis bei Statusangaben.
4. Aktionen über `tcmsKanzleiAktion`/`tcmsPortalAktion`; Personen in
   `vorbereiten` prüfen; `keinRecht` und `felder` setzen.
5. Labels aus `@taxtronik/tcms-domain`; keine eigene Fachlogik.
6. Fixture ergänzen, Render- und Aktionstests, bei Schutzregeln ein Test, der
   ohne die Regel scheitert.
7. `pnpm lint`, Typprüfung, Tests; Anwenderdoku `docs/anwenderdoku/tax-cms.md`
   ergänzen.

## 10. Gemeinsame Dateien

Diese Dateien teilen sich alle Bereiche. Änderungen an ihrer **Semantik**
(Prüfkette, Bindung von Akteur und Mandant, Fehlerabbildung) brauchen
Abstimmung und eigene Tests mit Mutationsnachweis:

- `apps/web/src/server/tcms/seite.ts`, `aktion.ts`, `zustand.ts`,
  `namen.ts`, `personen.ts`, `akteur.ts`
- `apps/web/src/components/tcms/*.tsx|ts` (außer eigenen Unterordnern)
- Guard-Tests unter `apps/web/src/__tests__/`

Nur **ergänzen** (keine bestehenden Einträge ändern): `TCMS_KEIN_RECHT`,
`tcmsFixtures` und neue Fixture-Dateien, Exporte in `components/tcms`.

## 11. Route Handler für Datei-Abrufe

Dateien zu Verweisen des Tax-CMS (Nachweise einer Durchführung, Anlagen
einer Meldung) liefert die kanzleikonsole über Route Handler aus, nicht über
Seiten. Einstieg ist `server/tcms/route.ts` (gemeinsamer Baustein der
Bereiche C und D). Bestehende Abrufe:

| Route                                                                  | Einstieg               | Lesen                 |
| ---------------------------------------------------------------------- | ---------------------- | --------------------- |
| `/api/staff/clients/[id]/tcms/nachweise/[nachweisId]`                  | `tcmsMandantRoute(id)` | `nachweisLesen`       |
| `/api/staff/clients/[id]/tcms/ereignisse/anlage?e=…&h=…`               | `tcmsMandantRoute(id)` | `ereignisAnlageLesen` |
| `/api/portal/tcms/aufgaben/[id]/anlagen/[nachweisId]` (mit Lese-Limit) | `tcmsPortalRoute()`    | `portalAnlageLesen`   |

```ts
// app/api/staff/clients/[id]/tcms/nachweise/[nachweisId]/route.ts
import type { NextRequest } from 'next/server';
import { tcmsMandantRoute } from '@/server/tcms/route';
import { nachweisAusliefern } from '@/server/tcms/durchfuehrung/nachweis-download';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; nachweisId: string }> },
) {
  const { id, nachweisId } = await params;
  const route = await tcmsMandantRoute(id); // 1. immer zuerst
  if (!route.ok) return route.antwort;
  return nachweisAusliefern(req, route, nachweisId);
}
```

| Einstieg               | Ort                                | Prüfkette                                                                                                                                                              |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tcmsMandantRoute(id)` | `app/api/staff/…/tcms/…/route.ts`  | `staffAuth` zuerst, gültige ID, Modulbereich `tcms`, Dienst konfiguriert; in einer Tenant-Transaktion Mandant im Tenant, `canAccessClientTx`, aktiv, `kanzleiAkteurTx` |
| `tcmsPortalRoute()`    | `app/api/portal/…/tcms/…/route.ts` | `portalAuth` zuerst, Modulbereich `tcms`, Dienst konfiguriert; aktiv, `portalAkteurTx`; Mandant nur aus der Sitzung                                                    |

- **Lesen:** `tcmsRouteLesen(route, ENDPUNKTE.x, { params })` nur für
  GET-Endpunkte mit Mandant im Pfad, deren `akteure` die Art der Route nennen
  (Portal-Route: `MANDANT`, Kanzlei-Route: `KANZLEI`; wie `seite.ts` und
  `aktion.ts` seit TCMS Stufe 4);
  `mandantId` und Akteur setzt der Helfer, der Aufruf läuft außerhalb jeder
  Transaktion. Andere Endpunkte sind Programmierfehler.
- **Antworten:** `{ ok: false, antwort }` mit fester JSON-Antwort
  (`TCMS_ROUTE_ANTWORTEN`: `error`-Code und deutscher Text, nie der Text des
  Dienstes; `Cache-Control: private, no-store`, `nosniff`). Ohne Sitzung 401,
  veraltete Sitzung 401 `session_stale`; ungültige ID, fremder oder nicht
  zugänglicher Mandant, Modul aus, Dienst nicht konfiguriert oder inaktiv,
  404 des Dienstes: 404 ohne Hinweis auf die Existenz; 403 des Dienstes 403;
  400/409 des Dienstes 400; Ausfall 503 mit `requestId`.
  `tcmsRouteAntwort(art)` liefert dieselben Antworten für Bereichs-Helfer.
- **Bytes nur aus der kanzleikonsole:** Der Verweis des Tax-CMS nennt
  Dokument-ID und SHA-256; ausgeliefert wird ausschließlich über
  `loadDocumentDelivery`/`documentDownloadResponse`
  (`server/documents/delivery.ts`) mit den Rechten der kanzleikonsole
  (Mandant, `canAccessClientTx`, gelöscht, Scanstatus, Lohnrechte). Weicht der
  SHA-256 (oder die Größe) der auszuliefernden Version vom Verweis ab, wird
  nicht ausgeliefert, sondern mit Hinweis abgebrochen; der Abgleich läuft vor
  dem Abrufnachweis und erneut an der tatsächlich gestreamten Version.
- **Nur GET**, keine eigene Sitzung, kein direkter Client- oder Akteurzugriff
  im Handler. Schreiben läuft über Server Actions (Abschnitt 5).
- **Guards:** `tcms-route-authz.test.ts` (Ort unter `app/api/staff` bzw.
  `app/api/portal`, nur `GET`, Einstieg als erster Aufruf mit der ID aus
  `params` bzw. ohne Argument, keine Importe von Client, Dienst, Akteur,
  Seiten-/Aktions-Helfern oder Sitzung; Reihenfolge im Einstieg selbst) und
  `api-route-authz.test.ts` (erkennt die Einstiege nur als Import aus
  `@/server/tcms/route`). Semantik: `server/tcms/__tests__/route.test.ts`.
