import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { BedDouble, Copy, KeyRound, Pencil, RotateCcw, Trash2, UserPlus, Stethoscope } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/app-shell';
import { BedQrSheet } from '@/components/app/BedQrSheet';
import { ErrorState, LoadingState } from '@/components/app/states';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError, API_BASE } from '@/lib/api';
import { formatPhone, PHONE_HINT, PHONE_PLACEHOLDER } from '@/lib/phone';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';

interface StaffRow {
  id: string;
  name: string;
  role: string;
  phone: string;
  last_login_at?: string | null;
  deactivated_at?: string | null;
}

interface DoctorRow {
  id: string;
  name: string;
  specialty: string | null;
  staff_user_id?: string | null;
  /** The doctor's login phone; null = on the list only, cannot sign in. */
  staff_phone?: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  coordinator: 'Care Coordinator',
  nurse: 'Nurse',
  doctor: 'Doctor',
};

const SELECT_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60';

const cleanName = (s: string) => s.trim().replace(/\s+/g, ' ');

function lastLogin(at?: string | null) {
  if (!at) return 'Never';
  const d = new Date(at);
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-3.5 last:border-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium break-all text-foreground">{value}</dd>
    </div>
  );
}

function FormError({ err }: { err: string | null }) {
  return err ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p> : null;
}

/** Shown under a duplicate-doctor 409 (bug list #12): the admin can still add on purpose. */
function DuplicateWarning({ message, onConfirm, busy }: { message: string; onConfirm: () => void; busy: boolean }) {
  return (
    <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
      <p>{message}</p>
      <p className="text-xs">If it's the same person, give the existing doctor a login from the Doctors list (Create login) instead.</p>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onConfirm}>
        Add anyway
      </Button>
    </div>
  );
}

function PhoneField({ id, value, onChange, required = true }: { id: string; value: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Login phone</Label>
      <Input
        id={id}
        type="tel"
        inputMode="tel"
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={PHONE_PLACEHOLDER}
      />
      <p className="text-xs text-muted-foreground">{PHONE_HINT} They sign in with this number.</p>
    </div>
  );
}

function PasswordField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Temporary password</Label>
      <Input id={id} type="text" autoComplete="new-password" required minLength={8} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Min 8 characters" />
      <p className="text-xs text-muted-foreground">Share it with them; they can change it after signing in.</p>
    </div>
  );
}

const emptyStaff = { name: '', phone: '', role: 'coordinator', password: '', specialty: '' };

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
  const [duplicate, setDuplicate] = useState<string | null>(null);

  const set = (key: keyof typeof emptyStaff) => (v: string) => {
    setForm((f) => ({ ...f, [key]: v }));
    setDuplicate(null);
  };

  async function submit(allowDuplicate = false) {
    setBusy(true);
    setErr(null);
    try {
      // Role Doctor: the server also creates the linked Doctors-list record, in
      // the same transaction, and returns it as `doctor`.
      const res = await api.post<{ data: StaffRow; doctor?: DoctorRow | null; reactivated?: boolean }>('/api/staff', {
        clinic_id: clinicId,
        name: cleanName(form.name),
        role: form.role,
        phone: form.phone.trim(),
        password: form.password,
        specialty: form.role === 'doctor' ? form.specialty.trim() || undefined : undefined,
        allow_duplicate: allowDuplicate || undefined,
      });
      onAdded(res.data);
      if (res.doctor) onDoctorAdded({ ...res.doctor, staff_phone: res.data.phone });
      toast.success(res.reactivated
        ? `${res.data.name} was removed earlier — their account is active again with the new details.`
        : `${res.data.name} can now sign in with ${formatPhone(res.data.phone)}.`);
      setForm(emptyStaff);
      setDuplicate(null);
      onOpenChange(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE_DOCTOR') setDuplicate(e.message);
      else setErr(e instanceof Error ? e.message : 'Failed to add staff member');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Add staff member</SheetTitle>
          <SheetDescription>Creates a login for this hospital's dashboard.</SheetDescription>
        </SheetHeader>
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); void submit(); }} className="mt-6 space-y-5 px-1">
          <div className="space-y-2">
            <Label htmlFor="sName">Full name</Label>
            <Input id="sName" required value={form.name} onChange={(e) => set('name')(e.target.value)} placeholder="Dr. Priya Mehta" />
          </div>
          <PhoneField id="sPhone" value={form.phone} onChange={set('phone')} />
          <div className="space-y-2">
            <Label htmlFor="sRole">Role</Label>
            <select id="sRole" value={form.role} onChange={(e) => set('role')(e.target.value)} className={SELECT_CLASS}>
              <option value="coordinator">Care Coordinator</option>
              <option value="nurse">Nurse</option>
              <option value="doctor">Doctor</option>
              <option value="admin">Administrator</option>
            </select>
          </div>
          {form.role === 'doctor' && (
            <div className="space-y-2">
              <Label htmlFor="sSpecialty">Specialty</Label>
              <Input id="sSpecialty" value={form.specialty} onChange={(e) => set('specialty')(e.target.value)} placeholder="Cardiology, Diabetology…" />
              <p className="text-xs text-muted-foreground">They're added to the Doctors list too — no need to add them there again.</p>
            </div>
          )}
          <PasswordField id="sPassword" value={form.password} onChange={set('password')} />
          <FormError err={err} />
          {duplicate && <DuplicateWarning message={duplicate} busy={busy} onConfirm={() => void submit(true)} />}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Adding…' : 'Add staff member'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

const emptyDoctor = { name: '', specialty: '', withLogin: true, phone: '', password: '' };

/**
 * Add doctor (bug list #1, #12). "Give login access" (on by default) makes the
 * same staff login as Add staff → Doctor, so the doctor can sign in and see
 * their patients. Off = a list entry only (e.g. a visiting doctor); "Create
 * login" on the Doctors list can add one later.
 */
function AddDoctorSheet({
  open,
  onOpenChange,
  clinicId,
  onAdded,
  onStaffAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  clinicId: string;
  onAdded: (d: DoctorRow) => void;
  onStaffAdded: (s: StaffRow) => void;
}) {
  const [form, setForm] = useState(emptyDoctor);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);

  const set = <K extends keyof typeof emptyDoctor>(key: K) => (v: (typeof emptyDoctor)[K]) => {
    setForm((f) => ({ ...f, [key]: v }));
    setDuplicate(null);
  };

  async function submit(allowDuplicate = false) {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.post<{ data: DoctorRow; staff?: StaffRow | null }>('/api/doctors', {
        clinic_id: clinicId,
        name: cleanName(form.name),
        specialty: form.specialty.trim() || undefined,
        login: form.withLogin ? { phone: form.phone.trim(), password: form.password } : undefined,
        allow_duplicate: allowDuplicate || undefined,
      });
      onAdded(res.data);
      if (res.staff) onStaffAdded(res.staff);
      toast.success(res.staff
        ? `${res.data.name} added. They can sign in with ${formatPhone(res.staff.phone)}.`
        : `${res.data.name} added to the Doctors list (no login).`);
      setForm(emptyDoctor);
      setDuplicate(null);
      onOpenChange(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE_DOCTOR') setDuplicate(e.message);
      else setErr(e instanceof Error ? e.message : 'Failed to add doctor');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Add doctor</SheetTitle>
          <SheetDescription>Doctors can be assigned patients and get their flags.</SheetDescription>
        </SheetHeader>
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); void submit(); }} className="mt-6 space-y-5 px-1">
          <div className="space-y-2">
            <Label htmlFor="dName">Full name</Label>
            <Input id="dName" required value={form.name} onChange={(e) => set('name')(e.target.value)} placeholder="Dr. Arjun Sharma" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dSpecialty">Specialty</Label>
            <Input id="dSpecialty" value={form.specialty} onChange={(e) => set('specialty')(e.target.value)} placeholder="Cardiology, Diabetology…" />
          </div>
          <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
            <div>
              <Label htmlFor="dLogin">Give login access</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {form.withLogin
                  ? 'The doctor can sign in and see their own patients. They also appear in the Clinic staff list.'
                  : 'List only — they can be assigned patients but cannot sign in. You can create a login later.'}
              </p>
            </div>
            <Switch id="dLogin" checked={form.withLogin} onCheckedChange={(v) => set('withLogin')(v)} />
          </div>
          {form.withLogin && (
            <>
              <PhoneField id="dPhone" value={form.phone} onChange={set('phone')} />
              <PasswordField id="dPassword" value={form.password} onChange={set('password')} />
            </>
          )}
          <FormError err={err} />
          {duplicate && <DuplicateWarning message={duplicate} busy={busy} onConfirm={() => void submit(true)} />}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Adding…' : 'Add doctor'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** "Create login" for a doctor added without one (bug list #1). */
function CreateDoctorLoginSheet({
  doctor,
  onOpenChange,
  onCreated,
}: {
  doctor: DoctorRow | null;
  onOpenChange: (v: boolean) => void;
  onCreated: (d: DoctorRow, s: StaffRow) => void;
}) {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setPhone(''); setPassword(''); setErr(null); }, [doctor?.id]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!doctor) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.post<{ data: DoctorRow; staff: StaffRow }>(`/api/doctors/${doctor.id}/login`, { phone: phone.trim(), password });
      onCreated(res.data, res.staff);
      toast.success(`${doctor.name} can now sign in with ${formatPhone(res.staff.phone)}.`);
      onOpenChange(false);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Could not create the login');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={!!doctor} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Create login for {doctor?.name}</SheetTitle>
          <SheetDescription>Same doctor record — their patients stay linked. No second doctor is created.</SheetDescription>
        </SheetHeader>
        <form onSubmit={onSubmit} className="mt-6 space-y-5 px-1">
          <PhoneField id="clPhone" value={phone} onChange={setPhone} />
          <PasswordField id="clPassword" value={password} onChange={setPassword} />
          <FormError err={err} />
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Creating…' : 'Create login'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Edit staff (bug list #2, #8): fix a mistyped login phone, the name, or the
 * role. The server refuses changing your own role and changing a doctor's role
 * (deactivate + add again, so their patients are reassigned properly).
 */
function EditStaffSheet({
  member,
  selfId,
  doctor,
  onOpenChange,
  onSaved,
}: {
  member: StaffRow | null;
  selfId: string | undefined;
  doctor: DoctorRow | undefined;
  onOpenChange: (v: boolean) => void;
  onSaved: (s: StaffRow, specialty?: string | null) => void;
}) {
  const [form, setForm] = useState({ name: '', phone: '', role: '', specialty: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (member) setForm({ name: member.name, phone: member.phone, role: member.role, specialty: doctor?.specialty ?? '' });
    setErr(null);
  }, [member, doctor]);

  if (!member) return <Sheet open={false} onOpenChange={onOpenChange} />;
  const roleLocked = member.id === selfId || member.role === 'doctor';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!member) return;
    const body: Record<string, string> = {};
    if (cleanName(form.name) !== member.name) body.name = cleanName(form.name);
    if (form.phone.trim() !== member.phone) body.phone = form.phone.trim();
    if (form.role !== member.role) body.role = form.role;
    if (form.role === 'doctor' && form.specialty.trim() !== (doctor?.specialty ?? '')) body.specialty = form.specialty.trim();
    if (!Object.keys(body).length) { onOpenChange(false); return; }
    setBusy(true);
    setErr(null);
    try {
      const res = await api.patch<{ data: StaffRow }>(`/api/staff/${member.id}`, body);
      onSaved(res.data, form.role === 'doctor' ? form.specialty.trim() || null : undefined);
      toast.success(body.phone ? `Saved. ${res.data.name} now signs in with ${formatPhone(res.data.phone)}.` : 'Saved.');
      onOpenChange(false);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={!!member} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Edit {member.name}</SheetTitle>
          <SheetDescription>Changes apply to their next sign-in; their password stays the same.</SheetDescription>
        </SheetHeader>
        <form onSubmit={onSubmit} className="mt-6 space-y-5 px-1">
          <div className="space-y-2">
            <Label htmlFor="eName">Full name</Label>
            <Input id="eName" required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <PhoneField id="ePhone" value={form.phone} onChange={(v) => setForm((f) => ({ ...f, phone: v }))} />
          <div className="space-y-2">
            <Label htmlFor="eRole">Role</Label>
            <select id="eRole" value={form.role} disabled={roleLocked} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} className={SELECT_CLASS}>
              <option value="coordinator">Care Coordinator</option>
              <option value="nurse">Nurse</option>
              <option value="doctor">Doctor</option>
              <option value="admin">Administrator</option>
            </select>
            {roleLocked && (
              <p className="text-xs text-muted-foreground">
                {member.id === selfId
                  ? "You can't change your own role."
                  : "A doctor's role can't be changed here: deactivate them (their patients get reassigned), then add them again."}
              </p>
            )}
          </div>
          {form.role === 'doctor' && (
            <div className="space-y-2">
              <Label htmlFor="eSpecialty">Specialty</Label>
              <Input id="eSpecialty" value={form.specialty} onChange={(e) => setForm((f) => ({ ...f, specialty: e.target.value }))} />
            </div>
          )}
          <FormError err={err} />
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Reset password (bug list #2, #8, #9): the admin either types a new
 * temporary password or lets the server make one, shown once to pass on.
 */
function ResetPasswordDialog({ member, onOpenChange }: { member: StaffRow | null; onOpenChange: (v: boolean) => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => { setPassword(''); setErr(null); setResult(null); }, [member?.id]);

  async function reset(generate: boolean) {
    if (!member) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.post<{ data: { temporary_password?: string } }>(
        `/api/staff/${member.id}/reset-password`, generate ? {} : { password });
      setResult(res.data.temporary_password ?? password);
      toast.success(`Password reset for ${member.name}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not reset the password');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={!!member} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset password — {member?.name}</AlertDialogTitle>
          <AlertDialogDescription>
            {result
              ? `Give this to ${member?.name}. They sign in with ${formatPhone(member?.phone)} and this password.`
              : 'Their old password stops working. Type a new temporary password, or generate one.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {result ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted px-3 py-2">
            <code className="font-mono text-base">{result}</code>
            <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(result).then(() => toast.success('Copied'))}>
              <Copy className="mr-1.5 size-3.5" /> Copy
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="rpPassword">New temporary password</Label>
            <Input id="rpPassword" type="text" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min 8 characters" />
            <FormError err={err} />
          </div>
        )}
        <AlertDialogFooter>
          {result ? (
            <AlertDialogAction>Done</AlertDialogAction>
          ) : (
            <>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <Button variant="outline" disabled={busy} onClick={() => void reset(true)}>Generate one</Button>
              <Button disabled={busy || password.length < 8} onClick={() => void reset(false)}>
                {busy ? 'Saving…' : 'Set password'}
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
  // Staff are deactivated, not deleted (bug list #8): the row stays for the audit log and can be reactivated.
  const verb = kind === 'staff' ? 'Deactivate' : 'Remove';

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
      toast.success(`${name} ${kind === 'staff' ? 'deactivated' : 'removed'}.${moved}`);
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
          aria-label={`${verb} ${name}`}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{verb} {name}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                {loadErr ? <p className="text-destructive">{loadErr}</p> : !preview ? <p>Checking…</p> : (
                  <ul className="list-disc space-y-1 pl-5">
                    {hasLogin && <li>Their login ({formatPhone(preview.staff!.phone)}) is <b>deactivated</b>: they can no longer sign in. The account is kept, so you can reactivate it later from Clinic staff.</li>}
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
              {busy ? 'Saving…' : verb}
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
  const isAdmin = staff?.role === 'admin';
  const [staffList, setStaffList] = useState<StaffRow[] | null>(null);
  const [doctors, setDoctors] = useState<DoctorRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [addStaffOpen, setAddStaffOpen] = useState(false);
  const [addDoctorOpen, setAddDoctorOpen] = useState(false);
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [resetting, setResetting] = useState<StaffRow | null>(null);
  const [loginFor, setLoginFor] = useState<DoctorRow | null>(null);

  useEffect(() => {
    if (!staff) return;
    Promise.all([
      api
        // Admins also see deactivated staff, so they can be brought back.
        .get<{ data: StaffRow[] }>(`/api/staff?clinic_id=${staff.clinic_id}${staff.role === 'admin' ? '&include_inactive=1' : ''}`)
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

  const upsertStaff = (s: StaffRow) =>
    setStaffList((prev) => [s, ...(prev ?? []).filter((row) => row.id !== s.id)]);
  const upsertDoctor = (d: DoctorRow) =>
    setDoctors((prev) => [d, ...(prev ?? []).filter((row) => row.id !== d.id)]);

  async function reactivate(s: StaffRow) {
    try {
      const r = await api.post<{ data: StaffRow }>(`/api/staff/${s.id}/reactivate`);
      setStaffList((prev) => prev?.map((row) => (row.id === s.id ? r.data : row)) ?? prev);
      if (s.role === 'doctor' && staff) {
        // Their Doctors-list record came back too.
        api.get<{ data: DoctorRow[] }>(`/api/doctors?clinic_id=${staff.clinic_id}`).then((d) => setDoctors(d.data)).catch(() => {});
      }
      toast.success(`${s.name} is active again and can sign in.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reactivate');
    }
  }

  const hospitalName = staff?.clinic_name || 'Your hospital';

  return (
    <AppShell title="Settings" description="Your profile, hospital staff and doctors.">
      {isAdmin && (
        <>
          <BedQrSheet clinicId={staff.clinic_id ?? ''} clinicName={hospitalName} open={bedsOpen} onOpenChange={setBedsOpen} />
          <AddStaffSheet
            open={addStaffOpen}
            onOpenChange={setAddStaffOpen}
            clinicId={staff.clinic_id ?? ''}
            onAdded={upsertStaff}
            onDoctorAdded={upsertDoctor}
          />
          <AddDoctorSheet
            open={addDoctorOpen}
            onOpenChange={setAddDoctorOpen}
            clinicId={staff.clinic_id ?? ''}
            onAdded={upsertDoctor}
            onStaffAdded={upsertStaff}
          />
          <EditStaffSheet
            member={editing}
            selfId={staff.id}
            doctor={editing ? doctors?.find((d) => d.staff_user_id === editing.id) : undefined}
            onOpenChange={(v) => !v && setEditing(null)}
            onSaved={(s, specialty) => {
              setStaffList((prev) => prev?.map((row) => (row.id === s.id ? s : row)) ?? prev);
              setDoctors((prev) => {
                if (!prev) return prev;
                const linked = prev.find((d) => d.staff_user_id === s.id);
                if (linked) {
                  return prev.map((d) => (d.id === linked.id
                    ? { ...d, name: s.name, staff_phone: s.phone, specialty: specialty === undefined ? d.specialty : specialty }
                    : d));
                }
                return prev;
              });
              // Made a doctor just now: the server added them to the Doctors list.
              if (s.role === 'doctor' && staff && !doctors?.some((d) => d.staff_user_id === s.id)) {
                api.get<{ data: DoctorRow[] }>(`/api/doctors?clinic_id=${staff.clinic_id}`).then((d) => setDoctors(d.data)).catch(() => {});
              }
            }}
          />
          <ResetPasswordDialog member={resetting} onOpenChange={(v) => !v && setResetting(null)} />
          <CreateDoctorLoginSheet
            doctor={loginFor}
            onOpenChange={(v) => !v && setLoginFor(null)}
            onCreated={(d, s) => {
              setDoctors((prev) => prev?.map((row) => (row.id === d.id ? d : row)) ?? prev);
              upsertStaff(s);
            }}
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
              <Field label="Login phone" value={formatPhone(staff?.phone)} />
              <Field label="Hospital" value={staff?.role === 'super_admin' ? 'All hospitals (Super Admin)' : hospitalName} />
            </dl>
            {/* Raw ids are only for support (bug list #11). */}
            <details className="mt-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">Advanced (IDs for support)</summary>
              <dl className="mt-2 space-y-1.5">
                {[['Staff ID', staff?.id], ['Hospital ID', staff?.clinic_id]].map(([label, value]) => value ? (
                  <div key={label} className="flex items-center justify-between gap-2">
                    <dt>{label}</dt>
                    <dd className="flex min-w-0 items-center gap-1.5">
                      <code className="truncate font-mono">{value}</code>
                      <button
                        type="button"
                        aria-label={`Copy ${label}`}
                        onClick={() => void navigator.clipboard?.writeText(value).then(() => toast.success(`${label} copied`))}
                        className="rounded p-1 hover:bg-muted"
                      >
                        <Copy className="size-3" />
                      </button>
                    </dd>
                  </div>
                ) : null)}
              </dl>
            </details>
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
                value={staff?.role === 'doctor' ? 'Only patients assigned to you' : 'All patients of this hospital'}
              />
              <Field label="Clinic API" value={API_BASE} />
              <Field label="Interface language" value="English" />
            </dl>
          </section>

          {isAdmin && (
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

          {isAdmin && (
            <section className="rounded-xl border border-border bg-card p-6 lg:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-display text-lg font-semibold text-foreground">Clinic staff</h2>
                  <p className="text-sm text-muted-foreground">Everyone who can sign in. Doctors who sign in are listed here and under Doctors.</p>
                </div>
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
                        <th className="pb-2 pr-6 font-medium">Login phone</th>
                        <th className="pb-2 pr-6 font-medium">Last login</th>
                        <th className="pb-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {staffList.map((s) => {
                        const inactive = !!s.deactivated_at;
                        const self = s.id === staff?.id;
                        return (
                          <tr key={s.id} className={inactive ? 'opacity-60' : undefined}>
                            <td className="py-2.5 pr-6 font-medium text-foreground">
                              {s.name}
                              {self && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
                              {inactive && <Badge variant="outline" className="ml-2">Deactivated</Badge>}
                            </td>
                            <td className="py-2.5 pr-6 text-muted-foreground">{ROLE_LABEL[s.role] ?? s.role}</td>
                            <td className="whitespace-nowrap py-2.5 pr-6 font-mono text-xs text-muted-foreground">{formatPhone(s.phone)}</td>
                            <td className="whitespace-nowrap py-2.5 pr-6 text-xs text-muted-foreground">{lastLogin(s.last_login_at)}</td>
                            <td className="py-2.5 text-right">
                              <div className="flex flex-wrap justify-end gap-1.5">
                                {inactive ? (
                                  <Button size="sm" variant="outline" onClick={() => void reactivate(s)}>
                                    <RotateCcw className="mr-1.5 size-3.5" />
                                    Reactivate
                                  </Button>
                                ) : (
                                  <>
                                    <Button size="sm" variant="outline" onClick={() => setEditing(s)}>
                                      <Pencil className="mr-1.5 size-3.5" />
                                      Edit
                                    </Button>
                                    {!self && (
                                      <Button size="sm" variant="outline" onClick={() => setResetting(s)}>
                                        <KeyRound className="mr-1.5 size-3.5" />
                                        Reset password
                                      </Button>
                                    )}
                                    {!self && (
                                      <RemoveButton
                                        kind="staff"
                                        id={s.id}
                                        name={s.name}
                                        label="Deactivate"
                                        onRemoved={() => {
                                          // The login and its doctor record go together.
                                          setStaffList((prev) => prev?.map((row) => (row.id === s.id ? { ...row, deactivated_at: new Date().toISOString() } : row)) ?? prev);
                                          setDoctors((prev) => prev?.filter((row) => row.staff_user_id !== s.id) ?? prev);
                                        }}
                                      />
                                    )}
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">No staff accounts yet.</p>
              )}
            </section>
          )}

          {isAdmin && (
            <section className="rounded-xl border border-border bg-card p-6 lg:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-display text-lg font-semibold text-foreground">Doctors</h2>
                  <p className="text-sm text-muted-foreground">Doctors patients can be assigned to. A doctor needs a login to sign in.</p>
                </div>
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
                        <th className="pb-2 pr-6 font-medium">Login</th>
                        <th className="pb-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {doctors.map((d) => (
                        <tr key={d.id}>
                          <td className="py-2.5 pr-6 font-medium text-foreground">{d.name}</td>
                          <td className="py-2.5 pr-6 text-muted-foreground">{d.specialty ?? '—'}</td>
                          <td className="whitespace-nowrap py-2.5 pr-6 text-xs">
                            {d.staff_phone ? (
                              <span className="font-mono text-muted-foreground">{formatPhone(d.staff_phone)}</span>
                            ) : (
                              <span className="text-muted-foreground">No login</span>
                            )}
                          </td>
                          <td className="py-2.5 text-right">
                            <div className="flex justify-end gap-1.5">
                              {!d.staff_user_id && (
                                <Button size="sm" variant="outline" onClick={() => setLoginFor(d)}>
                                  <KeyRound className="mr-1.5 size-3.5" />
                                  Create login
                                </Button>
                              )}
                              <RemoveButton
                                kind="doctor"
                                id={d.id}
                                name={d.name}
                                onRemoved={(r) => {
                                  setDoctors((prev) => prev?.filter((row) => row.id !== d.id) ?? prev);
                                  // A doctor with a login: that login was deactivated too.
                                  if (r.staff) {
                                    setStaffList((prev) => prev?.map((row) => (row.id === r.staff!.id ? { ...row, deactivated_at: new Date().toISOString() } : row)) ?? prev);
                                  }
                                }}
                              />
                            </div>
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
