import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app/app-shell';
import { ErrorState, LoadingState } from '@/components/app/states';
import { useEffectiveClinicId } from '@/context/ClinicContext';
import { api } from '@/lib/api';

interface Adherence {
  period_days: number;
  patients: { total: number; enrolled_in_period: number; kill_switch: number; abha_linked: number; bed_linked: number };
  checkins: { sent: number; answered: number; response_rate: number | null; patients_checked_in: number };
  daily: { day: string; sent: number; answered: number }[];
  flags: {
    total: number;
    urgent: number;
    open: number;
    patients_with_missed_dose: number;
    median_hours_to_resolve: number | null;
    by_type: { flag_type: string; count: number }[];
  };
  by_doctor: { doctor: string; patients: number; open_flags: number; missed_dose_flags: number }[];
}

const RANGES = [7, 30, 90];

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold text-foreground">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

// Roadmap "Hospital analytics on adherence". "Answered" = the patient replied
// within 24h of a check-in; replies aren't parsed into taken/missed yet.
export default function Analytics() {
  const clinicId = useEffectiveClinicId();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Adherence | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    const qs = new URLSearchParams({ days: String(days) });
    if (clinicId) qs.set('clinic_id', clinicId);
    api
      .get<{ data: Adherence }>(`/api/analytics/adherence?${qs}`)
      .then((r) => setData(r.data))
      .catch(setError);
  }, [days, clinicId]);

  const maxSent = Math.max(1, ...(data?.daily.map((d) => d.sent) ?? [1]));

  return (
    <AppShell
      title="Analytics"
      description="How patients are engaging with check-ins, and what is being flagged."
      actions={
        <div className="flex gap-1 rounded-lg border border-border p-1" role="group" aria-label="Period">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setDays(r)}
              aria-pressed={days === r}
              className={`rounded-md px-3 py-1 text-xs font-medium ${days === r ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
            >
              {r}d
            </button>
          ))}
        </div>
      }
    >
      {error ? (
        <ErrorState error={error} />
      ) : !data ? (
        <LoadingState rows={3} />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Patients" value={data.patients.total} hint={`${data.patients.enrolled_in_period} enrolled in last ${data.period_days}d`} />
            <Stat
              label="Check-in response rate"
              value={data.checkins.response_rate === null ? '—' : `${data.checkins.response_rate}%`}
              hint={`${data.checkins.answered} of ${data.checkins.sent} answered within 24h`}
            />
            <Stat label="Patients with missed doses" value={data.flags.patients_with_missed_dose} hint="Flagged in this period" />
            <Stat
              label="Median time to resolve a flag"
              value={data.flags.median_hours_to_resolve === null ? '—' : `${data.flags.median_hours_to_resolve}h`}
              hint={`${data.flags.open} open · ${data.flags.urgent} urgent`}
            />
          </div>

          <section className="rounded-xl border border-border bg-card p-6">
            <h2 className="font-display text-lg font-semibold">Daily check-ins</h2>
            {data.daily.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No check-ins sent in this period.</p>
            ) : (
              <ul className="mt-4 space-y-1.5">
                {data.daily.map((d) => (
                  <li key={d.day} className="flex items-center gap-3 text-xs">
                    <span className="w-20 shrink-0 text-muted-foreground">{d.day}</span>
                    <span className="relative h-4 flex-1 overflow-hidden rounded bg-secondary" aria-hidden>
                      <span className="absolute inset-y-0 left-0 bg-primary/25" style={{ width: `${(d.sent / maxSent) * 100}%` }} />
                      <span className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${(d.answered / maxSent) * 100}%` }} />
                    </span>
                    <span className="w-20 shrink-0 text-right text-muted-foreground">{d.answered}/{d.sent} answered</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="rounded-xl border border-border bg-card p-6">
              <h2 className="font-display text-lg font-semibold">Flags by type</h2>
              {data.flags.by_type.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No flags in this period.</p>
              ) : (
                <ul className="mt-3 divide-y divide-border text-sm">
                  {data.flags.by_type.map((f) => (
                    <li key={f.flag_type} className="flex justify-between py-2">
                      <span className="capitalize">{f.flag_type.replace(/_/g, ' ')}</span>
                      <span className="text-muted-foreground">{f.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-xl border border-border bg-card p-6">
              <h2 className="font-display text-lg font-semibold">By doctor</h2>
              <table className="mt-3 w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">Doctor</th>
                    <th className="pb-2 font-medium">Patients</th>
                    <th className="pb-2 font-medium">Open flags</th>
                    <th className="pb-2 font-medium">Missed dose</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.by_doctor.map((d) => (
                    <tr key={d.doctor}>
                      <td className="py-2 font-medium">{d.doctor}</td>
                      <td className="py-2 text-muted-foreground">{d.patients}</td>
                      <td className="py-2 text-muted-foreground">{d.open_flags}</td>
                      <td className="py-2 text-muted-foreground">{d.missed_dose_flags}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </div>
      )}
    </AppShell>
  );
}
