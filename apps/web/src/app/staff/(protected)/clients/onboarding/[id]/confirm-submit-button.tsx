'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function ConfirmSubmitButton({
  children,
  message,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; message: string }) {
  return (
    <button
      {...props}
      type="submit"
      onClick={(event) => {
        if (!window.confirm(message)) event.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
