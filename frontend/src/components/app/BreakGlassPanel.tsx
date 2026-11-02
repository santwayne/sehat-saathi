import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

interface Request {
  id: string;
  reason: string;
  duration_minutes: number;
  status: 'pending' | 'approved' | 'denied' | 'revoked';
  is_active: boolean;
  requested_by_name: string | null;
  decided_by_name: string | null;
  expires_at: string | null;
  created_at: string;
}

const fmt = (v: string | null) =>
  v ? new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

/**
 * Hospital admin's view of Sehat Saathi Super Admin's break-glass requests
 * for this hospital. Super Admin cannot see patient data unless approved here.
 */
export function BreakGlassPanel() {
  const [rows, setRows] = useState<Request[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function load() {
    api
      .get<{ data: Request[] }>('/api/break-glass')
      .then((r) => setRows(r.data))
      .catch(() => setRows([]));
  }
  useEffect(load, []);

  async function act(r: Request, action: 'approve' | 'deny' | 'revoke') {
    const note = action === 'deny' ? window.prompt('Reason for denying (optional)') ?? undefined : undefined;
    setBusy(r.id);
    try {
      await api.post(`/api/break-glass/${r.id}/${action}`, note ? { note } : undefined);
      toast.success(action === 'approve' ? `Approved for ${r.duration_minutes} minutes` : action === 'deny' ? 'Request denied' : 'Access ended');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  }

  const pending = rows?.filter((r) => r.status === 'pending') ?? [];
  const recent = rows?.filter((r) => r.status !== 'pending').slice(0, 5) ?? [];

  return (
    <section className="rounded-xl border border-border bg-card p-6 lg:col-span-2">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 size-5 text-muted-foreground" aria-hidden />
        <div>
          <h2 className="font-display text-lg font-semibold text-foreground">Emergency access requests</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The Sehat Saathi platform team cannot see your patients' data. In an emergency they can ask for temporary,
            read-only access — it only starts if you approve it here, and every view is logged.
          </p>
        </div>
      </div>

      {rows === null ? null : pending.length === 0 && recent.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No requests.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {pending.map((r) => (
            <div key={r.id} className="rounded-lg border border-warning-border bg-warning-surface p-4">
              <p className="text-sm font-medium text-foreground">
                {r.requested_by_name ?? 'Super Admin'} asks for {r.duration_minutes >= 60 ? `${r.duration_minutes / 60} hour(s)` : `${r.duration_minutes} minutes`} of read-only access
              </p>
              <p className="mt-1 text-sm text-foreground">“{r.reason}”</p>
              <p className="mt-1 text-xs text-muted-foreground">Requested {fmt(r.created_at)}</p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={() => act(r, 'approve')} disabled={busy === r.id}>
                  Approve
                </Button>
                <Button size="sm" variant="outline" onClick={() => act(r, 'deny')} disabled={busy === r.id}>
                  Deny
                </Button>
              </div>
            </div>
          ))}
          {recent.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-sm">
              <span className="text-muted-foreground">
                {fmt(r.created_at)} · {r.reason.length > 80 ? `${r.reason.slice(0, 80)}…` : r.reason}
              </span>
              <span className="flex items-center gap-2">
                {r.is_active ? (
                  <>
                    <span className="text-xs font-medium text-destructive">Active until {fmt(r.expires_at)}</span>
                    <Button size="sm" variant="outline" onClick={() => act(r, 'revoke')} disabled={busy === r.id}>
                      End now
                    </Button>
                  </>
                ) : (
                  <span className="text-xs capitalize text-muted-foreground">
                    {r.status === 'approved' ? 'expired' : r.status}
                    {r.decided_by_name ? ` · ${r.decided_by_name}` : ''}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
