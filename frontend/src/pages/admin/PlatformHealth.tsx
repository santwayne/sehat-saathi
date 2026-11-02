import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/app-shell';
import { ErrorState, LoadingState } from '@/components/app/states';
import { Pill, Section, Select, Stat, Table } from '@/components/app/admin-ui';
import { formatDateTime, td } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

interface PlatformEvent {
  id: string;
  source: string;
  severity: 'error' | 'warning';
  clinic_name: string | null;
  message: string;
  details: Record<string, unknown> | null;
  resolved_at: string | null;
  created_at: string;
}
interface Summary {
  source: string;
  last_24h: number;
  open: number;
  last_at: string;
}
interface HealthData {
  events: PlatformEvent[];
  summary: Summary[];
  sources: string[];
}

const SOURCE_LABEL: Record<string, string> = {
  webhook: 'Webhook',
  queue: 'Check-in queue',
  ocr: 'OCR',
  whatsapp_send: 'WhatsApp sends',
  voice: 'Voice calls',
  media: 'Media downloads',
  integration: 'Integrations',
  other: 'Other',
};
const HEADLINE = ['webhook', 'queue', 'ocr', 'whatsapp_send'];

export default function PlatformHealth() {
  const [data, setData] = useState<HealthData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [source, setSource] = useState('');
  const [state, setState] = useState('open');
  const [days, setDays] = useState('7');

  function load() {
    setError(null);
    const qs = new URLSearchParams({ state, days });
    if (source) qs.set('source', source);
    api
      .get<{ data: HealthData }>(`/api/admin/health?${qs}`)
      .then((r) => setData(r.data))
      .catch(setError);
  }
  useEffect(load, [source, state, days]);

  async function resolve(id: string) {
    try {
      await api.patch(`/api/admin/health/${id}/resolve`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function resolveAll() {
    try {
      const r = await api.post<{ data: { resolved: number } }>('/api/admin/health/resolve-all', { source: source || undefined });
      toast.success(`${r.data.resolved} event(s) marked resolved`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    }
  }

  const summaryFor = (s: string) => data?.summary.find((x) => x.source === s);

  return (
    <AppShell title="Platform Health" description="Webhook, check-in queue, OCR and WhatsApp send errors across all hospitals.">
      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : !data ? (
        <LoadingState rows={4} />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {HEADLINE.map((s) => {
              const sm = summaryFor(s);
              return (
                <Stat
                  key={s}
                  label={SOURCE_LABEL[s]}
                  value={sm?.open ?? 0}
                  tone={sm?.open ? 'danger' : 'default'}
                  hint={sm ? `${sm.last_24h} in last 24h · last ${formatDateTime(sm.last_at)}` : 'No errors in 30 days'}
                />
              );
            })}
          </div>

          <Section
            title="Events"
            description="Error text and ids only — patient details are never written here."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Select value={source} onChange={(e) => setSource(e.target.value)} className="w-40" aria-label="Source">
                  <option value="">All sources</option>
                  {data.sources.map((s) => (
                    <option key={s} value={s}>
                      {SOURCE_LABEL[s] ?? s}
                    </option>
                  ))}
                </Select>
                <Select value={state} onChange={(e) => setState(e.target.value)} className="w-32" aria-label="State">
                  <option value="open">Open</option>
                  <option value="resolved">Resolved</option>
                  <option value="all">All</option>
                </Select>
                <Select value={days} onChange={(e) => setDays(e.target.value)} className="w-28" aria-label="Period">
                  <option value="1">24 hours</option>
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                </Select>
                {state !== 'resolved' && data.events.some((e) => !e.resolved_at) && (
                  <Button size="sm" variant="outline" onClick={resolveAll}>
                    Resolve all
                  </Button>
                )}
              </div>
            }
          >
            {data.events.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4 text-success" aria-hidden />
                No events for this filter.
              </p>
            ) : (
              <Table head={['When', 'Source', 'Hospital', 'Message', '']}>
                {data.events.map((e) => (
                  <tr key={e.id} className={e.resolved_at ? 'opacity-60' : undefined}>
                    <td className={`${td} whitespace-nowrap text-muted-foreground`}>{formatDateTime(e.created_at)}</td>
                    <td className={td}>
                      <Pill tone={e.severity === 'error' ? 'red' : 'amber'}>{SOURCE_LABEL[e.source] ?? e.source}</Pill>
                    </td>
                    <td className={td}>{e.clinic_name ?? '—'}</td>
                    <td className={`${td} max-w-xl break-words text-foreground`}>
                      {e.message}
                      {e.details && (
                        <code className="mt-1 block truncate text-xs text-muted-foreground" title={JSON.stringify(e.details)}>
                          {JSON.stringify(e.details)}
                        </code>
                      )}
                    </td>
                    <td className={`${td} text-right`}>
                      {e.resolved_at ? (
                        <span className="text-xs text-muted-foreground">Resolved</span>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => resolve(e.id)}>
                          Resolve
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
        </div>
      )}
    </AppShell>
  );
}
