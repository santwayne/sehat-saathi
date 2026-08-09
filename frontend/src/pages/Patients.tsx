import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';

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
  prescriptions: { id: string; created_at: string; ocr_confidence: string; verified_by_staff: boolean }[];
  checkin_schedules: { id: string; frequency_days: number; next_checkin_at: string; active: boolean }[];
  conversations: { id: string; direction: string; message_text: string; created_at: string }[];
}

export default function Patients() {
  const { staff } = useAuth();
  const [patients, setPatients] = useState<PatientRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<PatientDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [killBusy, setKillBusy] = useState(false);

  const load = useCallback(async () => {
    if (!staff) return;
    try {
      const q = search ? `&search=${encodeURIComponent(search)}` : '';
      const res = await api.get<{ data: PatientRow[] }>(
        `/api/patients?role=${staff.role}&staff_id=${staff.id}${q}`
      );
      setPatients(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load patients');
    }
  }, [staff, search]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function openPatient(id: string) {
    try {
      const res = await api.get<{ data: PatientDetail }>(`/api/patients/${id}`);
      setSelected(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load patient');
    }
  }

  async function toggleKillSwitch() {
    if (!selected) return;
    const next = !selected.kill_switch_active;
    if (next && !confirm('This will stop all automated check-ins and AI replies to this patient immediately. Clinic staff will need to follow up manually. Continue?')) {
      return;
    }
    setKillBusy(true);
    try {
      await api.post(`/api/flags/patients/${selected.id}/kill-switch`, { active: next });
      setSelected({ ...selected, kill_switch_active: next });
      setPatients((prev) => prev?.map((p) => (p.id === selected.id ? { ...p, kill_switch_active: next } : p)) ?? prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle kill switch');
    } finally {
      setKillBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4">Patients</h1>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name or phone…"
        className="w-full max-w-sm border border-slate-300 rounded-md px-3 py-2 text-sm mb-4"
      />
      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Phone</th>
              <th className="px-4 py-2 font-medium">Doctor</th>
              <th className="px-4 py-2 font-medium">Language</th>
              <th className="px-4 py-2 font-medium">Consent</th>
              <th className="px-4 py-2 font-medium">Kill switch</th>
            </tr>
          </thead>
          <tbody>
            {patients?.map((p) => (
              <tr
                key={p.id}
                onClick={() => openPatient(p.id)}
                className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
              >
                <td className="px-4 py-2 font-medium">{p.name}</td>
                <td className="px-4 py-2 text-slate-500">{p.phone}</td>
                <td className="px-4 py-2 text-slate-500">{p.doctor_name || '—'}</td>
                <td className="px-4 py-2 uppercase text-slate-500">{p.language_pref}</td>
                <td className="px-4 py-2">
                  <span className={p.consent_given ? 'text-green-700' : 'text-amber-700'}>
                    {p.consent_given ? 'Given' : 'Pending'}
                  </span>
                </td>
                <td className="px-4 py-2">
                  {p.kill_switch_active && (
                    <span className="bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full">Active</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {patients && patients.length === 0 && (
          <p className="text-sm text-slate-500 p-6 text-center">No patients found.</p>
        )}
      </div>

      {selected && (
        <div className="fixed inset-0 bg-black/30 flex justify-end z-20" onClick={() => setSelected(null)}>
          <div
            className="w-full max-w-md bg-white h-full overflow-y-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => setSelected(null)} className="text-sm text-slate-500 mb-4">
              ← Close
            </button>
            <h2 className="text-lg font-semibold">{selected.name}</h2>
            <p className="text-sm text-slate-500 mb-4">{selected.phone} · {selected.doctor_name || 'No doctor assigned'}</p>

            <button
              onClick={toggleKillSwitch}
              disabled={killBusy}
              className={`w-full text-sm font-medium rounded-md py-2 mb-6 disabled:opacity-50 ${
                selected.kill_switch_active ? 'bg-slate-900 text-white' : 'bg-red-600 text-white'
              }`}
            >
              {killBusy ? '…' : selected.kill_switch_active ? 'Resume automated messages' : 'Activate kill switch'}
            </button>

            <h3 className="text-sm font-semibold mb-2">Prescriptions</h3>
            <div className="space-y-1 mb-5">
              {selected.prescriptions.length === 0 && <p className="text-xs text-slate-400">None yet.</p>}
              {selected.prescriptions.map((p) => (
                <div key={p.id} className="text-xs bg-slate-50 rounded p-2 flex justify-between">
                  <span>{new Date(p.created_at).toLocaleDateString()}</span>
                  <span>{p.verified_by_staff ? 'Verified' : 'Pending verification'}</span>
                </div>
              ))}
            </div>

            <h3 className="text-sm font-semibold mb-2">Check-in schedule</h3>
            <div className="space-y-1 mb-5">
              {selected.checkin_schedules.length === 0 && <p className="text-xs text-slate-400">None yet.</p>}
              {selected.checkin_schedules.map((s) => (
                <div key={s.id} className="text-xs bg-slate-50 rounded p-2 flex justify-between">
                  <span>Every {s.frequency_days}d</span>
                  <span>{s.active ? `Next: ${new Date(s.next_checkin_at).toLocaleString()}` : 'Paused'}</span>
                </div>
              ))}
            </div>

            <h3 className="text-sm font-semibold mb-2">Conversation history</h3>
            <div className="space-y-1">
              {selected.conversations.length === 0 && <p className="text-xs text-slate-400">No messages yet.</p>}
              {selected.conversations.map((c) => (
                <div key={c.id} className={`text-xs rounded p-2 ${c.direction === 'inbound' ? 'bg-teal-50' : 'bg-slate-50'}`}>
                  <p className="text-slate-400 mb-0.5">
                    {c.direction} · {new Date(c.created_at).toLocaleString()}
                  </p>
                  <p>{c.message_text}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
