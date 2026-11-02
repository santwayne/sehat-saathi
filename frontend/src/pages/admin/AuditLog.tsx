import { useEffect, useState, type FormEvent } from 'react';
import { ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/app-shell';
import { ErrorState, LoadingState } from '@/components/app/states';
import { Pill, Section, Select, Table } from '@/components/app/admin-ui';
import { formatDateTime, td } from '@/lib/format';
import { useClinicSwitcher } from '@/context/ClinicContext';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
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
interface BreakGlass {
  id: string;
  clinic_id: string;
  clinic_name: string;
  reason: string;
  duration_minutes: number;
  status: 'pending' | 'approved' | 'denied' | 'revoked';
  is_active: boolean;
  requested_by_name: string | null;
  decided_by_name: string | null;
  decision_note: string | null;
  decided_at: string | null;
  expires_at: string | null;
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
  ['break_glass.', 'Break-glass'],
  ['profile.', 'Profile changes'],
] as const;

function bgStatus(b: BreakGlass) {
  if (b.is_active) return <Pill tone="red">Active until {formatDateTime(b.expires_at)}</Pill>;
  if (b.status === 'approved') return <Pill>Expired</Pill>;
  if (b.status === 'pending') return <Pill tone="amber">Waiting for hospital</Pill>;
  if (b.status === 'denied') return <Pill>Denied</Pill>;
  return <Pill>Revoked</Pill>;
}

function BreakGlassSheet({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void }) {
  const { clinics } = useClinicSwitcher();
  const [form, setForm] = useState({ clinic_id: '', reason: '', duration_minutes: '60' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setForm({ clinic_id: '', reason: '', duration_minutes: '60' });
  }, [open]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/admin/break-glass', { ...form, duration_minutes: Number(form.duration_minutes) });
      toast.success("Request sent. The hospital's admin has to approve it from their Settings page.");
      onOpenChange(false);
      onCreated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Break-glass request</SheetTitle>
        </SheetHeader>
        <form onSubmit={onSubmit} className="mt-6 space-y-5 px-1">
          <p className="text-sm text-muted-foreground">
            For emergencies only. If the hospital's admin approves, you get <strong>read-only</strong> access to that
            hospital's patient data via the API for the time you choose. Every request you make is logged here.
          </p>
          <div className="space-y-2">
            <Label htmlFor="bgClinic">Hospital</Label>
            <Select id="bgClinic" required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value })}>
              <option value="">Select…</option>
              {clinics.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="bgReason">Reason</Label>
            <Textarea
              id="bgReason"
              required
              minLength={15}
              rows={4}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              placeholder="What happened and why patient-level access is needed. The hospital admin reads this before approving."
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bgDuration">Access window</Label>
            <Select id="bgDuration" value={form.duration_minutes} onChange={(e) => setForm({ ...form, duration_minutes: e.target.value })}>
              <option value="15">15 minutes</option>
              <option value="30">30 minutes</option>
              <option value="60">1 hour</option>
              <option value="240">4 hours</option>
              <option value="1440">24 hours</option>
            </Select>
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Sending…' : 'Send request'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export default function AuditLog() {
  const { clinics } = useClinicSwitcher();
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [requests, setRequests] = useState<BreakGlass[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [action, setAction] = useState('');
  const [clinicId, setClinicId] = useState('');
  const [bgOpen, setBgOpen] = useState(false);
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

  function loadRequests() {
    return api.get<{ data: BreakGlass[] }>('/api/admin/break-glass').then((r) => setRequests(r.data));
  }

  useEffect(() => {
    setError(null);
    setRows(null);
    loadAudit().catch(setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, clinicId]);

  useEffect(() => {
    loadRequests().catch(setError);
  }, []);

  async function revoke(b: BreakGlass) {
    try {
      await api.post(`/api/admin/break-glass/${b.id}/revoke`);
      toast.success(b.status === 'pending' ? 'Request withdrawn' : 'Access ended');
      loadRequests();
      loadAudit();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    }
  }

  return (
    <AppShell
      title="Audit Log"
      description="Who did what on the platform, and break-glass requests for emergency access to a hospital's patient data."
      actions={
        <Button variant="outline" onClick={() => setBgOpen(true)}>
          <ShieldAlert className="mr-1.5 size-4" />
          Request break-glass
        </Button>
      }
    >
      <BreakGlassSheet open={bgOpen} onOpenChange={setBgOpen} onCreated={() => { loadRequests(); loadAudit(); }} />
      {error ? (
        <ErrorState error={error} />
      ) : (
        <div className="space-y-6">
          <Section title="Break-glass requests" description="Approved by the hospital's own admin. Read-only, time-boxed and fully logged.">
            {!requests ? (
              <LoadingState rows={1} />
            ) : requests.length === 0 ? (
              <p className="text-sm text-muted-foreground">No break-glass requests so far.</p>
            ) : (
              <Table head={['Requested', 'Hospital', 'Reason', 'Window', 'Status', 'Decided by', '']}>
                {requests.map((b) => (
                  <tr key={b.id}>
                    <td className={`${td} whitespace-nowrap text-muted-foreground`}>{formatDateTime(b.created_at)}</td>
                    <td className={td}>{b.clinic_name}</td>
                    <td className={`${td} max-w-sm break-words`}>{b.reason}</td>
                    <td className={td}>{b.duration_minutes >= 60 ? `${b.duration_minutes / 60} h` : `${b.duration_minutes} min`}</td>
                    <td className={td}>{bgStatus(b)}</td>
                    <td className={`${td} text-muted-foreground`}>
                      {b.decided_by_name ?? '—'}
                      {b.decision_note && <span className="block text-xs">“{b.decision_note}”</span>}
                    </td>
                    <td className={`${td} text-right`}>
                      {(b.status === 'pending' || b.is_active) && (
                        <Button size="sm" variant="ghost" onClick={() => revoke(b)}>
                          {b.status === 'pending' ? 'Withdraw' : 'End now'}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>

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
                        <code className={`text-xs ${a.action.startsWith('break_glass') ? 'text-destructive' : 'text-foreground'}`}>{a.action}</code>
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
