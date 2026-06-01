import { ShieldAlert } from 'lucide-react';

/** Pflicht-Framing: das System lenkt nur Aufmerksamkeit, der Berufsträger wertet. */
export function DisclaimerBanner() {
  return (
    <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-sm text-amber-900 dark:text-amber-100 flex gap-3">
      <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5 text-amber-600" />
      <p>
        <strong>Das System lenkt Aufmerksamkeit, es übernimmt keine Subsumtion.</strong>{' '}
        Markierungen sind Hinweise auf definitions- und subsumtionsbedürftige Stellen — keine
        Rechtsfolgenbestimmung. Die Bewertung schuldet der Berufsträger höchstpersönlich
        (§§ 33, 57 StBerG).
      </p>
    </div>
  );
}
