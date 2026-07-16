# Optimierungsbericht — Code-Review 2026-07-16

Reviewdimensionen: Query-Performance, Redundanzen, Code-Struktur ("Spaghetti"), React/Client-Performance.
Methodik: vier unabhängige Review-Durchläufe über `apps/web`, `apps/worker`, `packages/*`; die Top-Befunde wurden anschließend einzeln am Code verifiziert.

**Gesamteindruck:** Die Codebase ist überdurchschnittlich diszipliniert — CAS-/Lock-Muster, Evidence-Records und Zod-Validierung sind konsistent, viele frühere Perf-Pässe (P-1…P-5) sind sichtbar, Reports/Audit-Log/Suche sind bereits sauber optimiert. Die folgenden Befunde sind das, was übrig ist. Kein Befund ist ein akuter Bug im Sinne von Datenverlust; drei Befunde (D2, D4, R3) haben aber Sicherheits-/Compliance-Relevanz durch bereits eingetretene Drift.

---

## Top 10 (nach Impact, quer über alle Dimensionen)

| #   | Befund                                                                         | Bereich             | Schwere |
| --- | ------------------------------------------------------------------------------ | ------------------- | ------- |
| 1   | 30s-`router.refresh()` global × schwerste Seiten (Q1/P1)                       | Performance         | hoch    |
| 2   | Dashboard-Refresh läuft ins Leere: Widgets in State eingefroren (P3)           | Performance/Bug     | hoch    |
| 3   | Mandanten-Detailseite: bis 1.000 Dokumente immer im Payload (P2)               | Performance         | hoch    |
| 4   | Workflow-Statistik: ungebounded Full-Load + JS-Aggregation (Q2)                | Queries             | hoch    |
| 5   | Fehlender Index `[tenantId, createdAt]` auf `Request` (Q3)                     | Queries             | hoch    |
| 6   | Worker-Notification-Kopie ohne Sanitization (D2)                               | Redundanz/Drift     | hoch    |
| 7   | BWA-Plan-Actions doppelt, Sanity-Check nur in Portal-Kopie (D4)                | Redundanz/Drift     | hoch    |
| 8   | `submitOnboardingAction`: 590-Zeilen-Funktion, 490-Zeilen-Tx-Callback (S1)     | Struktur            | hoch    |
| 9   | GwG-Entscheidungs-Gate doppelt implementiert (S4)                              | Struktur/Compliance | hoch    |
| 10  | `client-layout.ts` vs. `client-layout-shared.ts`: 90 Zeilen zeichengleich (D1) | Redundanz           | hoch    |

---

## A. Performance: Rendering & Refresh (verifiziert)

### P1 — Globaler 30s-Refresh multipliziert jede Ineffizienz _(hoch)_

`apps/web/src/components/auto-refresh.tsx:16,49` feuert alle 30 s `router.refresh()`, gemountet in beiden Protected-Layouts (`staff/(protected)/layout.tsx:139`, `portal/(protected)/layout.tsx:101`). Zusätzlich pollt `notifications-bell.tsx` alle 30 s und feuert bei neuen Benachrichtigungen einen **weiteren** Voll-Refresh.

Konsequenz: Jede Server-Component-Query jeder offenen Seite läuft dauerhaft alle 30 s pro Tab — die Serverlast skaliert mit offenen Tabs, nicht mit Aktivität. Alle Query-Befunde unten wirken dadurch permanent.

**Fix:** Intervall auf ≥120 s anheben, den ereignisgetriebenen Bell-Refresh als primären Mechanismus nutzen, oder pro-Route-Opt-out für die schwersten Seiten (`clients/[id]`).

### P2 — Mandanten-Detailseite: 1.000-Dokumente-Tabelle immer gerendert _(hoch)_

`clients/[id]/page.tsx:41` (`MANAGER_DOCS_CAP = 1000`) + `document-explorer.tsx:1378`: `CockpitGrid` rendert alle Blöcke inkl. kompletter Dokumententabelle bei jedem Aufruf — bis zu ~20.000 DOM-Knoten, alle 30 s neu serialisiert und reconciled.

**Fix:** Embedded-Variante paginieren (Server kennt `totalCount` bereits) oder minimal `content-visibility: auto` auf den Zeilen; Dokument-Block hinter eigene Suspense-Grenze.

### P3 — Dashboard: Auto-Refresh-Arbeit wird weggeworfen, Widgets bleiben stale _(hoch, verifiziert)_

`dashboard/dashboard-grid.tsx:79` hält die servergerenderten Widget-Nodes in `useState(initialRendered)`; `setRenderedWidgets` wird nur bei Add/Remove aufgerufen (Z. 196, 222), nie aus neuen Props. Jeder 30s-Refresh führt **alle** Widget-DB-Queries erneut aus (concurrency-gecappt, also bekannt teuer) — aber die frischen Nodes erreichen die UI nie.

**Fix:** Rendered-Nodes direkt aus Props ableiten, State nur für Layout-Mutationen/optimistische Adds. Dann liefert der Refresh tatsächlich frische Widgets — oder man spart ihn sich fürs Dashboard.

### P4 — `document-explorer.tsx` EmbeddedView: entwertetes `useMemo` _(mittel)_

Z. 1154–1155: `active`/`deleted` werden pro Render neu ge-filtert und sind Deps des `shown`-Memos (Z. 1165) → Memo invalidiert immer; `countIn()` (Z. 1158, 1200) macht pro Ordnerzeile einen Full-Scan (O(Ordner × 1000) pro Tastenanschlag im Suchfeld).

**Fix:** `active`/`deleted` in `useMemo([documents])`; Ordner-Counts einmalig als `Map` aggregieren; Suchfeld mit `useDeferredValue` entkoppeln.

### P5 — 110 von 114 Seiten ohne `loading.tsx`, kein `<Suspense>` _(mittel)_

Bei app-weitem `force-dynamic` (`app/layout.tsx:17`) friert jede Navigation zu schweren Seiten (`/staff/documents`, `/staff/workflows`, `/staff/requests`) ohne Feedback ein. **Fix:** Skeleton-`loading.tsx` für die Top-Routen.

### P6 — `revalidatePath('/staff/clients', 'layout')` als Standard-Nuke _(mittel)_

~30 Callsites (allein 15 in `clients/[id]/workflows/actions.ts`, dazu phone-notes, reminders, handovers, binders, gwg/invite-actions): Das Abhaken einer Telefonnotiz invalidiert den Router-Cache **aller** Seiten unter `/staff/clients`. **Fix:** Zielgenau `revalidatePath('/staff/clients/' + clientId)` + ggf. Liste; `'layout'`-Scope nur für Settings-Actions.

### P7 — Kleinigkeiten _(niedrig)_

- 17 redundante `export const dynamic = 'force-dynamic'` auf Page-Ebene (Root-Layout setzt es bereits) — entfernen oder als Muster kommentieren.
- `dashboard/bookmark-button.tsx:27`: Derived-State-per-Effect (einziges Vorkommen des Antipatterns).

**Explizit geprüft und in Ordnung:** exceljs dynamisch importiert, Tiptap route-gesplittet, Polling in Subsumtion/Audit-Verify diszipliniert (Deadlines, Visibility), GwG-Vorschauen lazy per IntersectionObserver, Suchfelder entprellt mit Sequenz-Guards.

---

## B. Datenbank-Queries (verifiziert)

### Q1 — Kontext: Alle Seiten-Queries laufen alle 30 s (siehe P1)

### Q2 — Workflow-Statistik: Full-Load + JS-Aggregation _(hoch)_

`workflows/stats/page.tsx:25–94`: `workflowTemplate.findMany` mit `include: { instances: { items } }` ohne `take`, ohne Statusfilter — alle jemals gelaufenen Instanzen inkl. Items werden geladen, nur für Counts/Ø-Durchlaufzeit/Engpass-Position in JS. Wird linear langsamer.

**Fix:** `groupBy` für Zähler + `$queryRaw` mit `AVG(completed_at - started_at)` je Template bzw. `GROUP BY template_id, position`.

### Q3 — Fehlender Index für Default-Sortierung der Anforderungs-Liste _(hoch, verifiziert)_

`requests/page.tsx:113–123` sortiert im Default `orderBy: { createdAt: 'desc' }`; das `Request`-Model (`schema.prisma:1456–1464`) hat Indexe auf `[tenantId, clientId]`, `[tenantId, status]`, `[tenantId, dueAt]` — keinen auf `createdAt`. Postgres sortiert pro Render (alle 30 s) alle Requests des Tenants.

**Fix:** `@@index([tenantId, createdAt(sort: Desc)])` + Migration. Prüfenswert analog: `@@index([clientId, createdAt])` auf `Document` für Timeline/Cockpit.

### Q4 — Kalender/Steuertermine: Vollzeilen + ungenutztes Include, Gruppierung in JS _(mittel)_

`calendar/page.tsx:57–61,137–155` lädt alle Monats-Deadlines mit `include: { client }`, obwohl `d.client` nirgends verwendet wird, und reduziert in JS auf Tages-Counter. **Fix:** `taxDeadline.groupBy({ by: ['dueDate','kind','period','status'], _count })`; Client-Include streichen.

### Q5 — Fristenkontrollbuch: fünf ungecappte Vollzeilen-Queries _(mittel)_

`server/fristen/kontrollbuch.ts:67–141,283`: kein `select` (u. a. `description`-Langtext), Erledigte werden immer mitgeladen und bei `filter=offen` in JS verworfen, `nurStaffId` wird erst in JS angewendet. **Fix:** `select` je Quelle; `nurOffene`/`nurStaffId` in die Query ziehen.

### Q6 — Worker-Jobs: N+1 und Zeilen-Transaktionen _(mittel)_

- `reminders-daily.ts:92–129`: lädt alle künftigen `appealDeadline`-Bescheide und filtert in JS auf {14,7,1} Tage; pro Zeile eigene Transaktion, meist in P2002-Dedupe laufend. **Fix:** exakte Tagesfenster in SQL, bestehende Notifications als Set vorladen, `createMany(skipDuplicates)`.
- `gwg-expiry-check.ts:281–288`: `request.findFirst` pro ablaufendem Ausweisdokument (N+1). **Fix:** ein `findMany({ linkedGwgIdDocumentId: { in: docIds } })` + Set.

### Q7 — Notification-Poll: zwei sequenzielle Transaktionen pro Poll _(mittel)_

`api/staff/notifications/recent/route.ts:14–37`: heißester Endpoint der App (30s × Tabs) öffnet zwei getrennte `withTenantContext`-Transaktionen. **Fix:** ein Kontext, `Promise.all([findMany, count])`.

### Q8 — Weitere Query-Befunde _(mittel–niedrig)_

- `server/workflows/queries.ts:19–51`: ungecappter Deep-Include (alle Instanzen inkl. aller Kommentare/Dokumente) → abgeschlossene Instanzen cappen (`take: 20`) oder nur `_count`.
- `clients/[id]/page.tsx:81–122`: 50 Requests + letzte Response als Vollzeilen (Langtexte ungenutzt) → `select`; `visibleClient`-Backstop in die Haupt-Tx ziehen.
- `dashboard/widgets/personal.tsx:181`: Done-Item-IDs laden statt gefiltertem `_count`.
- `time/page.tsx:32`: alle Mandanten ungecappt fürs Dropdown (Kalender cappt dieselbe Liste auf 500).
- `portal/dashboard/page.tsx:27`, `documents/page.tsx:129`: fehlendes `select` bzw. separater Access-Check als eigene Tx (`canAccessClientTx` existiert bereits).

**Explizit geprüft und in Ordnung:** Reports (DB-aggregiert), Audit-Log (reltuples + Keyset), Widget-Orchestrierung (parallel, Concurrency-Cap), `staffAuth`/`readModules`/`readBranding` (React `cache()`), Timeline-Builder, Tax-Deadline-Materialisierung, globale Suche (trgm-GIN deckt `contains`), n8n-Delivery-Worker, Listen-Seiten (paginiert).

---

## C. Redundanzen (Drift-Risiken, teils bereits eingetreten)

### D1 — `client-layout.ts` vs. `client-layout-shared.ts`: kompletter Modul-Doppel _(hoch)_

`server/settings/client-layout.ts:17–117` und `client-layout-shared.ts:1–90` definieren zeichengleich: `ClientBlockKey`, `ALL_CLIENT_BLOCKS`, `CLIENT_BLOCK_LABELS`, `BLOCK_SIZE`, `DEFAULT_CLIENT_LAYOUT`. Konsumenten importieren gemischt. Vergisst man beim nächsten Block eine Seite, resetted `normalize()` gespeicherte Layouts. **Fix:** `client-layout.ts` re-exportiert aus `-shared` und behält nur die DB-Funktionen.

### D2 — Worker-Notification-Kopie ohne Sanitization _(hoch, verifiziert — Drift eingetreten)_

`server/notifications/service.ts:53–102` (`notify`) und `apps/worker/src/notify.ts:24–74` (`upsertNotification`) sind dieselbe Advisory-Lock-Upsert-Logik — aber die Q-8-Härtung (`sanitizeText`: Control-Chars/BiDi, `<`→`‹`) fehlt in der Worker-Kopie komplett (verifiziert: kein `sanitize` in der Datei). Notifications aus gwg-expiry, poa-expiry, invoice-overdue, reminders gehen unsaniert in die DB. Auch der Dedupe-Key-Aufbau kann driften. **Fix:** gemeinsame Implementierung (nimmt `TxClient`), beide Seiten werden dünne Wrapper.

### D3 — `pgConnArgs`/pg*dump-Pipeline 3× *(hoch)\_

`server/backup/runner.ts:44`, `server/backup/restore.ts:44`, `apps/worker/src/pg-conn.ts:16` — dieselbe sicherheitsrelevante Passwort-/SSL-Behandlung (P-2) dreimal; die Dump-Spawn-Pipeline (SHA-256-Stream, ENOENT-Handling, Multipart-Upload) doppelt zwischen `runner.ts` und `worker/jobs/backup-run.ts`. Der Worker-Header sagt selbst, das solle „an EINER Stelle liegen". **Fix:** in ein Paket (`packages/db`-Subpath o. Ä.), Web + Worker importieren.

### D4 — BWA-Plan-Actions doppelt, Check nur in einer Kopie _(hoch, verifiziert)_

`portal/(protected)/bwa/plan/actions.ts` (222 Z.) und `staff/(protected)/clients/[id]/bwa/plans/actions.ts` (215 Z.) sind bis auf Actor/Guards identisch. Der M-1-Check „`basePeriodId` gehört zum Client" existiert **nur** in der Portal-Kopie; die Staff-Kopie schreibt `basePeriodId` ungeprüft (Z. 30/76, verifiziert) — Verlinkung auf die BWA-Periode eines anderen Mandanten desselben Tenants möglich. **Fix:** Domänenlogik nach `server/bwa/plans.ts`, Check in den gemeinsamen Kern.

### D5 — `berlinTodayUtcMidnight` 3× _(mittel)_

`lib/fmt.ts:337`, `server/poa/signing-snapshot.ts:112`, `apps/worker/src/date-util.ts:11` — dreimal dieselbe zeitzonenkritische Konstruktion; ein einseitiger DST-Fix hieße stille Off-by-one-Tage bei Fristen. **Fix:** ein Export (z. B. in `@taxtronik/tax`, dort existieren bereits Berlin-Formatter).

### D6 — Pino-Redact-Listen Web vs. Worker gedriftet _(mittel)_

`server/logger.ts:16–34` redacted Root- **und** Wildcard-Pfade; `worker/src/logger.ts:18–33` nur Wildcard — Root-Level-Felder (`log.info({ token })`) werden im Worker nicht redacted, obwohl der Kommentar Spiegelung behauptet. **Fix:** gemeinsame Liste in `@taxtronik/config`.

### D7 — Zwei Markdown→HTML-Renderer, beide in `dangerouslySetInnerHTML` _(mittel)_

`lib/markdown.ts` vs. `server/markdown.ts`: getrennte Escaping-/URL-Whitelist-Implementierungen; die Round-12-Härtungen hat nur die Server-Variante. Jeder XSS-Fix muss zweimal gefunden werden. **Fix:** mindestens `esc`/`safeHref` teilen.

### D8 — Label-Map-Klasse: 6× Klassifikations-Labels, 4× Notice-Kind, 3–4× Status-Maps — mit nachweisbarem Drift _(mittel)_

- Dokument-Klassifikation 6× (u. a. `document-explorer.tsx:92`, `workflow-upload-button.tsx:24`, Timeline, DATEV-Export) — „GwG Nachweis" vs. „GwG-Nachweis".
- Notice-Status 3×: „Abgeholfen" vs. „Einspruch abgeholfen", „Klage erhoben" vs. „Klage beim Finanzgericht".
- Rechnungs-Status 4× (in `reports/page.tsx:323` sogar inline im Render, Allokation pro Zeile).
- Risk-/Subsumtions-Labels UI vs. PDF-Export doppelt (`subsumtion/_ui.ts:95` vs. `server/risk/export/report-model.ts:36`) — im IDW-PS-980-Kontext soll der Report exakt zeigen, was die UI zeigte.
- Kleinere: Tax-Deadline-, GwG-Check-, GwG-Invite-, Form-Submission-Status je 2–3×, teils gedriftet.

**Fix-Muster** (Vorbilder existieren: `server/audit/labels.ts`, `server/onboarding/status.ts`): Labels leben neben der Status-/Enum-Definition, UIs importieren; Portal-Abweichungen explizit per Spread-Override.

### D9 — Boilerplate-Klasse _(mittel)_

- **Zod-FormData-Zeremonie:** 101× wortgleich `if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' }` über 52 Action-Dateien, mit driftenden `?? ''`-Konventionen. **Fix:** `parseFormData(schema, formData)`-Helfer neben `staff-action.ts`, optional in `withStaff` integriert.
- **Page-Auth:** `staffAuth()` + Redirect in 91 Dateien, Admin-Check in 34 — reine Erinnerungsdisziplin, anders als bei Actions ohne Guardrail-Test. **Fix:** `requireStaffPage({ admin? })` + Struktur-Test analog `server-action-authz.test.ts`.

### D10 — Kleineres _(niedrig)_

`fmtBytes` 3× (Portal-Variante endet bei MB → „2048.0 MB"), `formatMinutes`/`formatEur`/`formatIsoDate` lokal statt aus `lib/fmt.ts`, `binders-block.tsx` vs. `handovers-block.tsx` strukturidentisch (230 Z.), zwei Upload-Widgets mit dupliziertem Commit-Code (→ `useDocumentCommit()`-Hook).

---

## D. Struktur / "Spaghetti"

Vorab: Die Service-Schicht (`server/*`, `packages/*`) wird von den meisten Actions genutzt; das Problem sind überlange Orchestrierungs-Funktionen und God-Components, nicht Logik im falschen Layer.

### S1 — `gwg-onboarding/actions.ts` (1.112 Z.) _(hoch)_

`submitOnboardingAction` (Z. 522–1111): ~590 Zeilen, davon ein ~490-Zeilen-Transaktions-Callback mit acht Phasen und einer verschachtelten Closure `persistIdentitySet` (Z. 836–896). GwG-Kernlogik, nicht isoliert testbar, Phasen-Invarianten (Claim-vor-Mutation, Consent-Lock-zuletzt) nur implizit.
**Refactoring (risikoarm zuerst):** (1) `persistIdentitySet` als exportierten Tx-Helfer nach `server/gwg-onboarding/` heben; (2) Vorvalidierung (Z. 552–604) als reine Funktion bündeln; (3) Tx-Body in Phasen-Funktionen schneiden, Reihenfolge als lesbares Skript behalten.

### S2 — `poa/actions.ts` (1.277 Z.) _(hoch)_

`createPoaAction` (Z. 152–628): mischt PoA-Fachlogik mit generischer Zwei-Phasen-Upload-Maschinerie (Resume/Commit/Finalize, Z. 245–508, drei tief verschachtelte Pfade, 4 `withTenantContext`-Roundtrips, `assertPoaCreateContextTx` 4× identisch). Die Wiederaufnahme-Logik ist nicht PoA-spezifisch.
**Refactoring:** Resume-/Commit-Orchestrierung als wiederverwendbaren Service nach `server/documents/` (neben `createPendingDocumentWithVersion`); PoA-Action ruft nur noch auf.

### S3 — `admin/settings/n8n-form.tsx` (1.831 Z.) _(hoch)_

God-Component: 36 `useState` in einer Komponente (Z. 134–184), ~18 Handler, fünf fachlich unabhängige Sektionen in einem JSX-Baum — komplettes Re-Render bei jedem Tastendruck; State doppelt als hidden inputs gespiegelt (Z. 604–617); fünf fast identische confirm→action→result-Handler (Z. 424–508).
**Refactoring:** zustandsarme Sektionen zuerst extrahieren (`DeliveryOperationsSection`, `RouteEditorSection`), Hook `useConfirmedAction()`, Connection-Form auf `useReducer`. (Admin-only: Wartbarkeits-, kein Nutzer-Performance-Thema.)

### S4 — `clients/[id]/gwg/actions.ts` (2.721 Z.) _(mittel — diszipliniert trotz Größe)_

Konsistente Muster (parse → withStaff → lock → CAS → mutate → evidence), Fachlogik in `server/gwg/*`. Punktuell:

- **Doppeltes Entscheidungs-Gate:** `submitCheckForReviewAction` (Z. 2292–2325) vs. `verifyCheckAction` (Z. 2491–2541) implementieren die Gate-Kette (Risiko-Vollständigkeit, `gwgVerificationErrors` mit 12 identischen Feldern, PEP-Regeln) fast wortgleich — bei Regeländerung droht Drift zwischen Einreichungs- und Freigabe-Gate. **Fix:** `gwgDecisionGateErrors(check)` in `server/gwg/verification.ts` — risikoarm, hoher Compliance-Nutzen.
- `saveLegalEntityDetailsAction` (Z. 593–949): Vertreter-Diff-Engine inline (Zweiphasen-Shift, Link-Swap-NULL-Phase, Raw-SQL-Bulk) → als `syncGwgRepresentativesTx` extrahieren + Unit-Tests.
- `startCheckCycle` (Z. 211–410): Snapshot-Kopie inline → `copyGwgSnapshotTx` neben `reverification.ts`.

### S5 — `gwg-onboarding/wizard.tsx` (1.298 Z.) _(mittel)_

- `handleIdUpload` vs. `handleRepresentativeIdUpload` (Z. 218–302): ~40 Zeilen identisch bis auf Setter → triviale Extraktion.
- `validateStep` (Z. 332–431): §-11-Abs.-4-GwG-Pflichtregeln im Client, Server validiert separat — Regeln existieren zweimal mit Drift-Risiko → reine Validierungsfunktionen in gemeinsames Modul.
- Step-Blöcke (Z. 559–858) als eigene Komponenten; `alert(err)` (Z. 436) ersetzen.

### S6 — `identity-document-review.tsx` (1.084 Z.) _(mittel)_

`IdentityReviewCard` (Z. 546–1015): versteckte State-Maschine — State + fünf Refs + drei gekoppelte Effekte (Z. 678–734) für Revisions-CAS/Reconciliation; Korrektheit hängt an Effektreihenfolge. **Fix:** Custom Hook `useIdentityReviewState` als `useReducer` (die vorhandenen reinen Funktionen Z. 81–118 werden Reducer-Zweige). Vorsicht: subtile Optimistic-Update-Semantik → Tests zuerst.

### S7 — `clients/[id]/page.tsx` (1.082 Z.) _(mittel/niedrig)_

Kein Spaghetti, aber 15-Query-Block + ~750 Z. JSX mit Inline-IIFEs. **Fix:** Loader als `loadClientDashboard()` in `_data.ts`, Sektionen inkrementell als lokale Server-Components.

### Trotz Größe in Ordnung

`marking-panel.tsx` (1.552 Z., gut zerlegt — optional Context gegen Prop-Drilling), `document-explorer.tsx` (Struktur ok; nur `uploadDropped`-Fachlogik Z. 508–560 und doppelte Zeilen-Aktionen Z. 894 vs. 1398 konsolidieren), `n8n-actions.ts` (gut organisiert; BullMQ-Job-Optionen 2× → `enqueueN8nDelivery`-Helfer).

---

## Empfohlene Reihenfolge

**Quick Wins (je < 1 h, sofort):**

1. Q3: Index `[tenantId, createdAt(Desc)]` auf `Request` (Migration).
2. Q7: Notification-Poll in eine Tx mit `Promise.all`.
3. D2: `sanitizeText` in Worker-`upsertNotification` (Sofortfix), Konsolidierung danach.
4. D4: `basePeriodId`-Check in die Staff-BWA-Action kopieren (Sofortfix), Konsolidierung danach.
5. D1: `client-layout.ts` → Re-Export aus `-shared`.
6. Q4: Kalender auf `groupBy`, Client-Include streichen.

**Hoher Hebel (je ½–2 Tage):** 7. P3: Dashboard-Grid — Rendered-Nodes aus Props statt State (macht P1 fürs Dashboard erst sinnvoll). 8. P1: Refresh-Strategie kalibrieren (Intervall/Opt-out) — multipliziert alle übrigen Gewinne. 9. P2/P8: Dokumententabellen paginieren bzw. `content-visibility`. 10. Q2: Workflow-Statistik auf DB-Aggregation. 11. S4: `gwgDecisionGateErrors` konsolidieren (Compliance-Drift-Schutz). 12. P6: `revalidatePath`-Scopes zielgenau.

**Mittelfristig (Refactoring-Slots):** 13. S1–S3: die drei Monolithen (Onboarding-Tx, PoA-Upload-Service, n8n-Form-Split) — jeweils inkrementell, risikoarm beginnend. 14. D8/D9: Label-Module je Domäne + `parseFormData`-Helfer + `requireStaffPage` mit Guardrail-Test. 15. D3/D5/D6/D7: geteilte Infrastruktur-Primitiven (pg-conn, Berlin-Datum, Redact-Liste, Markdown-Escaping) in Pakete.

---

_Verifikationsstand: Die Befunde P3, Q3, D2, D4 wurden zusätzlich zur Agenten-Recherche manuell am Code bestätigt. Zeilenangaben beziehen sich auf den Stand von Commit `1219353`._

---

## Umsetzungsstand 2026-07-16

Der Bericht wurde vollständig abgearbeitet. Die Änderungen wurden bewusst in kleinen,
testbaren Bausteinen umgesetzt; sicherheitskritische Mandanten-, CAS-, Lock- und
Transaktionsgrenzen blieben erhalten.

| Bereich | Status   | Umsetzung                                                                                                                                                                                                                                                               |
| ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1–P7   | erledigt | Refresh-Policy kalibriert, Mandanten-Dokumente serverseitig paginiert und separat gestreamt, Dashboard-State synchronisiert, Document Explorer optimiert, Skeletons ergänzt sowie Revalidierungs- und Dynamic-Rendering-Scopes eingegrenzt.                             |
| Q2–Q8   | erledigt | Workflow- und Kalender-Aggregationen in die DB verlagert, Query-Payloads begrenzt, Kontrollbuchfilter in SQL gezogen, Worker-N+1 beseitigt und Notification-Poll zusammengeführt.                                                                                       |
| D1–D8   | erledigt | Layout-, Notification-, PostgreSQL-, BWA-, Datums-, Logging-, Markdown- und Label-Primitiven zentralisiert; die driftenden Varianten sind durch gemeinsame Implementierungen und Tests ersetzt.                                                                         |
| D9      | erledigt | `parseFormData` und `requireStaffPage` eingeführt; semantikgleiche direkte FormData-Parser sowie sämtliche geschützten Staff-Seiten migriert. Transformierende oder zusammengesetzte Parser bleiben bewusst explizit. Ein Strukturtest schützt den Page-Auth-Guardrail. |
| D10     | erledigt | Formatierer und Upload-Commit-Hook geteilt; Binder und Übergaben verwenden eine gemeinsame Status-Flow-Komponente.                                                                                                                                                      |
| S1–S6   | erledigt | Onboarding-Transaktion, PoA-Upload, n8n-Formular, GwG-Entscheidungs-/Vertreter-/Snapshot-Logik, Onboarding-Wizard und Identity-Review-State in isolierte Services, Komponenten und Reducer zerlegt.                                                                     |
| S7      | erledigt | Daten-Lader extrahiert und den Dokumentbereich als lokale, paginierte Server-Component mit eigener Suspense-Grenze umgesetzt. Weitere Sektionen können auf diesem Muster inkrementell folgen.                                                                           |

Neu hinzugekommene Datenbankindexe:

- `Request(tenantId, createdAt DESC)`
- `Document(clientId, deletedAt, createdAt DESC, id DESC)`

Die neuen gemeinsamen Primitiven und Strukturgrenzen sind durch fokussierte Unit-,
Integrations- und Guardrail-Tests abgesichert.
