'use client';

/** Eine gemeinsame Aufgabe kann mehrere Zuständige haben. */
export function StaffPicker({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ id: string; fullName: string }>;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="text-xs min-w-0">
      <legend className="text-muted">{label}</legend>
      <div className="mt-0.5 max-h-32 overflow-auto rounded border border-default bg-surface p-1.5 space-y-0.5">
        {options.map((staff) => (
          <label key={staff.id} className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={value.includes(staff.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...value, staff.id]
                    : value.filter((id) => id !== staff.id),
                )
              }
              className="rounded border-strong text-brand-600"
            />
            <span className="text-secondary">{staff.fullName}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
