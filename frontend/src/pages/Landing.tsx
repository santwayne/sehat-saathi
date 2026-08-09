import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

const STEPS = [
  { title: 'Doctor writes the prescription as usual', body: 'No new device, no new workflow for the doctor.' },
  { title: 'Staff photograph and verify it', body: 'AI reads it into structured data — a staff member always double-checks before anything reaches the patient.' },
  { title: 'Patient gets a plain-language explanation', body: 'Sent via WhatsApp in Hindi, Punjabi, or English.' },
  { title: 'Scheduled WhatsApp check-ins', body: 'Patients can ask small questions and get instant, accurate answers sourced only from their own prescription.' },
  { title: 'Anything serious gets flagged to the clinic', body: 'New symptoms, repeated missed doses, or questions the AI can\'t answer safely are routed straight to the right doctor.' },
];

const SAFETY = [
  'Never suggests starting, stopping, or changing a dose — hard-coded, not just prompted',
  "Never invents a dosage or instruction that isn't literally on the prescription",
  'A staff member manually reviews and approves every prescription before it reaches a patient',
  'Every AI-generated message is logged for audit review',
  'Instant per-patient or per-clinic kill switch to stop all automated messages',
  "Built around explicit patient consent and India's DPDP Act",
];

export default function Landing() {
  const [form, setForm] = useState({ contact_name: '', clinic_name: '', contact_info: '', patient_volume_estimate: '', message: '' });
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus('submitting');
    try {
      await api.post('/api/pilot-requests', form);
      setStatus('done');
    } catch {
      setStatus('error');
    }
  }

  return (
    <div className="bg-white text-slate-800">
      <header className="max-w-5xl mx-auto px-6 py-5 flex items-center justify-between">
        <span className="font-semibold text-teal-800">Sehat Saathi</span>
        <Link to="/login" className="text-sm text-slate-600 hover:text-teal-800">Staff login →</Link>
      </header>

      <section className="max-w-3xl mx-auto px-6 py-16 text-center">
        <h1 className="text-4xl font-semibold tracking-tight mb-4">
          Your patients' prescriptions, explained in their own language — automatically.
        </h1>
        <p className="text-lg text-slate-600 mb-8">
          Sehat Saathi translates a doctor's prescription into WhatsApp check-ins and answers in Hindi, Punjabi,
          or English, and only escalates to staff when something actually needs a human.
        </p>
        <div className="flex justify-center gap-3">
          <a href="#pilot" className="bg-teal-700 text-white px-5 py-2.5 rounded-md text-sm font-medium">Request a Pilot</a>
          <a href="#how" className="border border-slate-300 px-5 py-2.5 rounded-md text-sm font-medium">See how it works</a>
        </div>
      </section>

      <section className="bg-slate-50 py-16">
        <div className="max-w-4xl mx-auto px-6 grid md:grid-cols-2 gap-6">
          {[
            'Patients forget medication timing or don\'t understand instructions written in English or medical shorthand.',
            'Clinic staff don\'t have time to call every patient for follow-up.',
            'Missed follow-ups and worsening symptoms happen silently between visits.',
            'Language barriers make phone-based follow-up inconsistent.',
          ].map((t) => (
            <div key={t} className="bg-white border border-slate-200 rounded-lg p-5 text-sm text-slate-600">{t}</div>
          ))}
        </div>
      </section>

      <section id="how" className="max-w-3xl mx-auto px-6 py-16">
        <h2 className="text-2xl font-semibold text-center mb-10">How it works</h2>
        <div className="space-y-6">
          {STEPS.map((s, i) => (
            <div key={s.title} className="flex gap-4">
              <div className="shrink-0 w-8 h-8 rounded-full bg-teal-700 text-white flex items-center justify-center text-sm font-medium">{i + 1}</div>
              <div>
                <p className="font-medium">{s.title}</p>
                <p className="text-sm text-slate-600">{s.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-teal-800 text-white py-16">
        <div className="max-w-3xl mx-auto px-6">
          <h2 className="text-2xl font-semibold text-center mb-2">Built with hard limits, not just good intentions.</h2>
          <p className="text-center text-teal-100 mb-10 text-sm">
            The AI answers questions. It never makes clinical decisions. Every clinical decision still comes from your doctors.
          </p>
          <div className="grid md:grid-cols-2 gap-4">
            {SAFETY.map((s) => (
              <div key={s} className="bg-teal-900/40 rounded-lg p-4 text-sm">{s}</div>
            ))}
          </div>
        </div>
      </section>

      <section className="max-w-3xl mx-auto px-6 py-16">
        <h2 className="text-xl font-semibold text-center mb-6">What we're piloting first</h2>
        <p className="text-sm text-slate-600 text-center mb-6">
          WhatsApp-only for now (voice is a planned Phase 2), starting with 2–3 common conditions, and every
          prescription manually verified by staff. Metrics we're building toward proving: missed-dose catch rate,
          follow-up attendance, flags raised vs. resolved, and doctor-reported time saved.
        </p>
      </section>

      <section id="pilot" className="bg-slate-50 py-16">
        <div className="max-w-md mx-auto px-6">
          <h2 className="text-xl font-semibold mb-6 text-center">Request a Pilot</h2>
          {status === 'done' ? (
            <p className="text-center text-teal-800 bg-teal-50 rounded-md p-4 text-sm">Thanks — we'll be in touch.</p>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <input required placeholder="Name" value={form.contact_name}
                onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
              <input required placeholder="Clinic name" value={form.clinic_name}
                onChange={(e) => setForm({ ...form, clinic_name: e.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
              <input required placeholder="Phone or email" value={form.contact_info}
                onChange={(e) => setForm({ ...form, contact_info: e.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
              <input placeholder="Approx. number of patients" value={form.patient_volume_estimate}
                onChange={(e) => setForm({ ...form, patient_volume_estimate: e.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
              <textarea placeholder="Message" value={form.message}
                onChange={(e) => setForm({ ...form, message: e.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" rows={3} />
              {status === 'error' && <p className="text-sm text-red-600">Something went wrong — please try again.</p>}
              <button type="submit" disabled={status === 'submitting'}
                className="w-full bg-teal-700 text-white rounded-md py-2.5 text-sm font-medium disabled:opacity-50">
                {status === 'submitting' ? 'Sending…' : 'Request a Pilot'}
              </button>
            </form>
          )}
        </div>
      </section>

      <footer className="text-center text-xs text-slate-400 py-8">
        Sehat Saathi, by Wayne E Solutions · hello@sehatsaathi.example
      </footer>
    </div>
  );
}
