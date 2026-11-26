import { useEffect, useState, type FormEvent } from 'react';
import { BedDouble, Trash2, UserPlus, Stethoscope } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/app-shell';
import { BedQrSheet } from '@/components/app/BedQrSheet';
import { ErrorState, LoadingState } from '@/components/app/states';
import { useAuth } from '@/context/AuthContext';
import { api, API_BASE } from '@/lib/api';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

interface StaffRow {
  id: string;
  name: string;
  role: string;
  phone: string;
}

interface DoctorRow {
  id: string;
  name: string;
  specialty: string | null;
  staff_user_id?: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  coordinator: 'Care Coordinator',
  nurse: 'Nurse',
  doctor: 'Doctor',
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-3.5 last:border-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium break-all text-foreground">{value}</dd>
    </div>
  );
}

const emptyStaff = { name: '', phone: '', role: 'coordinator', password: '', specialty: '' };
const emptyDoctor = { name: '', specialty: '' };

function AddStaffSheet({
  open,
  onOpenChange,
  clinicId,
  onAdded,
  onDoctorAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  clinicId: string;
  onAdded: (s: StaffRow) => void;
  onDoctorAdded: (d: DoctorRow) => void;
}) {
  const [form, setForm] = useState(emptyStaff);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const update =
    (key: keyof typeof emptyStaff) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      // Name / phone trimmed ("dr priya " used to be saved with the space).
      // Role Doctor: the server also creates the linked Doctors-list record, in
      // the same transaction, and returns it as `doctor`.
      const res = await api.post<{ data: StaffRow; doctor?: DoctorRow | null; reactivated?: boolean }>('/api/staff', {
        clinic_id: clinicId,
        name: form.name.trim().replace(/\s+/g, ' '),
        role: form.role,
        phone: form.phone.trim(),
        password: form.password,
        specialty: form.role === 'doctor' ? form.specialty.trim() || undefined : undefined,
      });
      onAdded(res.data);
      if (res.doctor) onDoctorAdded(res.doctor);
      if (res.reactivated) toast.success(`${res.data.name} was removed earlier — their account is active again with the new details.`);

      setForm(emptyStaff);
      onOpenChange(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to add staff member');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Add staff member</SheetTitle>
        </SheetHeader>
        <form onSubmit={onSubmit} className="mt-6 space-y-5 px-1">
          <div className="space-y-2">
            <Label htmlFor="sName">Full name</Label>
            <Input
              id="sName"
              required
              value={form.name}
              onChange={update('name')}
              placeholder="Dr. Priya Mehta"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sPhone">Phone</Label>
            <Input
              id="sPhone"
              required
              value={form.phone}
              onChange={update('phone')}
              placeholder="9876543210"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sRole">Role</Label>
            <select
              id="sRole"
              value={form.role}
              onChange={update('role')}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="coordinator">Care Coordinator</option>
              <option value="nurse">Nurse</option>
              <option value="doctor">Doctor</option>
              <option value="admin">Administrator</option>
            </select>
          </div>
          {form.role === 'doctor' && (
            <div className="space-y-2">
              <Label htmlFor="sSpecialty">Specialty</Label>
              <Input
                id="sSpecialty"
                value={form.specialty}
                onChange={update('specialty')}
                placeholder="Cardiology, Diabetology…"
              />
              <p className="text-xs text-muted-foreground">
                This account will be added to the assignable Doctors list automatically.
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="sPassword">Temporary password</Label>
            <Input
              id="sPassword"
              type="password"
              required
              value={form.password}
              onChange={update('password')}
              placeholder="Min 8 characters"
            />
          </div>
          {err ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>
          ) : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Adding…' : 'Add staff member'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function AddDoctorSheet({
  open,
  onOpenChange,
  clinicId,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  clinicId: string;
  onAdded: (d: DoctorRow) => void;
}) {
  const [form, setForm] = useState(emptyDoctor);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const update =
    (key: keyof typeof emptyDoctor) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await api.post<{ data: DoctorRow }>('/api/doctors', {
        clinic_id: clinicId,
        name: form.name.trim().replace(/\s+/g, ' '),
        specialty: form.specialty.trim() || undefined,
      });
      onAdded(res.data);
      setForm(emptyDoctor);
      onOpenChange(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to add doctor');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Add doctor</SheetTitle>
        </SheetHeader>
        <form onSubmit={onSubmit} className="mt-6 space-y-5 px-1">
          <div className="space-y-2">
            <Label htmlFor="dName">Full name</Label>
            <Input
              id="dName"
              required
              value={form.name}
              onChange={update('name')}
              placeholder="Dr. Arjun Sharma"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dSpecialty">Specialty</Label>
            <Input
              id="dSpecialty"
              value={form.specialty}
              onChange={update('specialty')}
              placeholder="Cardiology, Diabetology…"
            />
          </div>
          {err ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>
          ) : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Adding…' : 'Add doctor'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

interface RemovalPreview {
  staff: { id: string; name: string; role: string; phone: string } | null;
  doctors: { id: string; name: string; specialty: string | null }[];
  patient_count: number;
  reassign_options: { id: string; name: string; specialty: string | null }[];
}
interface RemovalResult {
  staff: { id: string; name: string } | null;
  doctors_removed: string[];
  patients_moved: number;
  patients_assigned_to: string | null;
}

/**
 * Remove a staff member or a doctor. One action: the staff login is
 * deactivated (cannot sign in; kept for the audit log) and the linked doctor
 * record is retired. If the doctor has patients, the admin picks who takes
 * them over, or leaves them unassigned.
 *   kind "staff"  → GET /api/staff/:id/removal,   DELETE /api/staff/:id
 *   kind "doctor" → GET /api/doctors/:id/removal, DELETE /api/doctors/:id
 */
function RemoveButton({
  kind,
  id,
  name,
  label,
  onRemoved,
}: {
  kind: 'staff' | 'doctor';
  id: string;
  name: string;
  label?: string;
  onRemoved: (r: RemovalResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<RemovalPreview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [target, setTarget] = useState<string>('');
  const base = kind === 'staff' ? '/api/staff' : '/api/doctors';

  async function start() {
    setOpen(true);
    setPreview(null);
    setLoadErr(null);
    setTarget('');
    try {
      const r = await api.get<{ data: RemovalPreview }>(`${base}/${id}/removal`);
      setPreview(r.data);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Could not load details');
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const q = target ? `?reassign_to=${encodeURIComponent(target)}` : '';
      const r = await api.delete<{ data: RemovalResult }>(`${base}/${id}${q}`);
      setOpen(false);
      onRemoved(r.data);
      const moved = r.data.patients_moved
        ? ` ${r.data.patients_moved} patient(s) ${r.data.patients_assigned_to ? `moved to ${r.data.patients_assigned_to}` : 'left unassigned'}.`
        : '';
      toast.success(`${name} removed.${moved}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove');
    } finally {
      setBusy(false);
    }
  }

  const hasLogin = !!preview?.staff;
  const hasDoctor = !!preview?.doctors.length;

  return (
    <>
      {label ? (
        <Button size="sm" variant="outline" onClick={() => void start()} className="text-destructive hover:bg-destructive/10 hover:text-destructive">
          <Trash2 className="mr-1.5 size-3.5" />
          {label}
        </Button>
      ) : (
        <button
          onClick={() => void start()}
          aria-label={`Remove ${name}`}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                {loadErr ? <p className="text-destructive">{loadErr}</p> : !preview ? <p>Checking…</p> : (
                  <ul className="list-disc space-y-1 pl-5">
                    {hasLogin && <li>Their login ({preview.staff!.phone}) is <b>deactivated</b>: they can no longer sign in. The account is kept so the audit log stays complete.</li>}
                    {hasDoctor && <li>They are removed from the <b>Doctors list</b> and patient assignment.</li>}
                    {preview.patient_count === 0 && hasDoctor && <li>No patients are assigned to them.</li>}
                  </ul>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {preview && preview.patient_count > 0 && (
            <div className="space-y-2">
              <Label htmlFor={`reassign-${id}`}>
                {preview.patient_count} patient{preview.patient_count === 1 ? ' is' : 's are'} assigned to {name}. Who should take over?
              </Label>
              <select
                id={`reassign-${id}`}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">Leave unassigned (assign later from Patients)</option>
                {preview.reassign_options.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}{d.specialty ? ` · ${d.specialty}` : ''}</option>
                ))}
              </select>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void remove(); }}
              disabled={busy || !preview}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function Settings() {
  const [bedsOpen, setBedsOpen] = useState(false);
  const { staff } = useAuth();
  const [staffList, setStaffList] = useState<StaffRow[] | null>(null);
  const [doctors, setDoctors] = useState<DoctorRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [addStaffOpen, setAddStaffOpen] = useState(false);
  const [addDoctorOpen, setAddDoctorOpen] = useState(false);

  useEffect(() => {
    if (!staff) return;
    Promise.all([
      api
        .get<{ data: StaffRow[] }>(`/api/staff?clinic_id=${staff.clinic_id}`)
        .then((r) => setStaffList(r.data))
        .catch(() => setStaffList([])),
      api
        .get<{ data: DoctorRow[] }>(`/api/doctors?clinic_id=${staff.clinic_id}`)
        .then((r) => setDoctors(r.data))
        .catch(() => setDoctors([])),
    ])
      .catch((e) => setError(e))
      .finally(() => setLoading(false));
  }, [staff]);

  return (
    <AppShell title="Settings" description="Your profile, access scope and system connection.">
      {staff?.role === 'admin' && (
        <>
          <BedQrSheet clinicId={staff.clinic_id ?? ''} clinicName="Your hospital" open={bedsOpen} onOpenChange={setBedsOpen} />
          <AddStaffSheet
            open={addStaffOpen}
            onOpenChange={setAddStaffOpen}
            clinicId={staff.clinic_id ?? ''}
            onAdded={(s) => setStaffList((prev) => [s, ...(prev ?? [])])}
            onDoctorAdded={(d) => setDoctors((prev) => [d, ...(prev ?? [])])}
          />
          <AddDoctorSheet
            open={addDoctorOpen}
            onOpenChange={setAddDoctorOpen}
            clinicId={staff.clinic_id ?? ''}
            onAdded={(d) => setDoctors((prev) => [d, ...(prev ?? [])])}
          />
        </>
      )}

      {loading ? (
        <LoadingState rows={2} label="Loading settings…" />
      ) : error ? (
        <ErrorState error={error} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-xl border border-border bg-card p-6">
            <h2 className="font-display text-lg font-semibold text-foreground">Staff profile</h2>
            <dl className="mt-2">
              <Field label="Name" value={staff?.name ?? '—'} />
              <Field label="Role" value={ROLE_LABEL[staff?.role ?? ''] ?? (staff?.role ?? '—')} />
              <Field label="Staff ID" value={staff?.id ?? '—'} />
              <Field label="Phone" value={staff?.phone ?? '—'} />
              <Field label="Clinic ID" value={staff?.clinic_id ?? '—'} />
            </dl>
          </section>

          <section className="rounded-xl border border-border bg-card p-6">
            <h2 className="font-display text-lg font-semibold text-foreground">Data access</h2>
            <dl className="mt-2">
              <Field
                label="Patient records"
                value={
                  staff?.records_access === 'enabled'
                    ? 'Included in your plan'
                    : staff?.records_access === 'awaiting_approval'
                      ? 'Open once your hospital is approved'
                      : staff?.records_access === 'not_in_plan'
                        ? 'Not included in your plan (nothing is stored)'
                        : '—'
                }
              />
              <Field
                label="Visibility"
                value={staff?.role === 'doctor' ? 'Own patients only' : 'Clinic-wide records'}
              />
              <Field
                label="Scoping rule"
                value={
                  staff?.role === 'doctor'
                    ? `Filtered to doctorId = ${staff.id}`
                    : 'Admins, coordinators and nurses see all patients'
                }
              />
              <Field label="Clinic API" value={API_BASE} />
              <Field label="Interface language" value="English" />
            </dl>
          </section>

          {staff?.role === 'admin' && (
            <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-6 lg:col-span-2">
              <div>
                <h2 className="font-display text-lg font-semibold text-foreground">Bed QR codes</h2>
                <p className="text-sm text-muted-foreground">Print a QR for every bed so patients can connect on WhatsApp themselves.</p>
              </div>
              <Button size="sm" onClick={() => setBedsOpen(true)}>
                <BedDouble className="mr-1.5 size-3.5" />
                Manage beds
              </Button>
            </section>
          )}

          {staff?.role === 'admin' && (
            <section className="rounded-xl border border-border bg-card p-6 lg:col-span-2">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-lg font-semibold text-foreground">Clinic staff</h2>
                <Button size="sm" onClick={() => setAddStaffOpen(true)}>
                  <UserPlus className="mr-1.5 size-3.5" />
                  Add staff
                </Button>
              </div>
              {staffList && staffList.length > 0 ? (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="pb-2 pr-6 font-medium">Name</th>
                        <th className="pb-2 pr-6 font-medium">Role</th>
                        <th className="pb-2 pr-6 font-medium">Phone</th>
                        <th className="pb-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {staffList.map((s) => (
                        <tr key={s.id}>
                          <td className="py-2.5 pr-6 font-medium text-foreground">{s.name}</td>
                          <td className="py-2.5 pr-6 capitalize text-muted-foreground">
                            {ROLE_LABEL[s.role] ?? s.role}
                          </td>
                          <td className="py-2.5 pr-6 font-mono text-xs text-muted-foreground">{s.phone}</td>
                          <td className="py-2.5 text-right">
                            {s.id !== staff?.id && (
                              <RemoveButton
                                kind="staff"
                                id={s.id}
                                name={s.name}
                                label="Remove"
                                onRemoved={() => {
                                  // The login and its doctor record go together.
                                  setStaffList((prev) => prev?.filter((row) => row.id !== s.id) ?? prev);
                                  setDoctors((prev) => prev?.filter((row) => row.staff_user_id !== s.id) ?? prev);
                                }}
                              />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">No staff accounts yet.</p>
              )}
            </section>
          )}

          {staff?.role === 'admin' && (
            <section className="rounded-xl border border-border bg-card p-6 lg:col-span-2">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-lg font-semibold text-foreground">Doctors</h2>
                <Button size="sm" onClick={() => setAddDoctorOpen(true)}>
                  <Stethoscope className="mr-1.5 size-3.5" />
                  Add doctor
                </Button>
              </div>
              {doctors && doctors.length > 0 ? (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="pb-2 pr-6 font-medium">Name</th>
                        <th className="pb-2 pr-6 font-medium">Specialty</th>
                        <th className="pb-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {doctors.map((d) => (
                        <tr key={d.id}>
                          <td className="py-2.5 pr-6 font-medium text-foreground">{d.name}</td>
                          <td className="py-2.5 pr-6 text-muted-foreground">{d.specialty ?? '—'}</td>
                          <td className="py-2.5 text-right">
                            <RemoveButton
                              kind="doctor"
                              id={d.id}
                              name={d.name}
                              onRemoved={(r) => {
                                setDoctors((prev) => prev?.filter((row) => row.id !== d.id) ?? prev);
                                // A doctor with a login: that login was deactivated too.
                                if (r.staff) setStaffList((prev) => prev?.filter((row) => row.id !== r.staff!.id) ?? prev);
                              }}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">No doctors registered yet.</p>
              )}
            </section>
          )}
        </div>
      )}
    </AppShell>
  );
}
