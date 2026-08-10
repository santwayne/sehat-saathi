import { Activity } from 'lucide-react';
import { Link } from 'react-router-dom';

export function BrandLockup({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <Activity className="size-5" aria-hidden />
      </span>
      <div className="leading-tight">
        <p className="font-display text-lg text-foreground">Sehat Saathi</p>
        <p className="text-[11px] text-muted-foreground">by Wayne E Solutions</p>
      </div>
    </div>
  );
}

export function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
      <div className="section-x flex h-16 items-center justify-between">
        <BrandLockup />
        <nav className="hidden items-center gap-7 text-sm text-muted-foreground md:flex">
          <a className="hover:text-foreground" href="#how-it-works">
            How it works
          </a>
          <a className="hover:text-foreground" href="#safety">
            Safety
          </a>
          <a className="hover:text-foreground" href="#pilot">
            Pilot scope
          </a>
        </nav>
        <div className="flex items-center gap-3">
          <a
            href="#contact"
            className="rounded-md border border-border px-3.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
          >
            Request a Pilot
          </a>
          <Link
            to="/login"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Staff login →
          </Link>
        </div>
      </div>
    </header>
  );
}
