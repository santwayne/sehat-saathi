import { Ban, FileWarning, UserCheck, ScrollText, PowerOff, Lock } from 'lucide-react';

const guardrails = [
  {
    icon: Ban,
    title: 'Never suggests starting, stopping, or changing a dose',
    body: 'Enforced in code as a hard limit — not left to a prompt instruction.',
  },
  {
    icon: FileWarning,
    title: 'Never invents a dosage or instruction',
    body: 'If handwriting is unclear, it is flagged for a human. It is never guessed.',
  },
  {
    icon: UserCheck,
    title: 'Staff approve every single prescription',
    body: 'A person reviews and signs off before any message reaches a patient.',
  },
  {
    icon: ScrollText,
    title: 'Every AI-generated message is logged',
    body: 'A complete, reviewable audit trail of what was sent, to whom, and when.',
  },
  {
    icon: PowerOff,
    title: 'Instant kill switch',
    body: 'Stop all automated messages for one patient or the entire clinic, immediately.',
  },
  {
    icon: Lock,
    title: 'Consent-first, DPDP-aligned',
    body: "Built around explicit patient consent and India’s DPDP Act data protection requirements.",
  },
];

export function Safety() {
  return (
    <section
      id="safety"
      className="border-y border-border bg-surface-deep py-20 text-primary-foreground md:py-28"
    >
      <div className="section-x">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary-foreground/60">
          Safety &amp; trust
        </p>
        <h2 className="mt-3 max-w-3xl text-3xl text-primary-foreground sm:text-4xl">
          Built with hard limits, not just good intentions.
        </h2>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-primary-foreground/70">
          These constraints are the product. They are enforced at the system level so that no
          configuration, phrasing, or patient question can move past them.
        </p>

        <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-primary-foreground/15 bg-primary-foreground/15 sm:grid-cols-2 lg:grid-cols-3">
          {guardrails.map((g) => (
            <div key={g.title} className="bg-surface-deep p-6">
              <g.icon className="h-5 w-5 text-primary-foreground/80" strokeWidth={1.75} />
              <h3 className="mt-4 text-base text-primary-foreground">{g.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-primary-foreground/65">{g.body}</p>
            </div>
          ))}
        </div>

        <p className="mt-10 max-w-2xl border-l-2 border-primary-foreground/40 pl-5 font-display text-lg leading-relaxed text-primary-foreground/90">
          The AI answers questions. It never makes clinical decisions. Every clinical decision still
          comes from your doctors.
        </p>
      </div>
    </section>
  );
}
