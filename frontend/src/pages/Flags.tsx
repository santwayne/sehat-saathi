import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';

interface Flag {
  id: string;
  flag_type: string;
  priority: 'urgent' | 'normal';
  status: string;
  created_at: string;
  patient_id: string;
  patient_name: string;
  patient_phone: string;
  doctor_name: string | null;
}

const FLAG_LABELS: Record<string, string> = {
  missed_dose: 'Missed dose',
  symptom_reported: 'Symptom reported',
  unanswerable_question: 'Unanswered question',
  no_show_risk: 'No-show risk',
  ocr_low_confidence: 'Low-confidence OCR',
};

function timeAgo(iso: string) {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function Flags() {
  const { staff } = useAuth();
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [flags, setFlags] = useState<Flag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!staff) return;
    setError(null);
    try {
      const res = await api.get<{ data: Flag[] }>(
        `/api/flags?status=${status}&role=${staff.role}&staff_id=${staff.id}`
      );
      setFlags(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load flags');
    }
  }, [staff, status]);

  useEffect(() => {
    load();
  }, [load]);

  async function resolve(id: string) {
    if (!staff) return;
    setBusyId(id);
    try {
      await api.patch(`/api/flags/${id}/resolve`, { staff_id: staff.id });
      setFlags((prev) => (prev ? prev.filter((f) => f.id !== id) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve flag');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Flags</h1>
        <div className="flex gap-1 bg-white border border-slate-200 rounded-md p-1">
          {(['open', 'resolved'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-3 py-1 text-sm rounded ${status === s ? 'bg-teal-700 text-white' : 'text-slate-600'}`}
            >
              {s === 'open' ? 'Open' : 'Resolved'}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {flags === null && <p className="text-sm text-slate-500">Loading…</p>}
      {flags && flags.length === 0 && (
        <p className="text-sm text-slate-500 bg-white border border-slate-200 rounded-lg p-6 text-center">
          No {status} flags.
        </p>
      )}

      <div className="space-y-2">
        {flags?.map((f) => (
          <div
            key={f.id}
            className={`bg-white border rounded-lg p-4 flex items-center justify-between ${
              f.priority === 'urgent' ? 'border-l-4 border-l-red-500 border-slate-200' : 'border-slate-200'
            }`}
          >
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    f.priority === 'urgent' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {f.priority}
                </span>
                <span className="text-xs text-slate-500">{FLAG_LABELS[f.flag_type] || f.flag_type}</span>
              </div>
              <p className="text-sm font-medium">{f.patient_name} · {f.patient_phone}</p>
              <p className="text-xs text-slate-500">
                {f.doctor_name || 'Unassigned — coordinator queue'} · {timeAgo(f.created_at)}
              </p>
            </div>
            {status === 'open' && (
              <button
                onClick={() => resolve(f.id)}
                disabled={busyId === f.id}
                className="text-sm bg-slate-900 text-white px-3 py-1.5 rounded-md disabled:opacity-50"
              >
                {busyId === f.id ? '…' : 'Resolve'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
