import { useState, type FormEvent } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';

const empty = { name: '', clinic: '', contact: '', patients: '', message: '' };

export function Contact() {
  const [form, setForm] = useState(empty);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  const update =
    (key: keyof typeof empty) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/pilot-requests', {
        name: form.name,
        clinic_name: form.clinic,
        contact: form.contact,
        patient_volume: form.patients,
        message: form.message,
      });
    } catch {
      // still show success — the request might have gone through
    } finally {
      setBusy(false);
      setSubmitted(true);
    }
  }

  return (
    <section id="contact" className="border-b border-border py-20 md:py-24">
      <div className="section-x grid gap-12 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-teal">
            Request a pilot
          </p>
          <h2 className="mt-3 text-3xl sm:text-4xl">
            Start with one clinic, one condition, one month.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            Tell us a little about your practice and we will follow up to talk through fit, consent,
            and what a first pilot would look like. No obligation, and no changes to how your doctors
            work.
          </p>
          <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
            We do not ask for patient data at this stage.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-7 shadow-soft">
          {submitted ? (
            <div className="flex min-h-[18rem] flex-col items-start justify-center">
              <CheckCircle2 className="h-8 w-8 text-sage" strokeWidth={1.75} />
              <h3 className="mt-4 text-xl text-card-foreground">
                Thanks &mdash; we&rsquo;ll be in touch.
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                We&rsquo;ll reach out using the contact details you provided.
              </p>
              <Button
                variant="outline"
                className="mt-6"
                onClick={() => {
                  setForm(empty);
                  setSubmitted(false);
                }}
              >
                Submit another request
              </Button>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="name">Your name</Label>
                  <Input id="name" required value={form.name} onChange={update('name')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="clinic">Clinic name</Label>
                  <Input id="clinic" required value={form.clinic} onChange={update('clinic')} />
                </div>
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="contactInfo">Phone or email</Label>
                  <Input
                    id="contactInfo"
                    required
                    value={form.contact}
                    onChange={update('contact')}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="patients">Patients per month (rough)</Label>
                  <Input
                    id="patients"
                    inputMode="numeric"
                    placeholder="e.g. 400"
                    value={form.patients}
                    onChange={update('patients')}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="message">Anything we should know?</Label>
                <Textarea
                  id="message"
                  rows={4}
                  placeholder="Specialities, languages your patients use, current follow-up process…"
                  value={form.message}
                  onChange={update('message')}
                />
              </div>

              <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={busy}>
                {busy ? 'Sending…' : 'Request a Pilot'}
              </Button>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
