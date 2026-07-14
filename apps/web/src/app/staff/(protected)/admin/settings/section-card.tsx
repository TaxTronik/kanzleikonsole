import type { ReactNode } from 'react';
export function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-primary">{title}</h2>
        {description && <p className="text-xs text-muted mt-1">{description}</p>}
      </div>
      <div className="card p-6">{children}</div>
    </section>
  );
}
