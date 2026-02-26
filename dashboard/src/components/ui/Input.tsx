import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
import { forwardRef, type InputHTMLAttributes } from 'react';

const inputVariants = cva(
  'w-full rounded-[var(--radius-md)] border bg-[var(--bg-elevated)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]',
  {
    variants: {
      variant: {
        default: 'border-[var(--border)] hover:border-[var(--border-hover)]',
        error: 'border-[var(--danger)] focus-visible:ring-[var(--danger)]',
      },
      size: {
        sm: 'h-8 px-[var(--space-2)] text-[var(--font-small-size)]',
        md: 'h-10 px-[var(--space-3)] text-sm',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  }
);

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>, VariantProps<typeof inputVariants> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, variant, size, ...props }, ref) => (
    <input ref={ref} className={cn(inputVariants({ variant, size }), className)} {...props} />
  )
);
Input.displayName = 'Input';
