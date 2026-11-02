import { useEffect, useState, type FormEvent } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/app-shell';
import { ErrorState, LoadingState } from '@/components/app/states';
import { Section, Stat, Table } from '@/components/app/admin-ui';
import { formatINR, td } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/lib/api';

interface HospitalUsage {
  clinic_id: string;
  clinic_name: string;
  clinic_status: string;
  wa_checkins: number;
  wa_other_outbound: number;
  wa_inbound: number;
  ai_replies: number;
  voice_calls: number;
  ocr_documents: number;
  revenue_inr: number;
  plan_price_inr: number;
  cost_inr: number;
  margin_inr: number;
  margin_pct: number | null;
}
interface UsageData {
  month: string;
  costs_configured: boolean;
  totals: { cost_inr: number; revenue_inr: number; margin_inr: number };
  hospitals: HospitalUsage[];
}
interface UnitCosts {
  values: Record<string, number>;
  labels: Record<string, string>;
}

function UnitCostSheet({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const [data, setData] = useState<UnitCosts | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.get<{ data: UnitCosts }>('/api/admin/unit-costs').then((r) => {
      setData(r.data);
      setForm(Object.fromEntries(Object.entries(r.data.values).map(([k, v]) => [k, String(v)])));
    });
  }, [open]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put('/api/admin/unit-costs', Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Number(v || 0)])));
      toast.success('Unit costs saved');
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Unit costs</SheetTitle>
        </SheetHeader>
        {!data ? (
          <LoadingState rows={3} />
        ) : (
          <form onSubmit={onSubmit} className="mt-6 space-y-5 px-1">
            <p className="text-sm text-muted-foreground">
              What each unit costs you, in ₹. Take these from your Meta, Anthropic, Twilio and hosting bills; they are
              multiplied by each hospital's usage to estimate cost.
            </p>
            {Object.entries(data.labels).map(([k, label]) => (
              <div key={k} className="space-y-2">
                <Label htmlFor={k}>{label}</Label>
                <Input id={k} type="number" min="0" step="0.0001" value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
              </div>
            ))}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </form>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default function Usage() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [costsOpen, setCostsOpen] = useState(false);

  function load() {
    setError(null);
    setData(null);
    api
      .get<{ data: UsageData }>(`/api/admin/usage?month=${month}`)
      .then((r) => setData(r.data))
      .catch(setError);
  }
  useEffect(load, [month]);

  return (
    <AppShell
      title="Usage & Profit"
      description="Per-hospital usage, estimated cost, revenue received and margin for the month."
      actions={
        <div className="flex items-center gap-2">
          <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-40" aria-label="Month" />
          <Button variant="outline" onClick={() => setCostsOpen(true)}>
            <SlidersHorizontal className="mr-1.5 size-4" />
            Unit costs
          </Button>
        </div>
      }
    >
      <UnitCostSheet open={costsOpen} onOpenChange={setCostsOpen} onSaved={load} />
      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : !data ? (
        <LoadingState rows={4} />
      ) : (
        <div className="space-y-6">
          {!data.costs_configured && (
            <p className="rounded-lg border border-warning-border bg-warning-surface px-4 py-3 text-sm text-warning-foreground">
              Unit costs are not set yet, so every cost below shows ₹0. Click <strong>Unit costs</strong> to enter them.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Revenue received" value={formatINR(data.totals.revenue_inr)} hint="Payments recorded this month" />
            <Stat label="Estimated cost" value={formatINR(data.totals.cost_inr)} />
            <Stat label="Margin" value={formatINR(data.totals.margin_inr)} tone={data.totals.margin_inr < 0 ? 'danger' : 'success'} />
          </div>

          <Section
            title="By hospital"
            description="Counts come from logged messages, calls and documents. AI replies are estimated from inbound patient messages."
          >
            <Table head={['Hospital', 'Check-ins', 'Other WA out', 'WA in', 'AI replies', 'OCR docs', 'Calls', 'Cost', 'Revenue', 'Margin']}>
              {data.hospitals.map((h) => (
                <tr key={h.clinic_id}>
                  <td className={`${td} font-medium text-foreground`}>
                    {h.clinic_name}
                    {h.clinic_status === 'suspended' && <span className="ml-2 text-xs text-destructive">suspended</span>}
                  </td>
                  <td className={td}>{h.wa_checkins}</td>
                  <td className={td}>{h.wa_other_outbound}</td>
                  <td className={`${td} text-muted-foreground`}>{h.wa_inbound}</td>
                  <td className={td}>{h.ai_replies}</td>
                  <td className={td}>{h.ocr_documents}</td>
                  <td className={td}>{h.voice_calls}</td>
                  <td className={td}>{formatINR(h.cost_inr)}</td>
                  <td className={td}>{formatINR(h.revenue_inr)}</td>
                  <td className={`${td} font-medium ${h.margin_inr < 0 ? 'text-destructive' : 'text-foreground'}`}>
                    {formatINR(h.margin_inr)}
                    {h.margin_pct !== null && <span className="ml-1 text-xs text-muted-foreground">({h.margin_pct}%)</span>}
                  </td>
                </tr>
              ))}
            </Table>
          </Section>
        </div>
      )}
    </AppShell>
  );
}
