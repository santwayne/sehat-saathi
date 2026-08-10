import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app/app-shell';
import { ErrorState, LoadingState } from '@/components/app/states';
import { useAuth } from '@/context/AuthContext';
import { api, API_BASE } from '@/lib/api';

interface StaffRow {
  id: string;
  name: string;
  role: string;
  phone: string;
}

interface DoctorRow {
  id: string;
  name: string;
  speciality: string | null;
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

export default function Settings() {
  const { staff } = useAuth();
  const [staffList, setStaffList] = useState<StaffRow[] | null>(null);
  const [doctors, setDoctors] = useState<DoctorRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

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
                value={
                  staff?.role === 'doctor' ? 'Own patients only' : 'Clinic-wide records'
                }
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

          {staff?.role === 'admin' && staffList && staffList.length > 0 && (
            <section className="rounded-xl border border-border bg-card p-6 lg:col-span-2">
              <h2 className="font-display text-lg font-semibold text-foreground">Clinic staff</h2>
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
                        <td className="py-2.5 pr-6 capitalize text-muted-foreground">{ROLE_LABEL[s.role] ?? s.role}</td>
                        <td className="py-2.5 font-mono text-xs text-muted-foreground">{s.phone}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {staff?.role === 'admin' && doctors && doctors.length > 0 && (
            <section className="rounded-xl border border-border bg-card p-6 lg:col-span-2">
              <h2 className="font-display text-lg font-semibold text-foreground">Doctors</h2>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="pb-2 pr-6 font-medium">Name</th>
                      <th className="pb-2 font-medium">Speciality</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {doctors.map((d) => (
                      <tr key={d.id}>
                        <td className="py-2.5 pr-6 font-medium text-foreground">{d.name}</td>
                        <td className="py-2.5 text-muted-foreground">{d.speciality ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
    </AppShell>
  );
}
