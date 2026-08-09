import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';

interface Flag {
  id: string;
  flag_type: string;
  priority: 'urgent' | 'normal';
  patient_name: string;
  patient_phone: string;
  created_at: string;
}

export default function Dashboard() {
  const { staff } = useAuth();
  const [openFlags, setOpenFlags] = useState<Flag[] | null>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);

  useEffect(() => {
    if (!staff) return;
    api
      .get<{ data: Flag[] }>(`/api/flags?status=open&role=${staff.role}&staff_id=${staff.id}`)
      .then((res) => setOpenFlags(res.data))
      .catch(() => setOpenFlags([]));
    api
      .get<{ data: unknown[] }>('/api/prescriptions/pending')
      .then((res) => setPendingCount(res.data.length))
      .catch(() => setPendingCount(0));
  }, [staff]);

  const urgentCount = openFlags?.filter((f) => f.priority === 'urgent').length ?? 0;
  const normalCount = (openFlags?.length ?? 0) - urgentCount;

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">Good day, {staff?.name}</h1>
      <p className="text-sm text-slate-500 mb-6">Clinic-wide overview</p>

      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <p className="text-xs text-slate-500 mb-1">Urgent flags</p>
          <p className="text-3xl font-semibold text-red-600">{openFlags === null ? '—' : urgentCount}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <p className="text-xs text-slate-500 mb-1">Normal flags</p>
          <p className="text-3xl font-semibold">{openFlags === null ? '—' : normalCount}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <p className="text-xs text-slate-500 mb-1">Pending prescriptions</p>
          <p className="text-3xl font-semibold">{pendingCount === null ? '—' : pendingCount}</p>
        </div>
      </div>

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">Needs attention now</h2>
        <Link to="/app/flags" className="text-sm text-teal-700">View all flags →</Link>
      </div>
      <div className="space-y-2 mb-8">
        {(openFlags?.filter((f) => f.priority === 'urgent').slice(0, 5) ?? []).map((f) => (
          <div key={f.id} className="bg-white border-l-4 border-l-red-500 border border-slate-200 rounded-lg p-3 text-sm">
            <span className="font-medium">{f.patient_name}</span>
            <span className="text-slate-500"> · {f.patient_phone} · {f.flag_type}</span>
          </div>
        ))}
        {openFlags && openFlags.filter((f) => f.priority === 'urgent').length === 0 && (
          <p className="text-sm text-slate-400">Nothing urgent right now.</p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-4">
        {['Missed-dose catch rate', 'Follow-up attendance rate', 'Doctor time saved'].map((label) => (
          <div key={label} className="bg-slate-50 border border-dashed border-slate-300 rounded-lg p-5 text-center">
            <p className="text-xs text-slate-400">{label}</p>
            <p className="text-sm text-slate-400 mt-1">Coming soon</p>
          </div>
        ))}
      </div>
    </div>
  );
}
