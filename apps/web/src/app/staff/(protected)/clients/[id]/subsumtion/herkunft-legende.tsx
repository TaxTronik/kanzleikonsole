/** Erklärt die drei Vertrauensstufen einer Markierung (Herkunft). */
export function HerkunftLegende() {
  return (
    <div className="card px-4 py-3 text-xs text-secondary leading-relaxed">
      <span className="font-medium text-primary">Herkunft der Markierungen:</span>{' '}
      <span className="badge-green text-[10px]">wörtlich</span> steht so im Gesetz/Katalog
      (deterministisch) ·{' '}
      <span className="badge-yellow text-[10px]">Interpretation</span> vom LLM/Heuristik als
      definitionsbedürftig erkannt (zu prüfen) ·{' '}
      <span className="badge-purple text-[10px]">Berater</span> eigene Definition.{' '}
      <span className="italic text-muted">
        Das System wertet nicht — es kennzeichnet, woher ein Hinweis stammt.
      </span>
    </div>
  );
}
