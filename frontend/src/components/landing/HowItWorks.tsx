import { PenLine, ScanLine, MessageSquareText, BellRing, Siren } from 'lucide-react';

const steps = [
  {
    icon: PenLine,
    title: 'The doctor writes the prescription as usual',
    body: 'No new device, no new software, no change to how a consultation runs. Paper pad or existing EMR — both work.',
  },
  {
    icon: ScanLine,
    title: 'Staff photograph it; AI reads it into structured data',
    body: 'Medicines, dosage, timing, and follow-up date are extracted automatically. A staff member then checks and approves the result before anything moves forward.',
  },
  {
    icon: MessageSquareText,
    title: 'The patient gets a plain-language explanation on WhatsApp',
    body: 'In Hindi, Punjabi, or English — whichever the patient chose. Same content as the prescription, in words they actually use.',
  },
  {
    icon: BellRing,
    title: 'Scheduled check-ins, and answers to small questions',
    body: 'On the schedule the doctor set, the patient is asked whether they took their medicine. Questions like “before or after food?” are answered instantly, sourced only from their own prescription.',
  },
  {
    icon: Siren,
    title: 'Anything else goes to a human, immediately',
    body: 'A new symptom, a dose missed twice, or a question the AI cannot answer safely is flagged to the clinic dashboard and routed to the right doctor.',
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="border-b border-border bg-surface py-20 md:py-24">
      <div className="section-x">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-teal">How it works</p>
        <h2 className="mt-3 max-w-2xl text-3xl sm:text-4xl">
          Five steps, one of which is always a person.
        </h2>

        <ol className="mt-12 space-y-4">
          {steps.map((step, i) => (
            <li
              key={step.title}
              className="grid gap-4 rounded-xl border border-border bg-card p-6 sm:grid-cols-[auto_auto_1fr] sm:items-start sm:gap-6"
            >
              <span className="font-display text-2xl tabular-nums text-muted-foreground/70">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                <step.icon className="h-5 w-5" strokeWidth={1.75} />
              </span>
              <div>
                <h3 className="text-lg text-card-foreground">{step.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
