import { BrandLockup } from './Header';

export function Footer() {
  return (
    <footer className="py-12">
      <div className="section-x flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <BrandLockup />
        <div className="text-sm text-muted-foreground">
          <p>
            <a
              className="underline underline-offset-4 hover:text-foreground"
              href="mailto:hello@sehatsaathi.in"
            >
              hello@sehatsaathi.in
            </a>
          </p>
          <p className="mt-1">Nashik, Maharashtra, India</p>
        </div>
      </div>
      <div className="section-x mt-8 border-t border-border pt-6 text-xs text-muted-foreground">
        <p>
          Sehat Saathi supports patient communication only. It does not provide medical advice and
          does not make clinical decisions.
        </p>
        <p className="mt-2">&copy; {new Date().getFullYear()} Wayne E Solutions.</p>
      </div>
    </footer>
  );
}
