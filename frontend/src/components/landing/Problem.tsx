import { Clock, PhoneOff, Languages, EyeOff } from 'lucide-react';

const items = [
  {
    icon: Languages,
    title: 'Instructions written for clinicians, read by patients',
    body: "Prescriptions are written in English and medical shorthand. A patient at home is left guessing at timing, dosage, and what “BD after food” actually means.",
  },
  {
    icon: Clock,
    title: 'Follow-up calls cost staff time nobody has',
    body: 'Calling every patient a few days after a visit is the right thing to do. In a busy OPD, it is usually the first thing dropped.',
  },
  {
    icon: EyeOff,
    title: 'Missed doses and worsening symptoms go unseen',
    body: 'Between visits, a clinic has no visibility. A patient who stopped their medication or developed a new symptom often surfaces only at the next appointment — if they come.',
  },
  {
    icon: PhoneOff,
    title: 'Language makes follow-up inconsistent',
    body: 'Whether a patient understands their care can depend on which staff member happens to call and which language they share.',
  },
];

export function Problem() {
  return (
    <section id="problem" className="border-b border-border py-20 md:py-24">
      <div className="section-x">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-teal">The problem</p>
        <h2 className="mt-3 max-w-2xl text-3xl sm:text-4xl">
          The gap is not the consultation. It is everything after it.
        </h2>

        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {items.map((item) => (
            <div key={item.title} className="rounded-xl border border-border bg-card p-6">
              <item.icon className="h-5 w-5 text-primary" strokeWidth={1.75} />
              <h3 className="mt-4 text-lg text-card-foreground">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
