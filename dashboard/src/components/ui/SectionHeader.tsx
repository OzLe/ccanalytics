import { cn } from '../../lib/utils';

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
}

export function SectionHeader({ title, subtitle, action, className }: SectionHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between', className)}>
      <div className="flex flex-col gap-[var(--space-1)]">
        <h2 className="text-h2">{title}</h2>
        {subtitle && <p className="text-small text-[var(--text-secondary)]">{subtitle}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
