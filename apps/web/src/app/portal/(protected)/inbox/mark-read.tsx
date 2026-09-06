'use client';

import { useEffect } from 'react';
import { markInboxThreadReadAction } from './actions';

export function MarkInboxThreadRead({ threadId }: { threadId: string }) {
  useEffect(() => {
    const form = new FormData();
    form.set('id', threadId);
    void markInboxThreadReadAction(form);
  }, [threadId]);
  return null;
}
