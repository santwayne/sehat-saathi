import { useCallback, useEffect, useState } from 'react';
import { Pill } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/app-shell';
import { EmptyState, ErrorState, LoadingState } from '@/components/app/states';
import { Badge } from '@/components/ui/badge';
import { useEffectiveClinicId } from '@/context/ClinicContext';
import { api } from '@/lib/api';

interface RefillOrder {
  id: string;
  status: 'flagged' | 'offered' | 'ordered' | 'fulfilled' | 'cancelled';
  due_date: string | null;
  medicine_names: string | null;
  reminded_at: string | null;
  patient_name: string;
  patient_phone: string;
  pharmacy_name: string | null;
}

const STATUSES: RefillOrder['status'][] = ['flagged', 'offered', 'ordered', 'fulfilled', 'cancelled'];

// Roadmap "Pharmacy refill reminders": patients get a WhatsApp nudge ~3 days
// before a medicine course ends; this is the staff queue behind it.
export default function Refills() {
  const clinicId = useEffectiveClinicId();
  const [orders, setOrders] = useState<RefillOrder[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    api
      .get<{ data: RefillOrder[] }>(`/api/refill-orders${clinicId ? `?clinic_id=${clinicId}` : ''}`)
      .then((r) => setOrders(r.data))
      .catch(setError);
  }, [clinicId]);

  useEffect(load, [load]);

  async function setStatus(id: string, status: RefillOrder['status']) {
    try {
      await api.patch(`/api/refill-orders/${id}`, { status });
      setOrders((prev) => (prev ?? []).map((o) => (o.id === id ? { ...o, status } : o)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update refill');
    }
  }

  return (
    <AppShell title="Refills" description="Patients whose medicines are about to run out, and where each refill stands.">
      {error ? (
        <ErrorState error={error} />
      ) : orders === null ? (
        <LoadingState rows={3} />
      ) : orders.length === 0 ? (
        <EmptyState
          title="No refills due"
          description="When a verified prescription's medicines are about to run out, the patient is reminded and the refill shows up here."
          icon={<Pill className="size-5" />}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-5 py-3">Patient</th>
                <th className="px-5 py-3">Medicines</th>
                <th className="px-5 py-3">Runs out</th>
                <th className="px-5 py-3">Pharmacy</th>
                <th className="px-5 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {orders.map((o) => (
                <tr key={o.id}>
                  <td className="px-5 py-3">
                    <p className="font-medium">{o.patient_name}</p>
                    <p className="text-xs text-muted-foreground">{o.patient_phone}</p>
                  </td>
                  <td className="px-5 py-3">{o.medicine_names ?? '—'}</td>
                  <td className="px-5 py-3 text-muted-foreground">{o.due_date ? new Date(o.due_date).toLocaleDateString() : '—'}</td>
                  <td className="px-5 py-3 text-muted-foreground">{o.pharmacy_name ?? '—'}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <select
                        value={o.status}
                        onChange={(e) => void setStatus(o.id, e.target.value as RefillOrder['status'])}
                        aria-label={`Status for ${o.patient_name}`}
                        className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                      {!o.reminded_at && <Badge variant="outline">Reminder not sent</Badge>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
