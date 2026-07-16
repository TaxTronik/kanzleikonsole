'use client';

import { useOptimistic, useTransition, type MouseEvent } from 'react';
import { Bookmark, BookmarkCheck } from 'lucide-react';
import { toggleBookmarkAction } from './bookmark-actions';

export function BookmarkButton({
  resourceType,
  resourceId,
  label,
  href,
  initiallyBookmarked,
}: {
  resourceType: string;
  resourceId: string;
  label: string;
  href: string | null;
  initiallyBookmarked: boolean;
}) {
  const [bookmarked, setOptimisticBookmarked] = useOptimistic(
    initiallyBookmarked,
    (_current, next: boolean) => next,
  );
  const [isPending, start] = useTransition();

  function toggle(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const next = !bookmarked;
    start(async () => {
      // Bei einem Fehler faellt der optimistische Wert auf den Server-Prop
      // zurueck. Bei Erfolg liefert revalidatePath den aktualisierten Prop.
      setOptimisticBookmarked(next);
      await toggleBookmarkAction({ resourceType, resourceId, label, href });
    });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={isPending}
      className={
        'p-1 rounded transition-colors shrink-0 ' +
        (bookmarked ? 'text-amber-500 hover:text-amber-600' : 'text-gray-300 hover:text-amber-500')
      }
      title={bookmarked ? 'Lesezeichen entfernen' : 'Merken'}
      aria-label={bookmarked ? 'Lesezeichen entfernen' : 'Merken'}
    >
      {bookmarked ? (
        <BookmarkCheck className="h-3.5 w-3.5" />
      ) : (
        <Bookmark className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
