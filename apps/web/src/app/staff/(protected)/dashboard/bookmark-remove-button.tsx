'use client';

import { useTransition } from 'react';
import { X } from 'lucide-react';
import { removeBookmarkAction } from './bookmark-actions';

export function BookmarkRemoveButton({ id }: { id: string }) {
  const [isPending, start] = useTransition();
  function remove(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    start(async () => {
      await removeBookmarkAction({ id });
    });
  }
  return (
    <button
      type="button"
      onClick={remove}
      disabled={isPending}
      className="text-gray-400 hover:text-red-700 dark:hover:text-red-300 p-1"
      title="Lesezeichen entfernen"
    >
      <X className="h-3 w-3" />
    </button>
  );
}
