import { useState, type FormEvent } from 'react';
import { Building2, PlusCircle } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/app-shell';
import { LoadingState, EmptyState, ErrorState } from '@/components/app/states';
import { useClinicSwitcher, type ClinicSummary } from '@/context/ClinicContext';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

const STATUS_LABEL: Record<ClinicSummary['status'], string> = {
  active: 'Active',
  onboarding: 'Onboarding',
  suspended: 'Suspended',
};

const STATUS_TONE: Record<ClinicSummary['status'], string> = {
  active: 'bg-primary/10 text-primary',
  onboarding: 'bg-secondary text-secondary-foreground',
  suspended: 'bg-destructive/10 text-destructive',
};

const emptyForm = {
  name: '',
  address: '',
  whatsapp_number: '',
  whatsapp_phone_number_id: '',
  whatsapp_access_token: '',
  admin_name: '',
  admin_phone: '',
  admin_password: '',
};

function AddHospitalSheet({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: () => void;
}) {
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const update =
    (key: keyof typeof emptyForm) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/clinics', form);
      toast.success(`${form.name} onboarded — status: onboarding`);
      setForm(emptyForm);
      onOpenChange(false);
      onAdded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to add hospital');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Add hospital</SheetTitle>
        </SheetHeader>
        <form onSubmit={onSubmit} className="mt-6 space-y-5 px-1">
          <div className="space-y-2">
            <Label htmlFor="cName">Hospital name</Label>
            <Input id="cName" required value={form.name} onChange={update('name')} placeholder="City Care Clinic" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cAddress">Address</Label>
            <Input id="cAddress" value={form.address} onChange={update('address')} placeholder="123 MG Road, Chandigarh" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cWaNumber">WhatsApp number</Label>
            <Input id="cWaNumber" required value={form.whatsapp_number} onChange={update('whatsapp_number')} placeholder="+919876543210" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cWaId">WhatsApp phone_number_id</Label>
            <Input id="cWaId" value={form.whatsapp_phone_number_id} onChange={update('whatsapp_phone_number_id')} placeholder="From Meta Business Manager" />
            <p className="text-xs text-muted-foreground">
              Registered in Meta Business Manager separately (Super Admin spec, Part B) — paste it here once you have it.
              Leave blank to onboard first and fill it in later via Edit.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cWaToken">WhatsApp access token</Label>
            <Input id="cWaToken" type="password" value={form.whatsapp_access_token} onChange={update('whatsapp_access_token')} placeholder="Optional for now" />
          </div>
          <div className="border-t border-border pt-4">
            <p className="text-sm font-medium text-foreground">First admin account</p>
            <p className="mt-1 text-xs text-muted-foreground">Created in the same step so the hospital can log in immediately.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cAdminName">Admin name</Label>
            <Input id="cAdminName" required value={form.admin_name} onChange={update('admin_name')} placeholder="Dr. Priya Mehta" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cAdminPhone">Admin phone</Label>
            <Input id="cAdminPhone" required value={form.admin_phone} onChange={update('admin_phone')} placeholder="9876543210" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cAdminPassword">Temporary password</Label>
            <Input id="cAdminPassword" type="password" required value={form.admin_password} onChange={update('admin_password')} placeholder="Min 8 characters" />
          </div>
          {err ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p> : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Onboarding…' : 'Add hospital'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export default function SuperAdminClinics() {
  const { clinics, loading, refresh, selectedClinicId, setSelectedClinicId } = useClinicSwitcher();
  const [addOpen, setAddOpen] = useState(false);
  const [error] = useState<unknown>(null);

  async function toggleSuspend(clinic: ClinicSummary) {
    const nextStatus = clinic.status === 'suspended' ? 'active' : 'suspended';
    try {
      await api.patch(`/api/clinics/${clinic.id}`, { status: nextStatus });
      toast.success(`${clinic.name} is now ${STATUS_LABEL[nextStatus as ClinicSummary['status']].toLowerCase()}`);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update hospital status');
    }
  }

  return (
    <AppShell
      title="Hospitals"
      description="Every hospital on Sehat Saathi — onboard a new one, suspend one, or switch which hospital's data the rest of the console shows."
      actions={
        <Button onClick={() => setAddOpen(true)}>
          <PlusCircle className="mr-1.5 size-4" />
          Add hospital
        </Button>
      }
    >
      <AddHospitalSheet open={addOpen} onOpenChange={setAddOpen} onAdded={refresh} />

      {loading ? (
        <LoadingState rows={3} label="Loading hospitals…" />
      ) : error ? (
        <ErrorState error={error} />
      ) : clinics.length === 0 ? (
        <EmptyState
          icon={<Building2 className="size-6" aria-hidden />}
          title="No hospitals yet"
          description='Click "Add hospital" to onboard the first one.'
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-medium">Hospital</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Patients</th>
                <th className="px-5 py-3 font-medium">Open flags</th>
                <th className="px-5 py-3 font-medium">Doctors</th>
                <th className="px-5 py-3 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {clinics.map((c) => (
                <tr key={c.id} className={c.id === selectedClinicId ? 'bg-primary/5' : undefined}>
                  <td className="px-5 py-3">
                    <button
                      onClick={() => setSelectedClinicId(c.id)}
                      className="text-left font-medium text-foreground hover:underline"
                      title="View this hospital's data across the rest of the console"
                    >
                      {c.name}
                    </button>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_TONE[c.status]}`}>
                      {STATUS_LABEL[c.status]}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">{c.patient_count}</td>
                  <td className="px-5 py-3 text-muted-foreground">{c.open_flag_count}</td>
                  <td className="px-5 py-3 text-muted-foreground">{c.doctor_count}</td>
                  <td className="px-5 py-3 text-right">
                    <Button variant="outline" size="sm" onClick={() => toggleSuspend(c)}>
                      {c.status === 'suspended' ? 'Reactivate' : 'Suspend'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
