import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';

interface StaffRow {
  id: string;
  name: string;
  role: string;
  phone: string;
  notify_on_flag: boolean;
}

interface DoctorRow {
  id: string;
  name: string;
  specialty: string | null;
  staff_phone: string | null;
}

export default function Settings() {
  const { staff } = useAuth();
  const [staffList, setStaffList] = useState<StaffRow[] | null>(null);
  const [doctors, setDoctors] = useState<DoctorRow[] | null>(null);

  useEffect(() => {
    if (!staff) return;
    api.get<{ data: StaffRow[] }>(`/api/staff?clinic_id=${staff.clinic_id}`).then((r) => setStaffList(r.data)).catch(() => setStaffList([]));
    api.get<{ data: DoctorRow[] }>(`/api/doctors?clinic_id=${staff.clinic_id}`).then((r) => setDoctors(r.data)).catch(() => setDoctors([]));
  }, [staff]);

  if (staff?.role !== 'admin') {
    return <p className="text-sm text-slate-500">Settings is only visible to admins.</p>;
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">Settings</h1>

      <h2 className="text-sm font-semibold mb-2">Staff</h2>
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden mb-8">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">Phone</th>
              <th className="px-4 py-2 font-medium">Notify on flag</th>
            </tr>
          </thead>
          <tbody>
            {staffList?.map((s) => (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="px-4 py-2 font-medium">{s.name}</td>
                <td className="px-4 py-2 capitalize text-slate-500">{s.role}</td>
                <td className="px-4 py-2 text-slate-500">{s.phone}</td>
                <td className="px-4 py-2">{s.notify_on_flag ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {staffList && staffList.length === 0 && <p className="text-sm text-slate-500 p-6 text-center">No staff yet.</p>}
      </div>

      <h2 className="text-sm font-semibold mb-2">Doctors</h2>
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Specialty</th>
              <th className="px-4 py-2 font-medium">Linked staff login</th>
            </tr>
          </thead>
          <tbody>
            {doctors?.map((d) => (
              <tr key={d.id} className="border-t border-slate-100">
                <td className="px-4 py-2 font-medium">{d.name}</td>
                <td className="px-4 py-2 text-slate-500">{d.specialty || '—'}</td>
                <td className="px-4 py-2 text-slate-500">{d.staff_phone || 'Not linked'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {doctors && doctors.length === 0 && <p className="text-sm text-slate-500 p-6 text-center">No doctors yet.</p>}
      </div>
    </div>
  );
}
