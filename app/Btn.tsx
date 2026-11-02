'use client';

import type { ButtonHTMLAttributes } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  busy?: boolean;
}

/** Кнопка с индикатором загрузки: пока действие выполняется, показывает крутилку и не даёт нажать снова. */
export default function Btn({ busy = false, className = '', disabled, children, ...rest }: Props) {
  return (
    <button {...rest} className={`btn ${className}${busy ? ' is-busy' : ''}`} disabled={disabled || busy} aria-busy={busy}>
      {busy && <span className='spin' aria-hidden='true' />}
      {children}
    </button>
  );
}
