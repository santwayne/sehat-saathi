import { Stethoscope, Building2 } from 'lucide-react';

export function WhoItsFor() {
  return (
    <section id="who" className="border-b border-border py-20 md:py-24">
      <div className="section-x">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-teal">
          Who it&rsquo;s for
        </p>
        <h2 className="mt-3 max-w-2xl text-3xl sm:text-4xl">
          Fits a single consulting room or a full department.
        </h2>

        <div className="mt-12 grid gap-6 md:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-7">
            <Stethoscope className="h-5 w-5 text-primary" strokeWidth={1.75} />
            <h3 className="mt-4 text-xl text-card-foreground">Single-doctor clinics</h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Everything stays simple. All patient replies, check-in results, and flags route to you
              in one list, in the order they arrived. Your front desk approves prescriptions; you see
              only what needs a doctor.
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card p-7">
            <Building2 className="h-5 w-5 text-clinical" strokeWidth={1.75} />
            <h3 className="mt-4 text-xl text-card-foreground">
              Multi-doctor clinics &amp; hospitals
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Flags route automatically to each patient&rsquo;s own assigned doctor, so nothing lands
              in a shared inbox nobody owns. A coordinator fallback queue picks up anything
              unacknowledged, so no flag sits unresolved.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
