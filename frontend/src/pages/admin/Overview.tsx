import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { AppShell } from '@/components/app/app-shell';
import { ErrorState, LoadingState } from '@/components/app/states';
import { Section, Stat } from '@/components/app/admin-ui';
import { formatINR } from '@/lib/format';
import { api } from '@/lib/api';

interface OverviewData {
  hospitals: { total: number; active: number; onboarding: number; suspended: number };
  mrr_inr: number;
  subscriptions: { active: number; trial: number; past_due: number };
  revenue_30d_inr: number;
  patients: { enrolled: number; active_30d: number };
  alerts: { level: 'error' | 'warning' | 'info'; type: string; message: string; link: string }[];
}

const ALERT_ICON = {
  error: <XCircle className="size-4 text-destructive" aria-hidden />,
  warning: <AlertTriangle className="size-4 text-warning" aria-hidden />,
  info: <Info className="size-4 text-muted-foreground" aria-hidden />,
};

export default function Overview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<unknown>(null);

  function load() {
    setError(null);
    api
      .get<{ data: OverviewData }>('/api/admin/overview')
      .then((r) => setData(r.data))
      .catch(setError);
  }
  useEffect(load, []);

  return (
    <AppShell title="Overview" description="How the platform is doing: hospitals, recurring revenue, patient activity and anything that needs attention.">
      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : !data ? (
        <LoadingState rows={3} />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Hospitals"
              value={data.hospitals.total}
              hint={`${data.hospitals.active} active · ${data.hospitals.onboarding} onboarding · ${data.hospitals.suspended} suspended`}
            />
            <Stat
              label="MRR"
              value={formatINR(data.mrr_inr)}
              hint={`${data.subscriptions.active} paying · ${data.subscriptions.trial} on trial${data.subscriptions.past_due ? ` · ${data.subscriptions.past_due} past due` : ''}`}
            />
            <Stat label="Active patients (30 days)" value={data.patients.active_30d} hint={`${data.patients.enrolled} enrolled in total`} />
            <Stat label="Collected (30 days)" value={formatINR(data.revenue_30d_inr)} hint="Payments recorded in Plans & Billing" />
          </div>

          <Section
            title="Alerts"
            description="Trials ending, overdue invoices, platform errors and setup gaps."
          >
            {data.alerts.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4 text-success" aria-hidden />
                Nothing needs attention right now.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {data.alerts.map((a, i) => (
                  <li key={i} className="flex items-start justify-between gap-4 py-2.5">
                    <span className="flex items-start gap-2.5 text-sm text-foreground">
                      <span className="mt-0.5">{ALERT_ICON[a.level]}</span>
                      {a.message}
                    </span>
                    <Link to={a.link} className="shrink-0 text-xs font-medium text-primary hover:underline">
                      Open
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </AppShell>
  );
}
