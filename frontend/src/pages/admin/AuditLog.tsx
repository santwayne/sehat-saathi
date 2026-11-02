import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app/app-shell';
import { ErrorState, LoadingState } from '@/components/app/states';
import { Section, Select, Table } from '@/components/app/admin-ui';
import { formatDateTime, td } from '@/lib/format';
import { useClinicSwitcher } from '@/context/ClinicContext';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

interface AuditRow {
  id: string;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  clinic_name: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
}
const ACTION_GROUPS = [
  ['', 'All actions'],
  ['auth.', 'Sign-ins & passwords'],
  ['clinic.', 'Hospitals'],
  ['subscription.', 'Subscriptions'],
  ['invoice.', 'Invoices'],
  ['payment.', 'Payments'],
  ['plan.', 'Plans'],
  ['integration.', 'Integrations'],
  ['break_glass.', 'Break-glass (history, removed)'],
  ['profile.', 'Profile changes'],
] as const;

export default function AuditLog() {
  const { clinics } = useClinicSwitcher();
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [action, setAction] = useState('');
  const [clinicId, setClinicId] = useState('');
  const [hasMore, setHasMore] = useState(false);

  const PAGE = 100;

  function loadAudit(before?: string) {
    const qs = new URLSearchParams({ limit: String(PAGE) });
    if (action) qs.set('action', action);
    if (clinicId) qs.set('clinic_id', clinicId);
    if (before) qs.set('before', before);
    return api.get<{ data: AuditRow[] }>(`/api/admin/audit?${qs}`).then((r) => {
      setRows((prev) => (before ? [...(prev ?? []), ...r.data] : r.data));
      setHasMore(r.data.length === PAGE);
    });
  }

  useEffect(() => {
    setError(null);
    setRows(null);
    loadAudit().catch(setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, clinicId]);


  return (
    <AppShell
      title="Audit Log"
      description="Who did what on the platform: sign-ins, hospital changes, billing, keys and settings. Super Admin never has access to patient records."
    >
      {error ? (
        <ErrorState error={error} />
      ) : (
        <div className="space-y-6">

          <Section
            title="Activity"
            actions={
              <div className="flex gap-2">
                <Select value={action} onChange={(e) => setAction(e.target.value)} className="w-48" aria-label="Action">
                  {ACTION_GROUPS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
                <Select value={clinicId} onChange={(e) => setClinicId(e.target.value)} className="w-48" aria-label="Hospital">
                  <option value="">All hospitals</option>
                  {clinics.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
            }
          >
            {!rows ? (
              <LoadingState rows={4} />
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing logged for this filter.</p>
            ) : (
              <>
                <Table head={['When', 'Who', 'Action', 'Hospital', 'Details', 'IP']}>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td className={`${td} whitespace-nowrap text-muted-foreground`}>{formatDateTime(a.created_at)}</td>
                      <td className={td}>
                        {a.actor_name ?? '—'}
                        {a.actor_role && <span className="block text-xs text-muted-foreground">{a.actor_role}</span>}
                      </td>
                      <td className={td}>
                        <code className={`text-xs ${'text-foreground'}`}>{a.action}</code>
                      </td>
                      <td className={td}>{a.clinic_name ?? '—'}</td>
                      <td className={`${td} max-w-xs`}>
                        {a.details ? (
                          <code className="block truncate text-xs text-muted-foreground" title={JSON.stringify(a.details)}>
                            {JSON.stringify(a.details)}
                          </code>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className={`${td} font-mono text-xs text-muted-foreground`}>{a.ip ?? '—'}</td>
                    </tr>
                  ))}
                </Table>
                {hasMore && (
                  <div className="mt-4 text-center">
                    <Button variant="outline" size="sm" onClick={() => loadAudit(rows[rows.length - 1].created_at).catch(setError)}>
                      Load older
                    </Button>
                  </div>
                )}
              </>
            )}
          </Section>
        </div>
      )}
    </AppShell>
  );
}
