import type { ReactNode } from 'react';
export function SectionCard({
  title,
  description,
  bare = false,
  children,
}: {
  title: string;
  description?: string;
  /** Ohne Kartenrahmen: für Inhalte, die selbst aus Karten bestehen (z. B. die
   *  n8n-Stufen) — sonst entsteht Karte in Karte. */
  bare?: boolean;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-primary">{title}</h2>
        {description && <p className="text-xs text-muted mt-1">{description}</p>}
      </div>
      {bare ? children : <div className="card p-6">{children}</div>}
    </section>
  );
}
