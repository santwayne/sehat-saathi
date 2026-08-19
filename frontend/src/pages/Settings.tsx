import { useEffect, useState, type FormEvent } from 'react';
import { Trash2, UserPlus, Stethoscope } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/app-shell';
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
      const res = await api.post<{ data: StaffRow }>('/api/staff', {
        clinic_id: clinicId,
        name: form.name,
        role: form.role,
        phone: form.phone,
        password: form.password,
      });
      onAdded(res.data);

      // Bug 4 fix: a staff account with Role = Doctor used to be a
      // completely separate, unlinked concept from the Doctors list that
      // actually populates the "Assigned doctor" dropdown on patient
      // enrollment — an admin had to separately re-enter the same person
      // under Settings → Doctors with a different (specialty-only) form,
      // and the two records had no link back to each other at all. The
      // backend already supported linking via doctors.staff_user_id /
      // POST /api/doctors' staff_user_id field — nothing on the frontend
      // ever called it. Now it does, automatically, right after the staff
      // account is created.
      if (form.role === 'doctor') {
        try {
          const docRes = await api.post<{ data: DoctorRow }>('/api/doctors', {
            clinic_id: clinicId,
            name: form.name,
            specialty: form.specialty || undefined,
            staff_user_id: res.data.id,
          });
          onDoctorAdded(docRes.data);
        } catch (docErr) {
          // The staff login itself was created successfully — don't fail
          // the whole flow over the linked Doctors-list entry. Surface it
          // so the admin knows to add it manually via "Add doctor" instead.
          toast.error(
            docErr instanceof Error
              ? `Staff account created, but adding "${form.name}" to the Doctors list failed: ${docErr.message}`
              : 'Staff account created, but adding to the Doctors list failed — add manually via "Add doctor".',
          );
        }
      }

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
        name: form.name,
        specialty: form.specialty || undefined,
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

// Related gap fix: no delete existed anywhere for a doctor record. A patient
// assigned to the deleted doctor keeps their own record — DELETE
// /api/doctors/:id relies on the existing ON DELETE SET NULL foreign key,
// they just show as unassigned afterward.
function DeleteDoctorButton({ doctor, onDeleted }: { doctor: DoctorRow; onDeleted: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    try {
      await api.delete(`/api/doctors/${doctor.id}`);
      setOpen(false);
      onDeleted(doctor.id);
      toast.success(`${doctor.name} removed`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete doctor');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={`Delete ${doctor.name}`}
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="size-3.5" />
      </button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {doctor.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Any patient currently assigned to {doctor.name} keeps their own record — they'll just show
              as unassigned afterward. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void remove(); }}
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? 'Removing…' : 'Remove doctor'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function Settings() {
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
          <AddStaffSheet
            open={addStaffOpen}
            onOpenChange={setAddStaffOpen}
            clinicId={staff.clinic_id}
            onAdded={(s) => setStaffList((prev) => [s, ...(prev ?? [])])}
            onDoctorAdded={(d) => setDoctors((prev) => [d, ...(prev ?? [])])}
          />
          <AddDoctorSheet
            open={addDoctorOpen}
            onOpenChange={setAddDoctorOpen}
            clinicId={staff.clinic_id}
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
                        <th className="pb-2 font-medium">Phone</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {staffList.map((s) => (
                        <tr key={s.id}>
                          <td className="py-2.5 pr-6 font-medium text-foreground">{s.name}</td>
                          <td className="py-2.5 pr-6 capitalize text-muted-foreground">
                            {ROLE_LABEL[s.role] ?? s.role}
                          </td>
                          <td className="py-2.5 font-mono text-xs text-muted-foreground">{s.phone}</td>
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
                            <DeleteDoctorButton
                              doctor={d}
                              onDeleted={(id) => setDoctors((prev) => prev?.filter((row) => row.id !== id) ?? prev)}
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
