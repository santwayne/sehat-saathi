const scope = [
  {
    label: 'Channel',
    title: 'WhatsApp only, for now',
    body: 'We are deliberately starting on one channel patients already use daily. Automated voice calls, for patients who do not read comfortably, are planned for Phase 2.',
  },
  {
    label: 'Conditions',
    title: 'Two to three condition types',
    body: 'Diabetes, hypertension, and post-operative follow-up first — long-course, instruction-heavy care where timing matters and drift is common.',
  },
  {
    label: 'Verification',
    title: 'Every prescription verified by staff',
    body: 'Nothing is fully automated yet, by design. A human approves each extracted prescription before a patient is contacted.',
  },
];

const measures = [
  'Missed-dose catch rate — how often a skipped dose is detected and surfaced',
  'Follow-up appointment attendance compared with the clinic’s baseline',
  'Flags raised vs. flags resolved, and time to resolution',
  'Doctor- and staff-reported time saved per week',
];

export function Pilot() {
  return (
    <section id="pilot" className="border-b border-border bg-surface py-20 md:py-24">
      <div className="section-x">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-teal">
          What we&rsquo;re piloting first
        </p>
        <h2 className="mt-3 max-w-2xl text-3xl sm:text-4xl">
          An early-stage pilot, described honestly.
        </h2>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Sehat Saathi is not a finished product operating at scale. Below is exactly what is in
          scope today and what we intend to measure with our first partner clinics.
        </p>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {scope.map((s) => (
            <div key={s.title} className="rounded-xl border border-border bg-card p-6">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {s.label}
              </p>
              <h3 className="mt-3 text-lg text-card-foreground">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-8 grid gap-6 rounded-xl border border-border bg-card p-7 md:grid-cols-[1fr_1.2fr]">
          <div>
            <h3 className="text-xl text-card-foreground">
              What we&rsquo;re building toward proving
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              These are the measures we will report on with pilot partners. We have no results to
              publish yet, and we will not quote numbers we have not earned.
            </p>
            <p className="mt-4 inline-block rounded-md border border-dashed border-border bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground">
              Pilot results coming soon
            </p>
          </div>
          <ul className="space-y-3">
            {measures.map((m) => (
              <li
                key={m}
                className="flex gap-3 border-b border-border pb-3 text-sm leading-relaxed text-muted-foreground last:border-0 last:pb-0"
              >
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-teal" />
                {m}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
