import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, CircleDashed, PlugZap, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/app-shell';
import { ErrorState, LoadingState } from '@/components/app/states';
import { Pill, Section, Table } from '@/components/app/admin-ui';
import { formatDateTime, td } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/lib/api';

interface Field {
  key: string;
  label: string;
  secret: boolean;
  source: 'console' | 'env' | 'missing';
  value: string | null;
}
interface Provider {
  id: string;
  label: string;
  description: string;
  configured: boolean;
  fields: Field[];
}
interface ClinicWa {
  id: string;
  name: string;
  status: string;
  whatsapp_number: string;
  whatsapp_phone_number_id: string | null;
  whatsapp_waba_id: string | null;
  has_access_token: boolean;
}
interface Template {
  scope: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  rejected_reason: string | null;
  synced_at: string;
}
interface IntegrationsData {
  providers: Provider[];
  clinics: ClinicWa[];
  templates: Template[];
  encryption_key_set: boolean;
}

const SOURCE_LABEL = { console: 'Set here', env: 'From server env', missing: 'Not set' } as const;

function ProviderSheet({ provider, onOpenChange, onSaved }: { provider: Provider | null; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [clear, setClear] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setValues({});
    setClear({});
  }, [provider]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!provider) return;
    const payload: Record<string, string> = {};
    for (const f of provider.fields) {
      if (clear[f.key]) payload[f.key] = '';
      else if (values[f.key]?.trim()) payload[f.key] = values[f.key].trim();
    }
    if (Object.keys(payload).length === 0) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    try {
      await api.put('/api/admin/integrations', { values: payload });
      toast.success(`${provider.label}: saved`);
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={!!provider} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{provider?.label}</SheetTitle>
        </SheetHeader>
        <form onSubmit={onSubmit} className="mt-6 space-y-5 px-1">
          <p className="text-sm text-muted-foreground">
            Leave a field empty to keep its current value. A value saved here overrides the server env var; clearing it
            falls back to the env value. Secrets are stored encrypted and never shown again.
          </p>
          {provider?.fields.map((f) => (
            <div key={f.key} className="space-y-2">
              <Label htmlFor={f.key}>{f.label}</Label>
              <Input
                id={f.key}
                type={f.secret ? 'password' : 'text'}
                autoComplete="off"
                value={values[f.key] ?? ''}
                disabled={clear[f.key]}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                placeholder={f.value ? `Current: ${f.value}` : 'Not set'}
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {SOURCE_LABEL[f.source]} · <code>{f.key}</code>
                </span>
                {f.source === 'console' && (
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={!!clear[f.key]} onChange={(e) => setClear({ ...clear, [f.key]: e.target.checked })} />
                    Clear
                  </label>
                )}
              </div>
            </div>
          ))}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function WabaCell({ clinic, onSaved }: { clinic: ClinicWa; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(clinic.whatsapp_waba_id ?? '');

  async function save() {
    try {
      await api.patch(`/api/admin/integrations/clinics/${clinic.id}`, { whatsapp_waba_id: value.trim() || null });
      toast.success(`${clinic.name}: WABA ID saved`);
      setEditing(false);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
    }
  }

  if (!editing) {
    return (
      <button className="text-left text-sm text-foreground hover:underline" onClick={() => setEditing(true)}>
        {clinic.whatsapp_waba_id || <span className="text-muted-foreground">Add</span>}
      </button>
    );
  }
  return (
    <div className="flex gap-1.5">
      <Input value={value} onChange={(e) => setValue(e.target.value)} className="h-8 w-40" placeholder="Digits only" autoFocus />
      <Button size="sm" onClick={save}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </div>
  );
}

const TEMPLATE_TONE: Record<string, 'green' | 'amber' | 'red' | 'grey'> = {
  APPROVED: 'green',
  PENDING: 'amber',
  IN_APPEAL: 'amber',
  REJECTED: 'red',
  PAUSED: 'red',
  DISABLED: 'red',
};

export default function Integrations() {
  const [data, setData] = useState<IntegrationsData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  function load() {
    setError(null);
    api
      .get<{ data: IntegrationsData }>('/api/admin/integrations')
      .then((r) => setData(r.data))
      .catch(setError);
  }
  useEffect(load, []);

  async function test(p: Provider) {
    setTesting(p.id);
    try {
      const r = await api.post<{ data: { ok: boolean; message: string } }>(`/api/admin/integrations/${p.id}/test`);
      if (r.data.ok) toast.success(r.data.message);
      else toast.error(`${p.label}: ${r.data.message}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setTesting(null);
    }
  }

  async function syncTemplates() {
    setSyncing(true);
    try {
      const r = await api.post<{ data: { targets: number; results: { ok: boolean; count?: number; error?: string }[] } }>('/api/admin/integrations/templates/sync');
      if (r.data.targets === 0) toast.error('No WhatsApp Business Account ID set. Add the platform WABA ID or a hospital WABA ID first.');
      else {
        const failed = r.data.results.filter((x) => !x.ok);
        if (failed.length) toast.error(`${failed.length} of ${r.data.targets} account(s) failed: ${failed[0].error}`);
        else toast.success(`Synced ${r.data.results.reduce((a, x) => a + (x.count ?? 0), 0)} template(s)`);
      }
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  const clinicName = (scope: string) => (scope === 'global' ? 'Platform default' : data?.clinics.find((c) => c.id === scope)?.name ?? scope);

  return (
    <AppShell title="Integrations" description="WhatsApp, Twilio and ABDM keys, each hospital's WhatsApp setup, and WhatsApp template approval status.">
      <ProviderSheet provider={editing} onOpenChange={(v) => !v && setEditing(null)} onSaved={load} />
      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : !data ? (
        <LoadingState rows={4} />
      ) : (
        <div className="space-y-6">
          {!data.encryption_key_set && (
            <p className="rounded-lg border border-warning-border bg-warning-surface px-4 py-3 text-sm text-warning-foreground">
              <code>INTEGRATIONS_ENCRYPTION_KEY</code> is not set on the server, so saved keys are encrypted with a key
              derived from <code>JWT_SECRET</code>. Set a dedicated key before saving production secrets here.
            </p>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            {data.providers.map((p) => (
              <section key={p.id} className="flex flex-col rounded-xl border border-border bg-card p-5">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-display text-base font-semibold text-foreground">{p.label}</h2>
                  {p.configured ? (
                    <Pill tone="green">
                      <CheckCircle2 className="mr-1 size-3.5" /> Configured
                    </Pill>
                  ) : (
                    <Pill>
                      <CircleDashed className="mr-1 size-3.5" /> Not configured
                    </Pill>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>
                <dl className="mt-4 flex-1 space-y-1.5 text-xs">
                  {p.fields.map((f) => (
                    <div key={f.key} className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">{f.label}</dt>
                      <dd className={`truncate font-mono ${f.source === 'missing' ? 'text-muted-foreground' : 'text-foreground'}`} title={SOURCE_LABEL[f.source]}>
                        {f.value ?? '—'}
                        {f.source === 'console' && <span className="ml-1 font-sans text-primary">•</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-4 flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditing(p)}>
                    Edit keys
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => test(p)} disabled={!p.configured || testing === p.id}>
                    <PlugZap className="mr-1 size-3.5" />
                    {testing === p.id ? 'Testing…' : 'Test'}
                  </Button>
                </div>
              </section>
            ))}
          </div>
          <p className="-mt-3 text-xs text-muted-foreground">
            <span className="text-primary">•</span> = value saved in this console (overrides server env).
          </p>

          <Section title="Hospital WhatsApp numbers" description="Each hospital's own WhatsApp credentials. Number and token are edited on the Hospitals page; add the WABA ID here to read template status.">
            <Table head={['Hospital', 'Number', 'Phone number ID', 'Access token', 'WABA ID']}>
              {data.clinics.map((c) => (
                <tr key={c.id}>
                  <td className={`${td} font-medium text-foreground`}>{c.name}</td>
                  <td className={`${td} font-mono text-xs`}>{c.whatsapp_number}</td>
                  <td className={`${td} font-mono text-xs`}>{c.whatsapp_phone_number_id || <Pill tone="red">Missing</Pill>}</td>
                  <td className={td}>{c.has_access_token ? <Pill tone="green">Own token</Pill> : <Pill>Uses platform token</Pill>}</td>
                  <td className={td}>
                    <WabaCell clinic={c} onSaved={load} />
                  </td>
                </tr>
              ))}
            </Table>
          </Section>

          <Section
            title="WhatsApp templates"
            description="Business-initiated messages (check-ins, refill reminders) only send with an APPROVED template."
            actions={
              <Button size="sm" variant="outline" onClick={syncTemplates} disabled={syncing}>
                <RefreshCw className={`mr-1.5 size-3.5 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? 'Syncing…' : 'Sync from Meta'}
              </Button>
            }
          >
            {data.templates.length === 0 ? (
              <p className="text-sm text-muted-foreground">No templates synced yet. Add a WABA ID, then click “Sync from Meta”.</p>
            ) : (
              <Table head={['Account', 'Template', 'Language', 'Category', 'Status', 'Synced']}>
                {data.templates.map((t) => (
                  <tr key={`${t.scope}-${t.name}-${t.language}`}>
                    <td className={td}>{clinicName(t.scope)}</td>
                    <td className={`${td} font-mono text-xs`}>{t.name}</td>
                    <td className={td}>{t.language}</td>
                    <td className={`${td} text-muted-foreground`}>{t.category ?? '—'}</td>
                    <td className={td}>
                      <Pill tone={TEMPLATE_TONE[t.status] ?? 'grey'}>{t.status}</Pill>
                      {t.rejected_reason && <span className="ml-2 text-xs text-destructive">{t.rejected_reason}</span>}
                    </td>
                    <td className={`${td} text-muted-foreground`}>{formatDateTime(t.synced_at)}</td>
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
