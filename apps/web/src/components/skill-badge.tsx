// Generisches Skill-Badge mit Tailwind-Color-Tönung. `color` ist ein
// kurzer Tailwind-Color-Suffix wie 'blue', 'amber', 'emerald'. Wenn null
// oder unbekannt → neutrales gray-Badge.

const TONE_MAP: Record<string, string> = {
  blue:    'bg-blue-100 text-blue-800',
  amber:   'bg-amber-100 text-amber-800',
  emerald: 'bg-emerald-100 text-emerald-800',
  purple:  'bg-purple-100 text-purple-800',
  pink:    'bg-pink-100 text-pink-800',
  red:     'bg-red-100 text-red-800',
  yellow:  'bg-yellow-100 text-yellow-800',
  gray:    'bg-gray-100 text-gray-800',
};

export function SkillBadge({ label, color }: { label: string; color: string | null | undefined }) {
  const tone = (color && TONE_MAP[color]) ?? TONE_MAP['gray']!;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>
      {label}
    </span>
  );
}
