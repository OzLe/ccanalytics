import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-[var(--space-2)] rounded-[var(--radius-md)] font-medium transition-colors duration-[var(--duration-normal)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]',
        secondary: 'bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border)] hover:bg-[var(--bg-hover)] hover:border-[var(--border-hover)]',
        ghost: 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        danger: 'bg-[var(--danger)] text-white hover:bg-[var(--danger)]/90',
      },
      size: {
        sm: 'h-[var(--space-8)] px-[var(--space-3)] text-[var(--font-caption-size)]',
        md: 'h-[var(--space-9)] px-[var(--space-4)] text-[var(--font-small-size)]',
        lg: 'h-[var(--space-10)] px-[var(--space-5)] text-[var(--font-body-size)]',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  }
);

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
