import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { PlusCircle, Receipt, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/app-shell';
import { ErrorState, LoadingState } from '@/components/app/states';
import { Pill, Section, Select, Table } from '@/components/app/admin-ui';
import { formatDate, formatINR, td } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';

interface Plan {
  id: string;
  name: string;
  price_monthly_inr: number;
  patient_limit: number | null;
  features: string | null;
  active: boolean;
  hospital_count: number;
}
type SubStatus = 'trial' | 'active' | 'past_due' | 'cancelled';
interface Subscription {
  clinic_id: string;
  clinic_name: string;
  clinic_status: string;
  id: string | null;
  plan_id: string | null;
  plan_name: string | null;
  status: SubStatus | null;
  price_override_inr: number | null;
  effective_price_inr: number;
  trial_ends_at: string | null;
  patient_count: number;
  patient_limit: number | null;
}
interface Invoice {
  id: string;
  clinic_id: string;
  clinic_name: string;
  invoice_number: string;
  amount_inr: number;
  paid_inr: number;
  period_start: string | null;
  period_end: string | null;
  due_date: string | null;
  status: 'draft' | 'sent' | 'paid' | 'void';
  is_overdue: boolean;
  notes: string | null;
}
interface Payment {
  id: string;
  clinic_name: string;
  invoice_number: string | null;
  amount_inr: number;
  method: string | null;
  reference: string | null;
  paid_at: string;
  recorded_by_name: string | null;
}

const SUB_LABEL: Record<SubStatus, string> = { trial: 'Trial', active: 'Active', past_due: 'Past due', cancelled: 'Cancelled' };
const SUB_TONE = { trial: 'amber', active: 'green', past_due: 'red', cancelled: 'grey' } as const;

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong';
}

// ---------------------------------------------------------------- Plans
function PlanSheet({ plan, open, onOpenChange, onSaved }: { plan: Plan | null; open: boolean; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', price_monthly_inr: '', patient_limit: '', features: '', active: true });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({
      name: plan?.name ?? '',
      price_monthly_inr: plan ? String(plan.price_monthly_inr) : '',
      patient_limit: plan?.patient_limit ? String(plan.patient_limit) : '',
      features: plan?.features ?? '',
      active: plan?.active ?? true,
    });
  }, [plan, open]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { ...form, price_monthly_inr: Number(form.price_monthly_inr || 0), patient_limit: form.patient_limit || null };
      if (plan) await api.patch(`/api/admin/plans/${plan.id}`, body);
      else await api.post('/api/admin/plans', body);
      toast.success(plan ? 'Plan updated' : 'Plan created');
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{plan ? `Edit ${plan.name}` : 'New plan'}</SheetTitle>
        </SheetHeader>
        <form onSubmit={onSubmit} className="mt-6 space-y-5 px-1">
          <div className="space-y-2">
            <Label htmlFor="pName">Name</Label>
            <Input id="pName" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Growth" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pPrice">Price per month (₹)</Label>
            <Input id="pPrice" type="number" min="0" step="0.01" required value={form.price_monthly_inr} onChange={(e) => setForm({ ...form, price_monthly_inr: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pLimit">Patient limit</Label>
            <Input id="pLimit" type="number" min="1" value={form.patient_limit} onChange={(e) => setForm({ ...form, patient_limit: e.target.value })} placeholder="Leave empty for unlimited" />
            <p className="text-xs text-muted-foreground">Shown against each hospital's patient count. Not enforced automatically yet.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pFeatures">What's included</Label>
            <Input id="pFeatures" value={form.features} onChange={(e) => setForm({ ...form, features: e.target.value })} placeholder="WhatsApp check-ins, OCR, voice calls" />
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            Available for new subscriptions
          </label>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Saving…' : 'Save plan'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Subscription
function SubscriptionSheet({ sub, plans, onOpenChange, onSaved }: { sub: Subscription | null; plans: Plan[]; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const [form, setForm] = useState({ plan_id: '', status: 'trial' as SubStatus, trial_days: '14', trial_ends_at: '', price_override_inr: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!sub) return;
    setForm({
      plan_id: sub.plan_id ?? plans.find((p) => p.active)?.id ?? '',
      status: sub.status ?? 'trial',
      trial_days: '14',
      trial_ends_at: sub.trial_ends_at ? sub.trial_ends_at.slice(0, 10) : '',
      price_override_inr: sub.price_override_inr === null ? '' : String(sub.price_override_inr),
    });
  }, [sub, plans]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!sub) return;
    setBusy(true);
    try {
      await api.put(`/api/admin/subscriptions/${sub.clinic_id}`, {
        plan_id: form.plan_id || null,
        status: form.status,
        trial_ends_at: form.status === 'trial' && form.trial_ends_at ? `${form.trial_ends_at}T23:59:59` : undefined,
        trial_days: form.status === 'trial' && !form.trial_ends_at ? Number(form.trial_days) : undefined,
        price_override_inr: form.price_override_inr === '' ? null : Number(form.price_override_inr),
      });
      toast.success(`${sub.clinic_name}: subscription saved`);
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={!!sub} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{sub?.clinic_name} — plan</SheetTitle>
        </SheetHeader>
        <form onSubmit={onSubmit} className="mt-6 space-y-5 px-1">
          <div className="space-y-2">
            <Label htmlFor="sPlan">Plan</Label>
            <Select id="sPlan" value={form.plan_id} onChange={(e) => setForm({ ...form, plan_id: e.target.value })}>
              <option value="">— none —</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.active && p.id !== sub?.plan_id}>
                  {p.name} · {formatINR(p.price_monthly_inr)}/mo{p.active ? '' : ' (retired)'}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sStatus">Status</Label>
            <Select id="sStatus" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as SubStatus })}>
              {Object.entries(SUB_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
          {form.status === 'trial' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="sDays">Trial length (days)</Label>
                <Input id="sDays" type="number" min="1" max="365" value={form.trial_days} disabled={!!form.trial_ends_at} onChange={(e) => setForm({ ...form, trial_days: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sEnds">or ends on</Label>
                <Input id="sEnds" type="date" value={form.trial_ends_at} onChange={(e) => setForm({ ...form, trial_ends_at: e.target.value })} />
              </div>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="sOverride">Custom monthly price (₹)</Label>
            <Input id="sOverride" type="number" min="0" step="0.01" value={form.price_override_inr} onChange={(e) => setForm({ ...form, price_override_inr: e.target.value })} placeholder="Leave empty to use the plan price" />
          </div>
          <p className="text-xs text-muted-foreground">Only Active and Past due count towards MRR. Trials count as zero.</p>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Invoice
function InvoiceSheet({ open, onOpenChange, subs, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; subs: Subscription[]; onSaved: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const empty = { clinic_id: '', amount_inr: '', period_start: '', period_end: '', due_date: '', notes: '', status: 'sent' };
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setForm({ ...empty, due_date: new Date(Date.now() + 15 * 86400_000).toISOString().slice(0, 10) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function pickClinic(id: string) {
    const s = subs.find((x) => x.clinic_id === id);
    setForm((f) => ({ ...f, clinic_id: id, amount_inr: s?.effective_price_inr ? String(s.effective_price_inr) : f.amount_inr }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/admin/invoices', { ...form, amount_inr: Number(form.amount_inr) });
      toast.success('Invoice created');
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>New invoice</SheetTitle>
        </SheetHeader>
        <form onSubmit={onSubmit} className="mt-6 space-y-5 px-1">
          <div className="space-y-2">
            <Label htmlFor="iClinic">Hospital</Label>
            <Select id="iClinic" required value={form.clinic_id} onChange={(e) => pickClinic(e.target.value)}>
              <option value="">Select…</option>
              {subs.map((s) => (
                <option key={s.clinic_id} value={s.clinic_id}>
                  {s.clinic_name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="iAmount">Amount (₹)</Label>
            <Input id="iAmount" type="number" min="0" step="0.01" required value={form.amount_inr} onChange={(e) => setForm({ ...form, amount_inr: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="iFrom">Period from</Label>
              <Input id="iFrom" type="date" value={form.period_start} onChange={(e) => setForm({ ...form, period_start: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="iTo">to</Label>
              <Input id="iTo" type="date" value={form.period_end} onChange={(e) => setForm({ ...form, period_end: e.target.value })} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="iDue">Due date</Label>
            <Input id="iDue" type="date" min={today} value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="iNotes">Notes</Label>
            <Input id="iNotes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={form.status === 'draft'} onChange={(e) => setForm({ ...form, status: e.target.checked ? 'draft' : 'sent' })} />
            Save as draft (not yet sent to the hospital)
          </label>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Creating…' : 'Create invoice'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Payment
function PaymentSheet({ open, onOpenChange, subs, invoices, preset, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; subs: Subscription[]; invoices: Invoice[]; preset: Invoice | null; onSaved: () => void }) {
  const [form, setForm] = useState({ clinic_id: '', invoice_id: '', amount_inr: '', method: 'UPI', reference: '', paid_at: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({
      clinic_id: preset?.clinic_id ?? '',
      invoice_id: preset?.id ?? '',
      amount_inr: preset ? String(Math.max(preset.amount_inr - preset.paid_inr, 0)) : '',
      method: 'UPI',
      reference: '',
      paid_at: new Date().toISOString().slice(0, 10),
    });
  }, [open, preset]);

  const openInvoices = invoices.filter((i) => i.clinic_id === form.clinic_id && (i.status === 'sent' || i.status === 'draft'));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/admin/payments', {
        ...form,
        invoice_id: form.invoice_id || null,
        amount_inr: Number(form.amount_inr),
        paid_at: form.paid_at ? `${form.paid_at}T12:00:00` : undefined,
      });
      toast.success('Payment recorded');
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Record payment</SheetTitle>
        </SheetHeader>
        <form onSubmit={onSubmit} className="mt-6 space-y-5 px-1">
          <div className="space-y-2">
            <Label htmlFor="yClinic">Hospital</Label>
            <Select id="yClinic" required value={form.clinic_id} onChange={(e) => setForm({ ...form, clinic_id: e.target.value, invoice_id: '' })}>
              <option value="">Select…</option>
              {subs.map((s) => (
                <option key={s.clinic_id} value={s.clinic_id}>
                  {s.clinic_name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="yInvoice">Against invoice</Label>
            <Select id="yInvoice" value={form.invoice_id} onChange={(e) => {
              const inv = invoices.find((i) => i.id === e.target.value);
              setForm({ ...form, invoice_id: e.target.value, amount_inr: inv ? String(Math.max(inv.amount_inr - inv.paid_inr, 0)) : form.amount_inr });
            }}>
              <option value="">— no invoice —</option>
              {openInvoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.invoice_number} · {formatINR(i.amount_inr - i.paid_inr)} due
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">The invoice is marked paid automatically once payments cover it.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="yAmount">Amount (₹)</Label>
            <Input id="yAmount" type="number" min="0.01" step="0.01" required value={form.amount_inr} onChange={(e) => setForm({ ...form, amount_inr: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="yMethod">Method</Label>
              <Select id="yMethod" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
                {['UPI', 'Bank transfer', 'Cheque', 'Cash', 'Card', 'Other'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="yDate">Received on</Label>
              <Input id="yDate" type="date" value={form.paid_at} onChange={(e) => setForm({ ...form, paid_at: e.target.value })} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="yRef">Reference / UTR</Label>
            <Input id="yRef" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Saving…' : 'Record payment'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Page
export default function Billing() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const [planSheet, setPlanSheet] = useState<{ open: boolean; plan: Plan | null }>({ open: false, plan: null });
  const [subSheet, setSubSheet] = useState<Subscription | null>(null);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [paymentSheet, setPaymentSheet] = useState<{ open: boolean; preset: Invoice | null }>({ open: false, preset: null });
  const [invoiceFilter, setInvoiceFilter] = useState('');

  function load() {
    setError(null);
    Promise.all([
      api.get<{ data: Plan[] }>('/api/admin/plans').then((r) => setPlans(r.data)),
      api.get<{ data: Subscription[] }>('/api/admin/subscriptions').then((r) => setSubs(r.data)),
      api.get<{ data: Invoice[] }>('/api/admin/invoices').then((r) => setInvoices(r.data)),
      api.get<{ data: Payment[] }>('/api/admin/payments').then((r) => setPayments(r.data)),
    ]).catch(setError);
  }
  useEffect(load, []);

  const shownInvoices = useMemo(() => {
    if (!invoices) return [];
    if (invoiceFilter === 'overdue') return invoices.filter((i) => i.is_overdue);
    if (invoiceFilter) return invoices.filter((i) => i.status === invoiceFilter);
    return invoices;
  }, [invoices, invoiceFilter]);

  async function setInvoiceStatus(inv: Invoice, status: Invoice['status']) {
    try {
      await api.patch(`/api/admin/invoices/${inv.id}`, { status });
      toast.success(`${inv.invoice_number} marked ${status}`);
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  const loading = !plans || !subs || !invoices || !payments;

  return (
    <AppShell title="Plans & Billing" description="Plans, each hospital's subscription or trial, invoices and payments received.">
      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : loading ? (
        <LoadingState rows={4} />
      ) : (
        <>
          <PlanSheet open={planSheet.open} plan={planSheet.plan} onOpenChange={(v) => setPlanSheet((s) => ({ ...s, open: v }))} onSaved={load} />
          <SubscriptionSheet sub={subSheet} plans={plans} onOpenChange={(v) => !v && setSubSheet(null)} onSaved={load} />
          <InvoiceSheet open={invoiceOpen} onOpenChange={setInvoiceOpen} subs={subs} onSaved={load} />
          <PaymentSheet
            open={paymentSheet.open}
            preset={paymentSheet.preset}
            onOpenChange={(v) => setPaymentSheet((s) => ({ ...s, open: v }))}
            subs={subs}
            invoices={invoices}
            onSaved={load}
          />

          <Tabs defaultValue="subscriptions">
            <TabsList>
              <TabsTrigger value="subscriptions">Hospitals & trials</TabsTrigger>
              <TabsTrigger value="invoices">Invoices</TabsTrigger>
              <TabsTrigger value="payments">Payments</TabsTrigger>
              <TabsTrigger value="plans">Plans</TabsTrigger>
            </TabsList>

            <TabsContent value="subscriptions" className="mt-6">
              <Section title="Hospital subscriptions" description="Which plan each hospital is on, trials and their end dates.">
                <Table head={['Hospital', 'Plan', 'Status', 'Monthly', 'Trial ends', 'Patients', '']}>
                  {subs.map((s) => {
                    const trialOver = s.status === 'trial' && s.trial_ends_at && new Date(s.trial_ends_at) < new Date();
                    const overLimit = s.patient_limit !== null && s.patient_count > s.patient_limit;
                    return (
                      <tr key={s.clinic_id}>
                        <td className={`${td} font-medium text-foreground`}>
                          {s.clinic_name}
                          {s.clinic_status === 'suspended' && <span className="ml-2 text-xs text-destructive">suspended</span>}
                        </td>
                        <td className={td}>{s.plan_name ?? <span className="text-muted-foreground">—</span>}</td>
                        <td className={td}>{s.status ? <Pill tone={SUB_TONE[s.status]}>{SUB_LABEL[s.status]}</Pill> : <Pill tone="amber">No plan</Pill>}</td>
                        <td className={td}>
                          {s.status ? formatINR(s.effective_price_inr) : '—'}
                          {s.price_override_inr !== null && <span className="ml-1 text-xs text-muted-foreground">(custom)</span>}
                        </td>
                        <td className={`${td} ${trialOver ? 'text-destructive' : ''}`}>{s.status === 'trial' ? formatDate(s.trial_ends_at) : '—'}</td>
                        <td className={`${td} ${overLimit ? 'text-destructive' : 'text-muted-foreground'}`}>
                          {s.patient_count}
                          {s.patient_limit ? ` / ${s.patient_limit}` : ''}
                        </td>
                        <td className={`${td} text-right`}>
                          <Button variant="outline" size="sm" onClick={() => setSubSheet(s)} disabled={plans.length === 0} title={plans.length === 0 ? 'Create a plan first' : undefined}>
                            {s.status ? 'Change' : 'Assign plan'}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </Table>
                {plans.length === 0 && <p className="mt-3 text-sm text-muted-foreground">Create a plan in the Plans tab before assigning one.</p>}
              </Section>
            </TabsContent>

            <TabsContent value="invoices" className="mt-6">
              <Section
                title="Invoices"
                actions={
                  <div className="flex items-center gap-2">
                    <Select value={invoiceFilter} onChange={(e) => setInvoiceFilter(e.target.value)} className="w-36" aria-label="Filter invoices">
                      <option value="">All</option>
                      <option value="overdue">Overdue</option>
                      <option value="sent">Sent</option>
                      <option value="draft">Draft</option>
                      <option value="paid">Paid</option>
                      <option value="void">Void</option>
                    </Select>
                    <Button size="sm" onClick={() => setInvoiceOpen(true)}>
                      <Receipt className="mr-1.5 size-3.5" />
                      New invoice
                    </Button>
                  </div>
                }
              >
                {shownInvoices.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No invoices{invoiceFilter ? ' with this status' : ' yet'}.</p>
                ) : (
                  <Table head={['Number', 'Hospital', 'Amount', 'Paid', 'Period', 'Due', 'Status', '']}>
                    {shownInvoices.map((i) => (
                      <tr key={i.id}>
                        <td className={`${td} font-mono text-xs`}>{i.invoice_number}</td>
                        <td className={td}>{i.clinic_name}</td>
                        <td className={td}>{formatINR(i.amount_inr)}</td>
                        <td className={`${td} text-muted-foreground`}>{formatINR(i.paid_inr)}</td>
                        <td className={`${td} text-muted-foreground`}>
                          {i.period_start ? `${formatDate(i.period_start)} – ${formatDate(i.period_end)}` : '—'}
                        </td>
                        <td className={`${td} ${i.is_overdue ? 'text-destructive' : ''}`}>{formatDate(i.due_date)}</td>
                        <td className={td}>
                          {i.is_overdue ? (
                            <Pill tone="red">Overdue</Pill>
                          ) : (
                            <Pill tone={i.status === 'paid' ? 'green' : i.status === 'void' ? 'grey' : 'amber'}>{i.status}</Pill>
                          )}
                        </td>
                        <td className={`${td} text-right`}>
                          <div className="flex justify-end gap-2">
                            {(i.status === 'sent' || i.status === 'draft') && (
                              <Button variant="outline" size="sm" onClick={() => setPaymentSheet({ open: true, preset: i })}>
                                Record payment
                              </Button>
                            )}
                            {i.status === 'draft' && (
                              <Button variant="outline" size="sm" onClick={() => setInvoiceStatus(i, 'sent')}>
                                Mark sent
                              </Button>
                            )}
                            {i.status !== 'void' && i.status !== 'paid' && (
                              <Button variant="ghost" size="sm" onClick={() => setInvoiceStatus(i, 'void')}>
                                Void
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Section>
            </TabsContent>

            <TabsContent value="payments" className="mt-6">
              <Section
                title="Payments received"
                description="Recorded manually — no payment gateway is connected yet."
                actions={
                  <Button size="sm" onClick={() => setPaymentSheet({ open: true, preset: null })}>
                    <Wallet className="mr-1.5 size-3.5" />
                    Record payment
                  </Button>
                }
              >
                {payments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No payments recorded yet.</p>
                ) : (
                  <Table head={['Date', 'Hospital', 'Amount', 'Invoice', 'Method', 'Reference', 'Recorded by']}>
                    {payments.map((p) => (
                      <tr key={p.id}>
                        <td className={td}>{formatDate(p.paid_at)}</td>
                        <td className={td}>{p.clinic_name}</td>
                        <td className={`${td} font-medium`}>{formatINR(p.amount_inr)}</td>
                        <td className={`${td} font-mono text-xs`}>{p.invoice_number ?? '—'}</td>
                        <td className={td}>{p.method ?? '—'}</td>
                        <td className={`${td} text-muted-foreground`}>{p.reference ?? '—'}</td>
                        <td className={`${td} text-muted-foreground`}>{p.recorded_by_name ?? '—'}</td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Section>
            </TabsContent>

            <TabsContent value="plans" className="mt-6">
              <Section
                title="Plans"
                actions={
                  <Button size="sm" onClick={() => setPlanSheet({ open: true, plan: null })}>
                    <PlusCircle className="mr-1.5 size-3.5" />
                    New plan
                  </Button>
                }
              >
                {plans.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No plans yet. Create one to start assigning hospitals.</p>
                ) : (
                  <Table head={['Plan', 'Monthly', 'Patient limit', 'Included', 'Hospitals', 'Status', '']}>
                    {plans.map((p) => (
                      <tr key={p.id}>
                        <td className={`${td} font-medium text-foreground`}>{p.name}</td>
                        <td className={td}>{formatINR(p.price_monthly_inr)}</td>
                        <td className={td}>{p.patient_limit ?? 'Unlimited'}</td>
                        <td className={`${td} text-muted-foreground`}>{p.features ?? '—'}</td>
                        <td className={td}>{p.hospital_count}</td>
                        <td className={td}>{p.active ? <Pill tone="green">Available</Pill> : <Pill>Retired</Pill>}</td>
                        <td className={`${td} text-right`}>
                          <Button variant="outline" size="sm" onClick={() => setPlanSheet({ open: true, plan: p })}>
                            Edit
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Section>
            </TabsContent>
          </Tabs>
        </>
      )}
    </AppShell>
  );
}
