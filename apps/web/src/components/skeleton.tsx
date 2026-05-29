// Wiederverwendbarer Skeleton-Platzhalter (Tailwind animate-pulse, Token-Farben).
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-gray-100 dark:bg-gray-800 ${className}`} />;
}
