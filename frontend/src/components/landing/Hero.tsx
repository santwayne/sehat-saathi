import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

function Bubble({ side, children }: { side: 'in' | 'out'; children: React.ReactNode }) {
  return (
    <div className={side === 'in' ? 'flex justify-start' : 'flex justify-end'}>
      <div
        className={[
          'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed shadow-sm',
          side === 'in'
            ? 'rounded-bl-sm bg-card text-card-foreground'
            : 'rounded-br-sm bg-whatsapp text-foreground',
        ].join(' ')}
      >
        {children}
      </div>
    </div>
  );
}

export function Hero() {
  return (
    <section className="bg-calm border-b border-border">
      <div className="section-x grid gap-14 py-20 md:py-28 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium tracking-wide text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-teal" />
            Early-stage pilot · WhatsApp-based patient follow-up
          </div>

          <h1 className="mt-6 text-4xl leading-[1.1] text-foreground sm:text-5xl lg:text-[3.4rem]">
            Your patients&rsquo; prescriptions, explained in their own language &mdash;
            automatically.
          </h1>

          <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Sehat Saathi turns the prescription your doctor already writes into plain-language
            WhatsApp check-ins and answers in Hindi, Punjabi, or English. It only handles what is
            literally on the prescription &mdash; anything else is escalated to your staff.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <a href="#contact">Request a Pilot</a>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href="#how-it-works">See how it works</a>
            </Button>
          </div>

          <p className="mt-6 text-xs text-muted-foreground">
            Every prescription is reviewed and approved by a staff member before a patient receives
            anything.
          </p>
        </div>

        <div className="flex justify-center">
          <div className="w-full max-w-[19rem] rounded-[2.25rem] border border-border bg-surface-deep p-2.5 shadow-soft">
            <div className="rounded-[1.85rem] bg-secondary">
              <div className="flex items-center gap-2.5 rounded-t-[1.85rem] bg-primary px-4 py-3 text-primary-foreground">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-foreground/15 text-xs font-semibold">
                  SS
                </div>
                <div className="leading-tight">
                  <p className="text-sm font-medium">Sehat Saathi</p>
                  <p className="text-[10px] opacity-75">Sample conversation (illustrative)</p>
                </div>
              </div>

              <div className="space-y-2.5 px-3 py-4">
                <Bubble side="in">
                  नमस्ते शर्मा जी 🙏 आज सुबह की दवा — Metformin 500mg — ले ली?
                </Bubble>
                <Bubble side="out">haan le li</Bubble>
                <Bubble side="out">khana khane se pehle ya baad mein?</Bubble>
                <Bubble side="in">
                  आपकी पर्ची के अनुसार: Metformin 500mg &mdash; खाने के{' '}
                  <strong>बाद</strong>, दिन में दो बार।
                  <span className="mt-1.5 block text-[11px] text-muted-foreground">
                    As written on your prescription: after food, twice daily.
                  </span>
                </Bubble>
                <Bubble side="out">chakkar aa rahe hain thoda</Bubble>
                <Bubble side="in">
                  यह मैं डॉक्टर तक पहुँचा रही हूँ। क्लिनिक से आपको संपर्क किया जाएगा।
                  <span className="mt-1.5 block rounded-md bg-accent px-2 py-1 text-[11px] text-accent-foreground">
                    Flagged to clinic dashboard &mdash; new symptom reported
                  </span>
                </Bubble>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
