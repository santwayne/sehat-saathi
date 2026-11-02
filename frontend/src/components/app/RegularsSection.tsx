import { useEffect, useState, type FormEvent } from 'react';
import { HeartHandshake, PlugZap, RefreshCw, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { Pill, Section, Table } from '@/components/app/admin-ui';
import { formatDateTime, td } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/lib/api';

interface HospitalRegulars {
  clinic_id: string;
  clinic_name: string;
  clinic_status: string;
  enabled: boolean;
  has_key: boolean;
  api_key_hint: string | null;
  location_id: string | null;
  business_name: string | null;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_synced_at: string | null;
  last_error: string | null;
  pending: number;
  failed: number;
  sent_30d: number;
}
interface Failure {
  id: string;
  event_type: string;
  external_id: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
}
interface TestResult {
  ok: boolean;
  message: string;
  locations?: { id: string; name: string; status: string }[];
}

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong';
}

function ConfigureSheet({ row, onOpenChange, onSaved }: { row: HospitalRegulars | null; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [locationId, setLocationId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [failures, setFailures] = useState<Failure[] | null>(null);

  useEffect(() => {
    if (!row) return;
    setApiKey('');
    setLocationId(row.location_id ?? '');
    setEnabled(row.enabled);
    setTest(null);
    setFailures(null);
    if (row.failed > 0) {
      api.get<{ data: Failure[] }>(`/api/admin/integrations/regulars/${row.clinic_id}/failures`).then((r) => setFailures(r.data)).catch(() => {});
    }
  }, [row]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!row) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { location_id: locationId.trim() || null };
      if (apiKey.trim()) body.api_key = apiKey.trim();
      // Save the key first so "enable" is accepted in the same click.
      await api.put(`/api/admin/integrations/regulars/${row.clinic_id}`, body);
      if (enabled !== row.enabled) await api.put(`/api/admin/integrations/regulars/${row.clinic_id}`, { enabled });
      toast.success(`${row.clinic_name}: Regulars settings saved`);
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    if (!row) return;
    setTesting(true);
    try {
      if (apiKey.trim()) {
        await api.put(`/api/admin/integrations/regulars/${row.clinic_id}`, { api_key: apiKey.trim() });
        setApiKey('');
      }
      const r = await api.post<{ data: TestResult }>(`/api/admin/integrations/regulars/${row.clinic_id}/test`);
      setTest(r.data);
      onSaved();
    } catch (e) {
      setTest({ ok: false, message: errMsg(e) });
    } finally {
      setTesting(false);
    }
  }

  async function removeKey() {
    if (!row || !confirm(`Remove the Regulars key for ${row.clinic_name}? Syncing stops.`)) return;
    try {
      await api.put(`/api/admin/integrations/regulars/${row.clinic_id}`, { enabled: false });
      await api.put(`/api/admin/integrations/regulars/${row.clinic_id}`, { api_key: '' });
      toast.success('Key removed, connection off');
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  return (
    <Sheet open={!!row} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{row?.clinic_name} — Regulars</SheetTitle>
        </SheetHeader>
        <form onSubmit={save} className="mt-6 space-y-5 px-1">
          <p className="text-sm text-muted-foreground">
            Create a Regulars business for this hospital, issue it a key in <strong>Regulars → Admin → API keys</strong>,
            and paste it here. Sehat Saathi then reports enrolments, real visits (verified documents) and opt-outs.
          </p>
          <div className="space-y-2">
            <Label htmlFor="rgKey">API key</Label>
            <Input
              id="rgKey"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={row?.has_key ? `Current: ${row.api_key_hint}` : 'rk_live_…'}
            />
            {row?.has_key && (
              <button type="button" onClick={removeKey} className="text-xs text-destructive hover:underline">
                Remove key
              </button>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="rgLoc">Regulars location ID</Label>
            <Input id="rgLoc" value={locationId} onChange={(e) => setLocationId(e.target.value)} placeholder="Optional — defaults to the business's first location" />
          </div>
          <div className="space-y-2">
            <Button type="button" variant="outline" size="sm" onClick={runTest} disabled={testing || (!row?.has_key && !apiKey.trim())}>
              <PlugZap className="mr-1.5 size-3.5" />
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            {test && (
              <div className={`rounded-lg px-3 py-2 text-sm ${test.ok ? 'bg-primary/10 text-primary' : 'bg-destructive/10 text-destructive'}`}>
                {test.message}
                {test.locations && test.locations.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs text-foreground">
                    {test.locations.map((l) => (
                      <li key={l.id} className="flex items-center justify-between gap-2">
                        <span>
                          {l.name} <code className="text-muted-foreground">{l.id}</code>
                        </span>
                        <button type="button" className="text-primary hover:underline" onClick={() => setLocationId(l.id)}>
                          Use
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input type="checkbox" className="mt-1" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>
              Sync this hospital to Regulars
              <span className="block text-xs text-muted-foreground">
                Only consenting patients; only phone, first name and visit dates. Never diagnoses, medicines or documents.
              </span>
            </span>
          </label>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </form>

        {failures && failures.length > 0 && (
          <div className="mt-8 space-y-2 px-1">
            <h3 className="text-sm font-semibold text-foreground">Failed events</h3>
            <ul className="space-y-2 text-xs">
              {failures.map((f) => (
                <li key={f.id} className="rounded border border-border p-2">
                  <span className="font-medium">{f.event_type}</span> <code className="text-muted-foreground">{f.external_id}</code>
                  <span className="block text-destructive">{f.last_error}</span>
                  <span className="text-muted-foreground">
                    {formatDateTime(f.created_at)} · {f.attempts} attempt(s)
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function RegularsSection({ baseUrlConfigured }: { baseUrlConfigured: boolean }) {
  const [rows, setRows] = useState<HospitalRegulars[] | null>(null);
  const [editing, setEditing] = useState<HospitalRegulars | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function load() {
    api
      .get<{ data: { hospitals: HospitalRegulars[] } }>('/api/admin/integrations/regulars')
      .then((r) => setRows(r.data.hospitals))
      .catch(() => setRows([]));
  }
  useEffect(load, [baseUrlConfigured]);

  async function action(row: HospitalRegulars, kind: 'sync' | 'backfill' | 'retry-failed') {
    setBusy(`${row.clinic_id}:${kind}`);
    try {
      if (kind === 'sync') {
        const r = await api.post<{ data: { sent: number; failed: number; retrying: number; error: string | null } }>(`/api/admin/integrations/regulars/${row.clinic_id}/sync`);
        if (r.data.error) toast.error(`Sync problem: ${r.data.error}`);
        else toast.success(`Sent ${r.data.sent}${r.data.failed ? `, ${r.data.failed} rejected` : ''}`);
      } else if (kind === 'backfill') {
        if (!confirm(`Send ${row.clinic_name}'s existing consenting patients and verified visits to Regulars?`)) return;
        const r = await api.post<{ data: { patients: number; visits: number; queued: number } }>(`/api/admin/integrations/regulars/${row.clinic_id}/backfill`);
        toast.success(`Queued ${r.data.queued} event(s) (${r.data.patients} patients, ${r.data.visits} visits; already-sent ones skipped)`);
      } else {
        const r = await api.post<{ data: { requeued: number } }>(`/api/admin/integrations/regulars/${row.clinic_id}/retry-failed`);
        toast.success(`${r.data.requeued} event(s) queued again`);
      }
      setTimeout(load, kind === 'sync' ? 0 : 1500);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section
      title="Regulars — per hospital"
      description="Connect a hospital to its Regulars business so real clinic visits feed Regulars' retention segments (who is slipping away, who to call). Super Admin only."
    >
      <ConfigureSheet row={editing} onOpenChange={(v) => !v && setEditing(null)} onSaved={load} />
      {!baseUrlConfigured && (
        <p className="mb-4 rounded-lg border border-warning-border bg-warning-surface px-4 py-3 text-sm text-warning-foreground">
          Set the Regulars URL first: <strong>Regulars (retention) → Edit keys</strong> above.
        </p>
      )}
      {!rows ? null : (
        <Table head={['Hospital', 'Status', 'Regulars business', 'Events', 'Last sync', '']}>
          {rows.map((r) => (
            <tr key={r.clinic_id}>
              <td className={`${td} whitespace-nowrap font-medium text-foreground`}>
                <span className="flex items-center gap-2">
                  <HeartHandshake className="size-4 text-muted-foreground" aria-hidden />
                  {r.clinic_name}
                </span>
              </td>
              <td className={td}>
                {r.enabled ? (
                  r.last_error ? <Pill tone="amber">On · problem</Pill> : <Pill tone="green">On</Pill>
                ) : r.has_key ? (
                  <Pill>Off</Pill>
                ) : (
                  <Pill>Not connected</Pill>
                )}
              </td>
              <td className={td}>
                {r.business_name ?? <span className="text-muted-foreground">—</span>}
                {r.last_test_ok === false && <span className="block text-xs text-destructive">Last test failed</span>}
              </td>
              <td className={`${td} whitespace-nowrap text-xs`}>
                <span className="block text-foreground">{r.sent_30d} sent (30d)</span>
                <span className="block text-muted-foreground">{r.pending} waiting</span>
                {r.failed > 0 && <span className="block text-destructive">{r.failed} failed</span>}
              </td>
              <td className={`${td} whitespace-nowrap text-muted-foreground`}>
                {formatDateTime(r.last_synced_at)}
                {r.last_error && <span className="block max-w-xs truncate text-xs text-destructive" title={r.last_error}>{r.last_error}</span>}
              </td>
              <td className={`${td} text-right`}>
                <div className="flex flex-wrap justify-end gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => setEditing(r)}>
                    <Settings2 className="mr-1 size-3.5" />
                    {r.has_key ? 'Configure' : 'Connect'}
                  </Button>
                  {r.enabled && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => action(r, 'sync')} disabled={!!busy} title="Push waiting events now">
                        <RefreshCw className={`size-3.5 ${busy === `${r.clinic_id}:sync` ? 'animate-spin' : ''}`} />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => action(r, 'backfill')} disabled={!!busy}>
                        Backfill
                      </Button>
                      {r.failed > 0 && (
                        <Button size="sm" variant="ghost" onClick={() => action(r, 'retry-failed')} disabled={!!busy}>
                          Retry failed
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}
