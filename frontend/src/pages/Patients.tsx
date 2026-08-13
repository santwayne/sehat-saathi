import { useEffect, useMemo, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/app-shell';
import { ErrorState, LoadingState } from '@/components/app/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface PatientRow {
  id: string;
  name: string;
  phone: string;
  language_pref: string;
  consent_given: boolean;
  kill_switch_active: boolean;
  doctor_name: string | null;
  created_at: string;
}

interface PatientDetail extends PatientRow {
  prescriptions: {
    id: string;
    created_at: string;
    ocr_confidence: string;
    verified_by_staff: boolean;
  }[];
  checkin_schedules: {
    id: string;
    frequency_days: number;
    next_checkin_at: string;
    active: boolean;
  }[];
  conversations: {
    id: string;
    direction: string;
    message_text: string;
    created_at: string;
  }[];
}

interface DoctorRow { id: string; name: string; }

const LANG_LABELS: Record<string, { label: string; className: string }> = {
  hi: { label: 'Hindi', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  pa: { label: 'Punjabi', className: 'bg-orange-50 text-orange-700 border-orange-200' },
  en: { label: 'English', className: 'bg-sky-50 text-sky-700 border-sky-200' },
};

function LanguageBadge({ lang }: { lang: string }) {
  const meta = LANG_LABELS[lang] ?? { label: lang.toUpperCase(), className: 'bg-secondary text-secondary-foreground border-border' };
  return (
    <span className={cn('inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium', meta.className)}>
      {meta.label}
    </span>
  );
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const emptyForm = { name: '', phone: '', language_pref: 'hi', assigned_doctor_id: '', consent_given: false };

function AddPatientSheet({
  open,
  onOpenChange,
  clinicId,
  doctors,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  clinicId: string;
  doctors: DoctorRow[];
  onAdded: (p: PatientRow) => void;
}) {
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);

  function update(key: keyof typeof emptyForm) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post<{ data: PatientRow }>('/api/patients', {
        clinic_id: clinicId,
        name: form.name,
        phone: form.phone,
        language_pref: form.language_pref,
        assigned_doctor_id: form.assigned_doctor_id || null,
        consent_given: form.consent_given,
      });
      onAdded(res.data);
      toast.success(`${form.name} enrolled successfully`);
      setForm(emptyForm);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to enroll patient');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Enroll new patient</SheetTitle>
          <SheetDescription>
            Patient must give verbal consent before being enrolled.
          </SheetDescription>
        </SheetHeader>
        <form onSubmit={onSubmit} className="mt-6 space-y-4 px-4 pb-6">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Full name</label>
            <Input required value={form.name} onChange={update('name')} placeholder="Rahul Sharma" />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">WhatsApp number</label>
            <Input required value={form.phone} onChange={update('phone')} placeholder="+919876543210" inputMode="tel" />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Language preference</label>
            <select
              value={form.language_pref}
              onChange={update('language_pref')}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="hi">Hindi</option>
              <option value="pa">Punjabi</option>
              <option value="en">English</option>
            </select>
          </div>
          {doctors.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Assigned doctor</label>
              <select
                value={form.assigned_doctor_id}
                onChange={update('assigned_doctor_id')}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">— None —</option>
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
          )}
          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border p-3">
            <input
              type="checkbox"
              checked={form.consent_given}
              onChange={(e) => setForm((f) => ({ ...f, consent_given: e.target.checked }))}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm">Patient has given verbal consent to receive WhatsApp messages</span>
          </label>
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Enrolling…' : 'Enroll patient'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function PatientDrawer({
  patient,
  open,
  onOpenChange,
  onKillSwitchChange,
}: {
  patient: PatientDetail | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onKillSwitchChange: (id: string, active: boolean) => void;
}) {
  const [killBusy, setKillBusy] = useState(false);

  if (!patient) return null;

  async function toggleKillSwitch() {
    if (!patient) return;
    const next = !patient.kill_switch_active;
    if (next && !confirm('This will stop all automated check-ins and AI replies to this patient immediately. Clinic staff will need to follow up manually. Continue?')) {
      return;
    }
    setKillBusy(true);
    try {
      await api.post(`/api/flags/patients/${patient.id}/kill-switch`, { active: next });
      onKillSwitchChange(patient.id, next);
      toast.success(next ? 'Automated messages stopped' : 'Automated messages resumed');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to toggle kill switch');
    } finally {
      setKillBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="text-2xl">{patient.name}</SheetTitle>
          <SheetDescription>
            {patient.phone} · {patient.doctor_name ?? 'No doctor assigned'}
          </SheetDescription>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <LanguageBadge lang={patient.language_pref} />
            <Badge variant={patient.consent_given ? 'secondary' : 'outline'}>
              {patient.consent_given ? 'Consent given' : 'No consent'}
            </Badge>
            {patient.kill_switch_active && (
              <Badge variant="destructive">Kill switch active</Badge>
            )}
          </div>
        </SheetHeader>

        <div className="grid grid-cols-2 gap-4 px-4 pb-4 text-sm">
          <div>
            <p className="text-muted-foreground">Enrolled</p>
            <p className="font-medium">{fmt(patient.created_at)}</p>
          </div>
        </div>

        <div className="px-4 pb-4">
          <button
            onClick={toggleKillSwitch}
            disabled={killBusy}
            className={cn(
              'w-full rounded-lg py-2.5 text-sm font-semibold transition-colors disabled:opacity-50',
              patient.kill_switch_active
                ? 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                : 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
            )}
          >
            {killBusy ? '…' : patient.kill_switch_active ? 'Resume automated messages' : 'Activate kill switch'}
          </button>
        </div>

        <Separator />

        <Tabs defaultValue="prescriptions" className="p-4">
          <TabsList className="w-full">
            <TabsTrigger value="prescriptions">Prescriptions</TabsTrigger>
            <TabsTrigger value="checkins">Check-in Schedule</TabsTrigger>
            <TabsTrigger value="history">Conversation History</TabsTrigger>
          </TabsList>

          <TabsContent value="prescriptions" className="mt-4 space-y-3">
            {patient.prescriptions.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No prescriptions recorded.</p>
            ) : (
              patient.prescriptions.map((rx) => (
                <div key={rx.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{new Date(rx.created_at).toLocaleDateString()}</p>
                    <Badge variant={rx.verified_by_staff ? 'secondary' : 'outline'}>
                      {rx.verified_by_staff ? 'Verified' : 'Pending verification'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">OCR confidence: {rx.ocr_confidence}</p>
                </div>
              ))
            )}
          </TabsContent>

          <TabsContent value="checkins" className="mt-4 space-y-3">
            {patient.checkin_schedules.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No check-ins scheduled.</p>
            ) : (
              patient.checkin_schedules.map((c) => (
                <div key={c.id} className="flex items-center justify-between rounded-lg border border-border p-3">
                  <div>
                    <p className="text-sm font-medium">Every {c.frequency_days}d</p>
                    <p className="text-xs text-muted-foreground">
                      {c.active ? `Next: ${fmt(c.next_checkin_at)}` : 'Paused'}
                    </p>
                  </div>
                  <Badge variant={c.active ? 'secondary' : 'outline'}>
                    {c.active ? 'Active' : 'Paused'}
                  </Badge>
                </div>
              ))
            )}
          </TabsContent>

          <TabsContent value="history" className="mt-4 space-y-3">
            {patient.conversations.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No conversation yet.</p>
            ) : (
              patient.conversations.map((m) => (
                <div key={m.id} className={cn('rounded-lg border border-border p-3', m.direction === 'inbound' ? 'bg-accent/30' : 'bg-card')}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.direction}</p>
                    <p className="text-xs text-muted-foreground">{fmt(m.created_at)}</p>
                  </div>
                  <p className="mt-1 text-sm">{m.message_text}</p>
                </div>
              ))
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

export default function Patients() {
  const { staff } = useAuth();
  const [patients, setPatients] = useState<PatientRow[] | null>(null);
  const [doctors, setDoctors] = useState<DoctorRow[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<PatientDetail | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const scope = staff?.role === 'doctor' ? 'Your patients only' : 'Clinic-wide';

  useEffect(() => {
    if (!staff) return;
    setLoading(true);
    const q = search ? `&search=${encodeURIComponent(search)}` : '';
    api
      .get<{ data: PatientRow[] }>(`/api/patients?role=${staff.role}&staff_id=${staff.id}${q}`)
      .then((r) => setPatients(r.data))
      .catch((e) => setError(e))
      .finally(() => setLoading(false));
  }, [staff, search]);

  useEffect(() => {
    if (!staff) return;
    api
      .get<{ data: DoctorRow[] }>(`/api/doctors?clinic_id=${staff.clinic_id}`)
      .then((r) => setDoctors(r.data))
      .catch(() => setDoctors([]));
  }, [staff]);

  const filtered = useMemo(() => {
    if (!patients) return [];
    const q = search.trim().toLowerCase();
    if (!q) return patients;
    const digits = q.replace(/\D/g, '');
    return patients.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (digits.length > 0 && p.phone.replace(/\D/g, '').includes(digits)),
    );
  }, [patients, search]);

  async function openPatient(id: string) {
    try {
      const res = await api.get<{ data: PatientDetail }>(`/api/patients/${id}`);
      setSelected(res.data);
      setDrawerOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load patient');
    }
  }

  function handleKillSwitchChange(id: string, active: boolean) {
    setPatients((prev) =>
      prev ? prev.map((p) => (p.id === id ? { ...p, kill_switch_active: active } : p)) : prev,
    );
    if (selected?.id === id) setSelected((prev) => prev ? { ...prev, kill_switch_active: active } : prev);
  }

  function handlePatientAdded(p: PatientRow) {
    setPatients((prev) => (prev ? [p, ...prev] : [p]));
  }

  return (
    <AppShell
      title="Patients"
      description={`${scope} — enrolled patients and their latest contact.`}
      actions={
        <div className="flex items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or phone…"
            aria-label="Search patients"
            className="w-full sm:w-64"
          />
          <Button onClick={() => setAddOpen(true)} className="shrink-0">
            <UserPlus className="mr-2 size-4" />
            Add patient
          </Button>
        </div>
      }
    >
      {loading && !patients ? (
        <LoadingState rows={5} label="Loading patients…" />
      ) : error ? (
        <ErrorState error={error} />
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Assigned doctor</TableHead>
                  <TableHead>Language</TableHead>
                  <TableHead>Consent</TableHead>
                  <TableHead>Kill switch</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!patients &&
                  Array.from({ length: 4 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={6}>
                        <Skeleton className="h-6 w-full" />
                      </TableCell>
                    </TableRow>
                  ))}

                {patients && filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                      {search ? `No patients match "${search}".` : 'No patients enrolled yet.'}
                    </TableCell>
                  </TableRow>
                )}

                {filtered.map((p) => (
                  <TableRow
                    key={p.id}
                    tabIndex={0}
                    role="button"
                    className="cursor-pointer"
                    onClick={() => void openPatient(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        void openPatient(p.id);
                      }
                    }}
                  >
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="font-mono text-xs">{p.phone}</TableCell>
                    <TableCell>{p.doctor_name ?? '—'}</TableCell>
                    <TableCell><LanguageBadge lang={p.language_pref} /></TableCell>
                    <TableCell>
                      <Badge variant={p.consent_given ? 'secondary' : 'outline'}>
                        {p.consent_given ? 'Given' : 'Pending'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {p.kill_switch_active ? (
                        <Badge variant="destructive">Active</Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">Off</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <PatientDrawer
            patient={selected}
            open={drawerOpen}
            onOpenChange={setDrawerOpen}
            onKillSwitchChange={handleKillSwitchChange}
          />

          <AddPatientSheet
            open={addOpen}
            onOpenChange={setAddOpen}
            clinicId={staff?.clinic_id ?? ''}
            doctors={doctors}
            onAdded={handlePatientAdded}
          />
        </>
      )}
    </AppShell>
  );
}
