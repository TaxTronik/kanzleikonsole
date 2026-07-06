// =============================================================================
// Quantenlos — beweisbar blinde Compliance-Stichprobe (Engine ≥ 1.3.1).
//
// Zwei Rahmen-Typen:
//  * `subsumtion` — RiskAnalysis-IDs eines Zeitraums (Risk-Review): je
//    Treffer entsteht eine Review-Aufgabe als ClientReminder.
//  * `audit` — Audit-Log-IDs eines Zeitraums (Betriebs-Nachschau): blinde
//    Nachschau-Probe über ALLE Chain-Ereignisse — der Review-Gegenstand ist
//    das protokollierte Handeln selbst (das OPEN-Zugriffsmodell stützt sich
//    auf die Chain als Kontrolle; die blinde Probe ist das Review-Glied
//    dazu). Keine automatischen Aufgaben: die Treffer werden direkt in der
//    Ergebnisliste geprüft.
// In beiden Fällen NUR opake IDs an die Engine — kein Falltext, kein
// Mandantendatum (§203). Der zurückkommende Nachweis (Commitment, Entropie-
// Provenienz, Ableitung) wird als Audit-Event in der Hash-Chain verankert —
// KEINE eigene Tabelle: die Chain ist bereits der manipulationsevidente Ort,
// und `after` trägt Nachweis + Rahmen für die spätere Re-Verifikation.
//
// Analysen ohne Mandantenbezug bekommen keine Wiedervorlage (ClientReminder
// verlangt clientId) → Hinweis im Ergebnis.
//
// `ibmToken`: der zentral in der Konsole verwaltete IBM-Quantum-Zugang
// (verschlüsselt in `quantenlos.ibm`, s. settings/quantenlos.ts) wird von der
// Action-Schicht gelesen und hier nur DURCHGEREICHT — bewusst als expliziter
// Parameter statt Settings-Import: die Fachlogik bleibt speicher-agnostisch.
//
// QPU-Queue („wartet"): job_id + Rahmen landen als TenantSetting
// (`quantenlos.pending`, ein Job pro Kanzlei) — Abholen manuell per Button
// (das Repo hat kein generisches Poll-Muster für Engine-Jobs; BullMQ wäre
// hier Overkill für einen Admin-seitigen, seltenen Vorgang).
//
// Reihenfolge wie in catalog-norms.ts: kurze Lese-Tx → Engine-Call AUSSERHALB
// jeder Tx → Erfolgs-Tx (Aufgaben + Audit atomar). Scheitert die Engine, wird
// nichts geschrieben.
// =============================================================================

import { z } from 'zod';
import { withTenantContext, type TenantContext, type TxClient } from '@taxtronik/db';
import {
  RiskLayerClient,
  LosNachweisSchema,
  type LosBackend,
  type LosNachweis,
} from '@taxtronik/risk-layer';
import { evidenceService } from '@/server/container';
import { ACTION_LABELS } from '@/server/audit/labels';
import { log } from '@/server/logger';

// P3-29c: Struktur-Validierung des JSONB-Settings statt roher Cast — ein
// beschädigter/veralteter Eintrag ergibt null statt eines TypeError später.
const PendingLosSchema = z
  .object({
    jobId: z.string(),
    backend: z.string(),
    commitment: z.string(),
    k: z.number(),
    rahmen: z.array(z.string()),
    rahmenTyp: z.string().optional(),
    zeitraum: z.object({}).passthrough(),
    beantragtAm: z.string(),
    beantragtVon: z.string().nullable(),
  })
  .passthrough();

/** Minimale Client-Verträge für DI/Tests. */
export type LosZiehClient = Pick<RiskLayerClient, 'losZiehen'>;
export type LosAbholClient = Pick<RiskLayerClient, 'losAbholen'>;
export type LosPruefClient = Pick<RiskLayerClient, 'losPruefen'>;

const PENDING_KEY = 'quantenlos.pending';
const REVIEW_DUE_DAYS = 14;
// Obergrenze für den Audit-Rahmen: die ID-Liste wandert als JSON zur Engine —
// jenseits davon den Zeitraum verkürzen statt Multi-Megabyte-Payloads bauen.
const MAX_AUDIT_RAHMEN = 50_000;

/** Worauf committet die Ziehung? */
export type LosRahmenTyp = 'subsumtion' | 'audit';

export interface LosZeitraum {
  /** YYYY-MM-DD (inklusive). */
  von: string;
  bis: string;
}

/** Wartender QPU-Job (TenantSetting `quantenlos.pending`). */
export interface PendingLos {
  jobId: string;
  backend: string;
  commitment: string;
  k: number;
  /** Der committete Rahmen — wird beim Abholen UNVERÄNDERT mitgesendet. */
  rahmen: string[];
  /** Fehlt bei Alt-Einträgen (vor Audit-Nachschau) ⇒ 'subsumtion'. */
  rahmenTyp?: LosRahmenTyp;
  zeitraum: LosZeitraum;
  beantragtAm: string;
  beantragtVon: string | null;
}

/** Stichproben-Eintrag (Rahmen-Typ `subsumtion`), mit Anzeige-Daten. */
export interface LosStichprobeEintrag {
  analysisId: string;
  titel: string | null;
  clientId: string | null;
  /** true = Analyse existiert nicht mehr (seit der Ziehung gelöscht). */
  geloescht: boolean;
}

/** Nachschau-Treffer (Rahmen-Typ `audit`), mit Anzeige-Daten aus der Chain. */
export interface LosNachschauEintrag {
  auditId: string;
  action: string;
  label: string;
  occurredAt: string | null;
  actorType: string | null;
  actorId: string | null;
  resourceType: string | null;
  /** Chain-Einträge sind unlöschbar — true wäre ein Befund für sich. */
  fehlt: boolean;
}

/** Abgeschlossene Ziehung — Anzeige-DTO aus dem Audit-Event. */
export interface LosZiehung {
  /** Audit-Log-ID des Nachweis-Events (Anker für „Nachweis prüfen"). */
  auditId: string;
  rahmenTyp: LosRahmenTyp;
  gezogenAm: string;
  zeitraum: LosZeitraum | null;
  backend: string;
  quelleKlasse: string;
  jobId: string | null;
  commitment: string;
  n: number;
  k: number;
  /** Befüllt bei Rahmen-Typ `subsumtion`, sonst leer. */
  stichprobe: LosStichprobeEintrag[];
  /** Befüllt bei Rahmen-Typ `audit`, sonst leer. */
  nachschau: LosNachschauEintrag[];
  rohCountsSha256: string | null;
  extraktor: string;
  drbg: string;
  /** z. B. Einträge ohne Mandantenbezug (keine Review-Aufgabe möglich). */
  hinweise: string[];
}

export type LosZiehungErgebnis =
  | { status: 'fertig'; ziehung: LosZiehung }
  | { status: 'wartet'; pending: PendingLos };

export class LosRahmenLeerError extends Error {
  constructor(typ: LosRahmenTyp = 'subsumtion') {
    super(
      typ === 'audit'
        ? 'Im gewählten Zeitraum gibt es keine Audit-Ereignisse — der Rahmen ist leer.'
        : 'Im gewählten Zeitraum gibt es keine Subsumtionen — der Rahmen ist leer.',
    );
    this.name = 'LosRahmenLeerError';
  }
}

export class LosNachweisInkonsistentError extends Error {
  constructor(detail: string) {
    super(`Der Engine-Nachweis ist inkonsistent: ${detail}`);
    this.name = 'LosNachweisInkonsistentError';
  }
}

/**
 * Baut den Rahmen, aufsteigend sortiert (deterministische Reihenfolge →
 * reproduzierbares Commitment):
 *  * `subsumtion` — RiskAnalysis-IDs des Zeitraums (createdAt).
 *  * `audit` — Audit-Log-IDs des Zeitraums (occurredAt), als Dezimal-Strings.
 *    ALLE Chain-Ereignisse, keine Ausnahmen — eine gefilterte Nachschau wäre
 *    wieder eine menschliche Vorauswahl.
 */
export async function buildLosRahmen(
  ctx: TenantContext,
  zeitraum: LosZeitraum,
  typ: LosRahmenTyp = 'subsumtion',
): Promise<string[]> {
  if (typ === 'audit') {
    const rows = await withTenantContext(ctx, (tx) =>
      tx.auditLog.findMany({
        where: { occurredAt: { gte: startOfDay(zeitraum.von), lte: endOfDay(zeitraum.bis) } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: MAX_AUDIT_RAHMEN + 1,
      }),
    );
    if (rows.length > MAX_AUDIT_RAHMEN) {
      throw new Error(
        `Der Audit-Rahmen übersteigt ${MAX_AUDIT_RAHMEN.toLocaleString('de-DE')} Ereignisse — bitte den Zeitraum verkürzen.`,
      );
    }
    return rows.map((r) => String(r.id));
  }
  const rows = await withTenantContext(ctx, (tx) =>
    tx.riskAnalysis.findMany({
      where: { createdAt: { gte: startOfDay(zeitraum.von), lte: endOfDay(zeitraum.bis) } },
      select: { id: true },
      orderBy: { id: 'asc' },
    }),
  );
  return rows.map((r) => r.id);
}

/**
 * Zieht eine blinde Review-Stichprobe: Rahmen bauen → Engine → Nachweis in die
 * Hash-Chain + je Treffer eine Review-Wiedervorlage. `wartet` (QPU-Queue) ⇒
 * job_id persistieren; Abholen via `holeLosAb`.
 */
export async function zieheLosStichprobe(
  ctx: TenantContext,
  input: {
    zeitraum: LosZeitraum;
    k: number;
    backend: LosBackend;
    rahmenTyp?: LosRahmenTyp;
    /** Zentral verwalteter IBM-Zugang (Action-Schicht liest, hier nur Durchreichung). */
    ibmToken?: string;
  },
  client?: LosZiehClient,
): Promise<LosZiehungErgebnis> {
  const rahmenTyp = input.rahmenTyp ?? 'subsumtion';
  const rahmen = await buildLosRahmen(ctx, input.zeitraum, rahmenTyp);
  if (rahmen.length === 0) throw new LosRahmenLeerError(rahmenTyp);
  if (input.k < 1 || input.k > rahmen.length) {
    throw new Error(`k muss zwischen 1 und ${rahmen.length} (Rahmengröße) liegen.`);
  }

  const c = client ?? new RiskLayerClient();
  const res = await c.losZiehen({
    rahmen,
    k: input.k,
    backend: input.backend,
    ...(input.ibmToken ? { ibmToken: input.ibmToken } : {}),
  });

  if (res.status === 'wartet') {
    const pending: PendingLos = {
      jobId: res.job_id,
      backend: res.backend,
      commitment: res.commitment,
      k: res.k,
      rahmen,
      rahmenTyp,
      zeitraum: input.zeitraum,
      beantragtAm: new Date().toISOString(),
      beantragtVon: ctx.actorId,
    };
    await withTenantContext(ctx, async (tx) => {
      await tx.tenantSetting.upsert({
        where: { tenantId_key: { tenantId: ctx.tenantId, key: PENDING_KEY } },
        create: { tenantId: ctx.tenantId, key: PENDING_KEY, value: pending as object, updatedBy: ctx.actorId ?? undefined },
        update: { value: pending as object, updatedBy: ctx.actorId ?? undefined },
      });
      // Auch die BEANTRAGUNG ist chain-verankert (wer hat wann mit welchem
      // Commitment gezogen) — der Nachweis folgt beim Abholen.
      await evidenceService.record(tx, {
        tenantId: ctx.tenantId,
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        action: 'risk.los.beantragt',
        resourceType: 'quantenlos',
        resourceId: res.commitment,
        after: { jobId: res.job_id, backend: res.backend, k: res.k, n: rahmen.length, zeitraum: input.zeitraum, rahmenTyp },
      });
    });
    return { status: 'wartet', pending };
  }

  const ziehung = await finalisiereZiehung(ctx, res.nachweis, rahmen, input.zeitraum, null, rahmenTyp);
  return { status: 'fertig', ziehung };
}

/** Liest den wartenden QPU-Job (oder null). */
export async function getPendingLos(ctx: TenantContext): Promise<PendingLos | null> {
  const row = await withTenantContext(ctx, (tx) =>
    tx.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: PENDING_KEY } },
    }),
  );
  if (!row) return null;
  const parsed = PendingLosSchema.safeParse(row.value);
  if (!parsed.success) {
    log.warn({ component: 'los', tenantId: ctx.tenantId }, 'getPendingLos: ungültiger pending-Eintrag verworfen');
    return null;
  }
  return parsed.data as unknown as PendingLos;
}

/**
 * Holt das Ergebnis des wartenden QPU-Jobs ab. Fertig ⇒ Nachweis verankern,
 * Review-Aufgaben anlegen, Pending löschen. Wartet weiter ⇒ unverändert.
 */
export async function holeLosAb(
  ctx: TenantContext,
  client?: LosAbholClient,
  opts: { ibmToken?: string } = {},
): Promise<LosZiehungErgebnis> {
  const pending = await getPendingLos(ctx);
  if (!pending) throw new Error('Kein wartender Quantenlos-Job vorhanden.');

  const c = client ?? new RiskLayerClient();
  const res = await c.losAbholen({
    jobId: pending.jobId,
    rahmen: pending.rahmen,
    k: pending.k,
    ...(opts.ibmToken ? { ibmToken: opts.ibmToken } : {}),
  });

  if (res.status === 'wartet') return { status: 'wartet', pending };

  const ziehung = await finalisiereZiehung(
    ctx, res.nachweis, pending.rahmen, pending.zeitraum, pending.jobId,
    pending.rahmenTyp ?? 'subsumtion',
  );
  return { status: 'fertig', ziehung };
}

/**
 * Gemeinsamer Erfolgs-Pfad: Plausibilität (Stichprobe ⊆ Rahmen, k/n) → EINE Tx:
 * Review-Wiedervorlagen + Audit-Event (Nachweis + Rahmen im `after`) + Pending-
 * Cleanup. Atomar — halbe Ziehungen (Aufgaben ohne Nachweis o. u.) gibt es nicht.
 */
async function finalisiereZiehung(
  ctx: TenantContext,
  nachweis: LosNachweis,
  rahmen: string[],
  zeitraum: LosZeitraum,
  pendingJobId: string | null,
  rahmenTyp: LosRahmenTyp,
): Promise<LosZiehung> {
  const rahmenSet = new Set(rahmen);
  const fremd = nachweis.stichprobe.filter((id) => !rahmenSet.has(id));
  if (fremd.length > 0) {
    throw new LosNachweisInkonsistentError(`Stichproben-Einträge außerhalb des Rahmens (${fremd.length}).`);
  }
  if (nachweis.rahmen.n !== rahmen.length) {
    throw new LosNachweisInkonsistentError(`n=${nachweis.rahmen.n} ≠ Rahmengröße ${rahmen.length}.`);
  }
  const staffId = ctx.actorId;
  if (!staffId) throw new Error('Quantenlos erfordert einen Staff-Kontext (actorId).');

  const hinweise: string[] = [];

  const { auditId, eintraege, nachschau } = await withTenantContext(ctx, async (tx) => {
    let eintraege: LosStichprobeEintrag[] = [];
    let nachschau: LosNachschauEintrag[] = [];
    const reminderIds: string[] = [];

    if (rahmenTyp === 'audit') {
      // Betriebs-Nachschau: Treffer sind Chain-Ereignisse — direkt in der
      // Ergebnisliste reviewen, keine automatischen Aufgaben (es gibt keinen
      // Mandanten-Anker, und der Review-Gegenstand ist das Protokoll selbst).
      nachschau = await ladeNachschauEintraege(tx, nachweis.stichprobe);
      hinweise.push(
        'Betriebs-Nachschau: die gezogenen Chain-Ereignisse direkt hier reviewen — es werden keine Wiedervorlagen angelegt.',
      );
    } else {
      const analysen = await tx.riskAnalysis.findMany({
        where: { id: { in: nachweis.stichprobe } },
        select: { id: true, clientId: true, title: true },
      });
      const byId = new Map(analysen.map((a) => [a.id, a]));

      eintraege = nachweis.stichprobe.map((id) => {
        const a = byId.get(id);
        return { analysisId: id, titel: a?.title ?? null, clientId: a?.clientId ?? null, geloescht: !a };
      });

      // Review-Aufgabe je Treffer — als ClientReminder (Repo-Muster für interne
      // Aufgaben). Ohne Mandantenbezug keine Wiedervorlage möglich → Hinweis.
      const due = new Date();
      due.setDate(due.getDate() + REVIEW_DUE_DAYS);
      for (const e of eintraege) {
        if (!e.clientId) {
          hinweise.push(
            e.geloescht
              ? `Analyse ${e.analysisId.slice(0, 8)}… existiert nicht mehr — keine Review-Aufgabe angelegt.`
              : `Analyse ${e.analysisId.slice(0, 8)}… hat keinen Mandantenbezug — keine Review-Aufgabe angelegt.`,
          );
          continue;
        }
        const r = await tx.clientReminder.create({
          data: {
            tenantId: ctx.tenantId,
            clientId: e.clientId,
            dueDate: due,
            subject: `Quantenlos-Review: ${e.titel ?? `Subsumtion ${e.analysisId.slice(0, 8)}…`}`.slice(0, 200),
            notes:
              `Blind gezogene Compliance-Stichprobe (Quantenlos, Commitment ${nachweis.rahmen.commitment.slice(0, 16)}…). ` +
              `Bitte fachlich reviewen: /staff/clients/${e.clientId}/subsumtion/${e.analysisId}`,
            createdByStaff: staffId,
            assigneeStaffId: staffId,
          },
          select: { id: true },
        });
        reminderIds.push(r.id);
      }
    }

    // Nachweis + Rahmen in die Hash-Chain. Der Rahmen (nur IDs) MUSS mit ins
    // `after`: ohne ihn ist der Nachweis später nicht re-verifizierbar
    // (das Commitment bindet an genau diese ID-Liste).
    const ev = await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      action: 'risk.los.gezogen',
      resourceType: 'quantenlos',
      resourceId: nachweis.rahmen.commitment,
      after: { nachweis, rahmen, zeitraum, rahmenTyp, reviewAufgaben: reminderIds },
    });

    if (pendingJobId) {
      await tx.tenantSetting.deleteMany({
        where: { tenantId: ctx.tenantId, key: PENDING_KEY },
      });
    }

    return { auditId: ev.id, eintraege, nachschau };
  });

  return toZiehung(String(auditId), rahmenTyp, nachweis, zeitraum, eintraege, nachschau, hinweise);
}

/** Letzte Ziehungen aus dem Audit-Log (action `risk.los.gezogen`). */
export async function listLosZiehungen(ctx: TenantContext, limit = 10): Promise<LosZiehung[]> {
  return withTenantContext(ctx, async (tx) => {
    const rows = await tx.auditLog.findMany({
      where: { action: 'risk.los.gezogen' },
      orderBy: { id: 'desc' },
      take: limit,
      select: { id: true, after: true },
    });

    const parsed = rows.flatMap((row) => {
      const after = row.after as {
        nachweis?: unknown; rahmen?: unknown; zeitraum?: unknown; rahmenTyp?: unknown;
      } | null;
      const nachweis = LosNachweisSchema.safeParse(after?.nachweis);
      if (!nachweis.success) return [];
      // Alt-Events (vor Audit-Nachschau) tragen kein rahmenTyp ⇒ 'subsumtion'.
      const rahmenTyp: LosRahmenTyp = after?.rahmenTyp === 'audit' ? 'audit' : 'subsumtion';
      return [{
        id: row.id,
        nachweis: nachweis.data,
        zeitraum: (after?.zeitraum ?? null) as LosZeitraum | null,
        rahmenTyp,
      }];
    });

    const analyseIds = [...new Set(
      parsed.filter((p) => p.rahmenTyp === 'subsumtion').flatMap((p) => p.nachweis.stichprobe),
    )];
    const analysen = analyseIds.length
      ? await tx.riskAnalysis.findMany({
          where: { id: { in: analyseIds } },
          select: { id: true, clientId: true, title: true },
        })
      : [];
    const byId = new Map(analysen.map((a) => [a.id, a]));

    const ziehungen: LosZiehung[] = [];
    for (const p of parsed) {
      if (p.rahmenTyp === 'audit') {
        const nachschau = await ladeNachschauEintraege(tx, p.nachweis.stichprobe);
        ziehungen.push(toZiehung(String(p.id), 'audit', p.nachweis, p.zeitraum, [], nachschau, []));
        continue;
      }
      const eintraege: LosStichprobeEintrag[] = p.nachweis.stichprobe.map((id) => {
        const a = byId.get(id);
        return { analysisId: id, titel: a?.title ?? null, clientId: a?.clientId ?? null, geloescht: !a };
      });
      ziehungen.push(toZiehung(String(p.id), 'subsumtion', p.nachweis, p.zeitraum, eintraege, [], []));
    }
    return ziehungen;
  });
}

export interface LosPruefErgebnis {
  gueltig: boolean;
  geprueft: string[];
  hinweise: string[];
}

/**
 * Verifiziert den Nachweis eines Audit-Events erneut gegen die Engine
 * (`/v1/los/pruefen`). Nachweis UND Rahmen kommen aus der Hash-Chain — geprüft
 * wird also exakt das, was damals verankert wurde.
 */
export async function pruefeLosNachweis(
  ctx: TenantContext,
  auditId: string,
  opts: { online?: boolean; ibmToken?: string } = {},
  client?: LosPruefClient,
): Promise<LosPruefErgebnis> {
  const row = await withTenantContext(ctx, (tx) =>
    tx.auditLog.findFirst({
      where: { id: BigInt(auditId), action: 'risk.los.gezogen' },
      select: { after: true },
    }),
  );
  if (!row) throw new Error('Ziehung nicht gefunden.');

  const after = row.after as { nachweis?: unknown; rahmen?: unknown } | null;
  const nachweis = LosNachweisSchema.parse(after?.nachweis);
  const rahmen = (after?.rahmen ?? []) as string[];

  const c = client ?? new RiskLayerClient();
  const res = await c.losPruefen({
    nachweis,
    rahmen,
    online: opts.online,
    ...(opts.ibmToken ? { ibmToken: opts.ibmToken } : {}),
  });
  return { gueltig: res.gueltig, geprueft: res.geprueft, hinweise: res.hinweise };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Anzeige-Daten der Nachschau-Treffer aus der Chain (Rahmen-Typ `audit`). */
async function ladeNachschauEintraege(
  tx: TxClient,
  stichprobe: string[],
): Promise<LosNachschauEintrag[]> {
  const ids = stichprobe.filter((s) => /^\d+$/.test(s));
  const rows = ids.length
    ? await tx.auditLog.findMany({
        where: { id: { in: ids.map((s) => BigInt(s)) } },
        select: {
          id: true, action: true, occurredAt: true,
          actorType: true, actorId: true, resourceType: true,
        },
      })
    : [];
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  return stichprobe.map((s) => {
    const r = byId.get(s);
    return {
      auditId: s,
      action: r?.action ?? '',
      label: r ? (ACTION_LABELS[r.action] ?? r.action) : '',
      occurredAt: r ? r.occurredAt.toISOString() : null,
      actorType: r?.actorType ?? null,
      actorId: r?.actorId ?? null,
      resourceType: r?.resourceType ?? null,
      fehlt: !r,
    };
  });
}

function toZiehung(
  auditId: string,
  rahmenTyp: LosRahmenTyp,
  nachweis: LosNachweis,
  zeitraum: LosZeitraum | null,
  stichprobe: LosStichprobeEintrag[],
  nachschau: LosNachschauEintrag[],
  hinweise: string[],
): LosZiehung {
  return {
    auditId,
    rahmenTyp,
    gezogenAm: nachweis.gezogen_am,
    zeitraum,
    backend: nachweis.entropie.backend,
    quelleKlasse: nachweis.entropie.quelle_klasse,
    jobId: nachweis.entropie.job_id ?? null,
    commitment: nachweis.rahmen.commitment,
    n: nachweis.rahmen.n,
    k: nachweis.k,
    stichprobe,
    nachschau,
    rohCountsSha256: nachweis.entropie.roh_counts_sha256 ?? null,
    extraktor: nachweis.ableitung.extraktor,
    drbg: nachweis.ableitung.drbg,
    hinweise,
  };
}

function startOfDay(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

function endOfDay(ymd: string): Date {
  return new Date(`${ymd}T23:59:59.999Z`);
}
