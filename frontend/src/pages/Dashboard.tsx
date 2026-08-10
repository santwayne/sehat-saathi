import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Flag as FlagIcon, Pill, Users } from 'lucide-react';
import { AppShell } from '@/components/app/app-shell';
import { LoadingState, EmptyState, ErrorState } from '@/components/app/states';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';

interface ApiFlag {
  id: string;
  flag_type: string;
  priority: 'urgent' | 'normal';
  status: string;
  patient_name: string;
  patient_phone: string;
  doctor_name: string | null;
  created_at: string;
}

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
}: {
  label: string;
  value: number | string;
  hint: string;
  icon: typeof Users;
  tone?: 'default' | 'alert';
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-card">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
        <span
          className={
            tone === 'alert'
              ? 'flex size-8 items-center justify-center rounded-lg bg-destructive/10 text-destructive'
              : 'flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary'
          }
        >
          <Icon className="size-4" aria-hidden />
        </span>
      </div>
      <p className="mt-3 font-display text-3xl font-semibold text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export default function Dashboard() {
  const { staff } = useAuth();
  const [flags, setFlags] = useState<ApiFlag[] | null>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [patientCount, setPatientCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const scope = staff?.role === 'doctor' ? 'Your patients only' : 'Clinic-wide';

  useEffect(() => {
    if (!staff) return;
    setLoading(true);
    Promise.all([
      api
        .get<{ data: ApiFlag[] }>(`/api/flags?status=open&role=${staff.role}&staff_id=${staff.id}`)
        .then((r) => setFlags(r.data))
        .catch(() => setFlags([])),
      api
        .get<{ data: unknown[] }>('/api/prescriptions/pending')
        .then((r) => setPendingCount(r.data.length))
        .catch(() => setPendingCount(0)),
      api
        .get<{ data: unknown[] }>(`/api/patients?role=${staff.role}&staff_id=${staff.id}`)
        .then((r) => setPatientCount(r.data.length))
        .catch(() => setPatientCount(0)),
    ])
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load dashboard'))
      .finally(() => setLoading(false));
  }, [staff]);

  const urgent = (flags ?? []).filter((f) => f.priority === 'urgent');
  const allEmpty =
    patientCount === 0 && (flags?.length ?? 0) === 0 && pendingCount === 0 && !loading;

  function retry() {
    setError(null);
    setFlags(null);
    setPendingCount(null);
    setPatientCount(null);
    setLoading(true);
    if (!staff) return;
    Promise.all([
      api
        .get<{ data: ApiFlag[] }>(`/api/flags?status=open&role=${staff.role}&staff_id=${staff.id}`)
        .then((r) => setFlags(r.data))
        .catch(() => setFlags([])),
      api
        .get<{ data: unknown[] }>('/api/prescriptions/pending')
        .then((r) => setPendingCount(r.data.length))
        .catch(() => setPendingCount(0)),
      api
        .get<{ data: unknown[] }>(`/api/patients?role=${staff.role}&staff_id=${staff.id}`)
        .then((r) => setPatientCount(r.data.length))
        .catch(() => setPatientCount(0)),
    ])
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load dashboard'))
      .finally(() => setLoading(false));
  }

  return (
    <AppShell
      title={`Good day, ${staff?.name?.split(' ')[0] ?? ''}`}
      description={`${scope} overview of today's clinic activity.`}
    >
      {loading ? (
        <LoadingState rows={4} label="Loading clinic overview…" />
      ) : error ? (
        <ErrorState error={error} onRetry={retry} />
      ) : allEmpty ? (
        <EmptyState
          title="No clinic activity yet"
          description="Once patients are enrolled and conversations start, their flags and prescriptions will appear here."
        />
      ) : (
        <div className="space-y-8">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Patients"
              value={patientCount ?? '—'}
              hint={scope}
              icon={Users}
            />
            <StatCard
              label="Open flags"
              value={flags?.length ?? '—'}
              hint="Awaiting staff review"
              icon={FlagIcon}
              tone={(flags?.length ?? 0) > 0 ? 'alert' : 'default'}
            />
            <StatCard
              label="Needs attention"
              value={urgent.length}
              hint="Urgent priority"
              icon={AlertTriangle}
              tone={urgent.length > 0 ? 'alert' : 'default'}
            />
            <StatCard
              label="Pending prescriptions"
              value={pendingCount ?? '—'}
              hint="Awaiting verification"
              icon={Pill}
            />
          </div>

          <section className="rounded-xl border border-border bg-card p-6">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold text-foreground">Priority flags</h2>
              <Link to="/app/flags" className="text-sm font-medium text-primary hover:underline">
                View all flags
              </Link>
            </div>
            {urgent.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">
                No urgent flags right now.
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-border">
                {urgent.slice(0, 5).map((flag) => (
                  <li key={flag.id} className="flex items-start justify-between gap-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">{flag.patient_name}</p>
                      <p className="text-sm text-muted-foreground">{flag.flag_type.replace(/_/g, ' ')}</p>
                    </div>
                    <span className="rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive capitalize">
                      {flag.priority}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}
