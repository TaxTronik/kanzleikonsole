'use client';

import { useState, useTransition, useEffect, type MouseEvent } from 'react';
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
  const [bookmarked, setBookmarked] = useState(initiallyBookmarked);
  const [isPending, start] = useTransition();

  // Wenn der Server nach revalidatePath einen neuen Wert liefert
  // (z. B. weil das Lesezeichen im „Gemerkt"-Widget entfernt wurde),
  // lokalen State synchronisieren — sonst zeigt das Icon einen veralteten
  // Stand.
  useEffect(() => {
    setBookmarked(initiallyBookmarked);
  }, [initiallyBookmarked]);

  function toggle(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const next = !bookmarked;
    setBookmarked(next);
    start(async () => {
      const r = await toggleBookmarkAction({ resourceType, resourceId, label, href });
      if (!r.ok) setBookmarked(!next);
      else if (typeof r.bookmarked === 'boolean') setBookmarked(r.bookmarked);
    });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={isPending}
      className={
        'p-1 rounded transition-colors shrink-0 ' +
        (bookmarked
          ? 'text-amber-500 hover:text-amber-600'
          : 'text-gray-300 hover:text-amber-500')
      }
      title={bookmarked ? 'Lesezeichen entfernen' : 'Merken'}
      aria-label={bookmarked ? 'Lesezeichen entfernen' : 'Merken'}
    >
      {bookmarked ? <BookmarkCheck className="h-3.5 w-3.5" /> : <Bookmark className="h-3.5 w-3.5" />}
    </button>
  );
}
