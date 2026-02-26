import { cn } from '../../lib/utils';
import { useState, useRef, useCallback, useId, type ReactNode } from 'react';

type Position = 'top' | 'bottom' | 'left' | 'right';

const positionClasses: Record<Position, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2',
};

interface TooltipProps {
  content: string;
  children: ReactNode;
  position?: Position;
  delay?: number;
  className?: string;
}

export function Tooltip({ content, children, position = 'top', delay = 150, className }: TooltipProps) {
  const [show, setShow] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tooltipId = useId();

  const open = useCallback(() => {
    timerRef.current = setTimeout(() => setShow(true), delay);
  }, [delay]);

  const close = useCallback(() => {
    clearTimeout(timerRef.current);
    setShow(false);
  }, []);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
      aria-describedby={show ? tooltipId : undefined}
    >
      {children}
      {show && (
        <span
          id={tooltipId}
          role="tooltip"
          className={cn(
            'absolute px-[var(--space-2)] py-[var(--space-1)] rounded-[var(--radius-sm)] bg-[var(--bg-overlay)] text-[var(--text-primary)] text-xs whitespace-nowrap z-[var(--z-modal)] animate-fade-in pointer-events-none',
            positionClasses[position],
            className
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
