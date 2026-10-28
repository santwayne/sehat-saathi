import { Link } from 'react-router-dom';

// The logo is used exactly as designed (icon above the wordmark). It is a flat
// image with a soft shadow on an off-white ground, so mix-blend-multiply lets
// it sit on the page background without a visible box.
export function BrandLockup({ className = '', logoClass = 'h-[4.5rem]' }: { className?: string; logoClass?: string }) {
  return (
    <div className={`flex flex-col items-start ${className}`}>
      <img src="/brand/logo-full.webp" alt="Sehat Saathi" className={`w-auto mix-blend-multiply ${logoClass}`} />
    </div>
  );
}

export function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
      <div className="section-x flex h-24 items-center justify-between">
        <BrandLockup logoClass="h-[5.25rem]" />
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
