// =============================================================================
// Anzeige-Bausteine der Feststellungen (TCMS Stufe 3, Bereich C; portiert aus
// der Demo components/feststellungen/badges.tsx und server/feststellungen-
// daten.ts). Labels aus @taxtronik/tcms-domain; die vier §-153-Optionen in
// fester, gleichrangiger Reihenfolge ohne Empfehlung.
// =============================================================================

import { Check } from 'lucide-react';
import {
  FESTSTELLUNG_SCHRITTE,
  FESTSTELLUNG_STATUS_LABEL,
  P153_LABEL,
  type FeststellungStatus,
  type Paragraph153Entscheidung,
} from '@taxtronik/tcms-domain';
import { isoDatumKurzText, isoDatumText } from '@/components/tcms/format';
import { badgeKlasse } from '@/components/tcms/ton';

export const FESTSTELLUNG_STATUS_BADGE: Readonly<Record<FeststellungStatus, string>> = {
  ERFASST: 'badge-gray',
  IN_WUERDIGUNG: 'badge-brand',
  MASSNAHMEN_OFFEN: 'badge-yellow',
  NACHKONTROLLE: 'badge-purple',
  GESCHLOSSEN: 'badge-green',
  VERWORFEN: 'badge-gray',
};

/** Erläuterung je §-153-Option (gleichrangig, ohne Empfehlung). */
export const P153_ERLAEUTERUNG: Readonly<Record<Paragraph153Entscheidung, string>> = {
  BERICHTIGUNG:
    'Die erforderliche Berichtigung wird veranlasst; Frist und Umfang werden dokumentiert.',
  KEINE_PFLICHT:
    'Die Feststellung führt zu keiner Berichtigungspflicht; die Begründung ist Pflicht.',
  WEITERE_KLAERUNG:
    'Die Würdigung ist noch nicht abschließend möglich; Klärung bis zum angegebenen Datum.',
  UEBERGABE: 'Der Einzelfall wird zur Entscheidung an spezialisierte Beratung übergeben.',
};

/** Feste Reihenfolge der vier Optionen (keine Sortierung nach Häufigkeit). */
export const P153_OPTIONEN: readonly Paragraph153Entscheidung[] = [
  'BERICHTIGUNG',
  'KEINE_PFLICHT',
  'WEITERE_KLAERUNG',
  'UEBERGABE',
];

/** Überschrift einer Option im §-153-Block (wie die Demo). */
export function p153OptionTitel(o: Paragraph153Entscheidung): string {
  if (o === 'KEINE_PFLICHT') return 'Keine Berichtigungspflicht (Begründung erforderlich)';
  if (o === 'WEITERE_KLAERUNG') return 'Weitere Klärung nötig bis [Datum]';
  return P153_LABEL[o];
}

/** Label ohne „bis …“ (Ergebnisanzeige). */
export function p153Label(o: Paragraph153Entscheidung): string {
  return P153_LABEL[o].replace(' bis …', '');
}

/**
 * Anzeige-Vorschau: abschließende §-153-Entscheidung (alles außer „weitere
 * Klärung“). Ob weitergeschaltet werden darf, entscheidet der Dienst.
 */
export function p153Abschliessend(e: string | null | undefined): boolean {
  return e != null && e !== 'WEITERE_KLAERUNG';
}

/** Kontrollcode aus einem Quelltext wie „K-EC-05 September 2026“. */
export function kontrollCode(text: string): string | null {
  return /K-EC-\d{2}/.exec(text)?.[0] ?? null;
}

export function FeststellungStatusBadge({ status }: { status: FeststellungStatus }) {
  return (
    <span className={badgeKlasse(FESTSTELLUNG_STATUS_BADGE[status])}>
      {FESTSTELLUNG_STATUS_LABEL[status]}
    </span>
  );
}

/** §-153-Status: offen rot, entschieden grün (mit Datum), ohne Pfad „—“. */
export function P153Badge({
  erforderlich,
  entscheidung,
  am,
  frist,
}: {
  erforderlich: boolean;
  entscheidung: Paragraph153Entscheidung | null;
  am: string | null;
  frist: string | null;
}) {
  if (entscheidung && am) {
    const text =
      entscheidung === 'WEITERE_KLAERUNG' && frist
        ? `Entschieden: weitere Klärung bis ${isoDatumKurzText(frist)}`
        : `Entschieden ${isoDatumText(am)}`;
    return (
      <span
        className="badge-green whitespace-normal"
        title={`${p153Label(entscheidung)} · ${isoDatumText(am)}`}
      >
        {text}
      </span>
    );
  }
  if (erforderlich) return <span className="badge-red">Würdigung offen</span>;
  return <span className="text-sm text-muted">—</span>;
}

/** Status-Schritte einer Feststellung (Klassen .stepper/.step der kanzleikonsole). */
export function FeststellungStepper({
  status,
  unterzeilen,
}: {
  status: FeststellungStatus;
  unterzeilen: Readonly<Partial<Record<FeststellungStatus, string>>>;
}) {
  const index = status === 'VERWORFEN' ? -1 : FESTSTELLUNG_SCHRITTE.indexOf(status);
  const fertig = status === 'GESCHLOSSEN';
  return (
    <div className="overflow-x-auto">
      <ol className="stepper min-w-[44rem]" aria-label="Status der Feststellung">
        {FESTSTELLUNG_SCHRITTE.map((s, i) => {
          const zustand = fertig || i < index ? 'done' : i === index ? 'active' : '';
          const sichtbar = fertig || i <= index || s === 'MASSNAHMEN_OFFEN';
          return (
            <li
              key={s}
              className={`step ${zustand}`}
              aria-current={i === index && !fertig ? 'step' : undefined}
            >
              <span className="step-dot">
                {zustand === 'done' ? <Check className="h-4 w-4" aria-hidden="true" /> : i + 1}
              </span>
              <span className="step-txt">
                <span className="step-title">
                  {i + 1} {FESTSTELLUNG_STATUS_LABEL[s]}
                </span>
                <span className="step-sub" title={unterzeilen[s]}>
                  {sichtbar ? (unterzeilen[s] ?? '—') : '—'}
                </span>
              </span>
              {i < FESTSTELLUNG_SCHRITTE.length - 1 ? (
                <span className="step-line" aria-hidden="true" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
