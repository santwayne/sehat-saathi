import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';

interface Medicine {
  name: string;
  dosage: string | null;
  frequency: string | null;
  timing: string | null;
  duration: string | null;
  confidence: 'high' | 'medium' | 'low';
}

interface StructuredJson {
  diagnosis: string | null;
  follow_up_date: string | null;
  medicines: Medicine[];
  overall_confidence: 'high' | 'medium' | 'low';
  illegible_notes_flag: boolean;
}

interface Prescription {
  id: string;
  image_url: string;
  ocr_raw_text: string;
  structured_json: StructuredJson;
  ocr_confidence: string;
  created_at: string;
  patient_name: string;
  patient_phone: string;
  language_pref: string;
}

export default function Prescriptions() {
  const { staff } = useAuth();
  const [items, setItems] = useState<Prescription[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<StructuredJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .get<{ data: Prescription[] }>('/api/prescriptions/pending')
      .then((res) => {
        setItems(res.data);
        if (res.data.length) {
          setSelectedId(res.data[0].id);
          setDraft(res.data[0].structured_json);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, []);

  const selected = items?.find((i) => i.id === selectedId) || null;

  function selectItem(item: Prescription) {
    setSelectedId(item.id);
    setDraft(item.structured_json);
  }

  function updateMedicine(idx: number, field: keyof Medicine, value: string) {
    if (!draft) return;
    const medicines = draft.medicines.map((m, i) => (i === idx ? { ...m, [field]: value } : m));
    setDraft({ ...draft, medicines });
  }

  async function approve() {
    if (!selected || !draft || !staff) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/prescriptions/${selected.id}/verify`, {
        structured_json: draft,
        staff_user_id: staff.id,
      });
      setItems((prev) => {
        const next = prev ? prev.filter((i) => i.id !== selected.id) : prev;
        if (next && next.length) {
          setSelectedId(next[0].id);
          setDraft(next[0].structured_json);
        } else {
          setSelectedId(null);
          setDraft(null);
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to verify prescription');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4">Prescriptions — Verification Queue</h1>
      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {items === null && <p className="text-sm text-slate-500">Loading…</p>}
      {items && items.length === 0 && (
        <p className="text-sm text-slate-500 bg-white border border-slate-200 rounded-lg p-6 text-center">
          Nothing pending verification.
        </p>
      )}

      {items && items.length > 0 && (
        <div className="grid grid-cols-[280px_1fr] gap-4">
          <div className="space-y-2">
            {items.map((item) => (
              <button
                key={item.id}
                onClick={() => selectItem(item)}
                className={`w-full text-left bg-white border rounded-lg p-3 ${
                  item.id === selectedId ? 'border-teal-600 ring-1 ring-teal-600' : 'border-slate-200'
                }`}
              >
                <p className="text-sm font-medium">{item.patient_name}</p>
                <p className="text-xs text-slate-500">{item.patient_phone}</p>
                <span
                  className={`inline-block mt-1 text-xs px-2 py-0.5 rounded-full ${
                    item.ocr_confidence === 'high'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {item.ocr_confidence} confidence
                </span>
              </button>
            ))}
          </div>

          {selected && draft && (
            <div className="bg-white border border-slate-200 rounded-lg p-5">
              <div className="grid grid-cols-2 gap-5 mb-5">
                <div>
                  <p className="text-xs text-slate-500 mb-1">Prescription image</p>
                  <img
                    src={selected.image_url}
                    alt="Prescription"
                    className="w-full rounded-md border border-slate-200 object-contain max-h-96"
                  />
                </div>
                <div>
                  {(draft.overall_confidence !== 'high' || draft.illegible_notes_flag) && (
                    <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-md p-3 mb-3">
                      Overall confidence: {draft.overall_confidence}
                      {draft.illegible_notes_flag ? ' — illegible notes detected' : ''}. Double-check against the image.
                    </div>
                  )}

                  <label className="block text-xs font-medium text-slate-600 mb-1">Diagnosis</label>
                  <input
                    value={draft.diagnosis || ''}
                    onChange={(e) => setDraft({ ...draft, diagnosis: e.target.value })}
                    className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm mb-3"
                  />

                  <label className="block text-xs font-medium text-slate-600 mb-1">Follow-up date</label>
                  <input
                    value={draft.follow_up_date || ''}
                    onChange={(e) => setDraft({ ...draft, follow_up_date: e.target.value })}
                    className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm mb-3"
                  />

                  <details className="text-xs text-slate-500">
                    <summary className="cursor-pointer">Raw OCR text</summary>
                    <p className="mt-1 whitespace-pre-wrap">{selected.ocr_raw_text}</p>
                  </details>
                </div>
              </div>

              <p className="text-sm font-medium mb-2">Medicines</p>
              <div className="space-y-2 mb-5">
                {draft.medicines.map((m, idx) => (
                  <div
                    key={idx}
                    className={`grid grid-cols-5 gap-2 p-2 rounded-md ${
                      m.confidence === 'low' ? 'bg-amber-50 border border-amber-200' : 'bg-slate-50'
                    }`}
                  >
                    {(['name', 'dosage', 'frequency', 'timing', 'duration'] as const).map((field) => (
                      <input
                        key={field}
                        value={m[field] || ''}
                        placeholder={field}
                        onChange={(e) => updateMedicine(idx, field, e.target.value)}
                        className="border border-slate-300 rounded px-2 py-1 text-xs"
                      />
                    ))}
                  </div>
                ))}
              </div>

              <button
                onClick={approve}
                disabled={submitting}
                className="bg-teal-700 text-white px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50"
              >
                {submitting ? 'Approving…' : 'Approve & Activate'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
