import { useCallback, useEffect, useState } from 'react';
import { HeartHandshake, IdCard, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';

interface FamilyMember {
  id: string;
  name: string | null;
  phone: string;
  relationship: string | null;
  status: 'invited' | 'active' | 'opted_out';
}

const STATUS_LABEL: Record<FamilyMember['status'], string> = {
  invited: 'Waiting for YES',
  active: 'Receiving updates',
  opted_out: 'Opted out',
};

// Family accounts + ABHA link for one patient (roadmap: "Family member
// updates", "ABHA / ABDM health record link"). ABHA here is staff-recorded
// after the patient consents — it is not verified against ABDM yet.
export function FamilyAbhaPanel({
  patientId,
  canEdit,
  abhaNumber,
  abhaAddress,
  onAbhaChanged,
}: {
  patientId: string;
  canEdit: boolean;
  abhaNumber: string | null;
  abhaAddress: string | null;
  onAbhaChanged: (abhaNumber: string | null, abhaAddress: string | null) => void;
}) {
  const [members, setMembers] = useState<FamilyMember[] | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', relationship: '' });
  const [busy, setBusy] = useState(false);
  const [abha, setAbha] = useState({ number: '', address: '', consent: false });
  const [abhaBusy, setAbhaBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<{ data: FamilyMember[] }>(`/api/patients/${patientId}/family-members`)
      .then((r) => setMembers(r.data))
      .catch(() => setMembers([]));
  }, [patientId]);

  useEffect(() => {
    setMembers(null);
    load();
  }, [load]);

  async function addMember(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post<{ invite_delivered: boolean }>(`/api/patients/${patientId}/family-members`, form);
      if (res.invite_delivered) toast.success('Invite sent on WhatsApp');
      else toast.warning('Saved, but the WhatsApp invite could not be delivered');
      setForm({ name: '', phone: '', relationship: '' });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add family member');
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(id: string) {
    try {
      await api.delete(`/api/patients/${patientId}/family-members/${id}`);
      setMembers((prev) => (prev ?? []).filter((m) => m.id !== id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove family member');
    }
  }

  async function saveAbha(e: React.FormEvent) {
    e.preventDefault();
    setAbhaBusy(true);
    try {
      const res = await api.post<{ data: { abha_number: string | null; abha_address: string | null } }>(
        `/api/patients/${patientId}/abha`,
        { abha_number: abha.number || undefined, abha_address: abha.address || undefined, patient_consented: abha.consent },
      );
      onAbhaChanged(res.data.abha_number, res.data.abha_address);
      setAbha({ number: '', address: '', consent: false });
      toast.success('ABHA details recorded');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save ABHA details');
    } finally {
      setAbhaBusy(false);
    }
  }

  async function unlinkAbha() {
    try {
      await api.delete(`/api/patients/${patientId}/abha`);
      onAbhaChanged(null, null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not unlink ABHA');
    }
  }

  const hasAbha = !!(abhaNumber || abhaAddress);

  return (
    <div className="space-y-6 px-4 pb-4">
      <section>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <HeartHandshake className="size-4" aria-hidden /> Family members
        </h3>
        {members === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No family members added yet.</p>
        ) : (
          <ul className="space-y-2">
            {members.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {m.name ?? m.phone}
                    {m.relationship ? <span className="text-muted-foreground"> · {m.relationship}</span> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">{m.phone}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={m.status === 'active' ? 'secondary' : 'outline'}>{STATUS_LABEL[m.status]}</Badge>
                  {canEdit && (
                    <button
                      onClick={() => void removeMember(m.id)}
                      aria-label={`Remove ${m.name ?? m.phone}`}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <form onSubmit={addMember} className="mt-3 grid gap-2 sm:grid-cols-3">
            <Input required placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input required placeholder="+919876543210" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <Input placeholder="Relationship" value={form.relationship} onChange={(e) => setForm({ ...form, relationship: e.target.value })} />
            <Button type="submit" size="sm" disabled={busy} className="sm:col-span-3">
              {busy ? 'Sending invite…' : 'Add & send WhatsApp invite'}
            </Button>
            <p className="text-xs text-muted-foreground sm:col-span-3">
              They only receive updates after replying YES. They can ask questions about the prescription but never reply to check-ins or use the kill switch.
            </p>
          </form>
        )}
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <IdCard className="size-4" aria-hidden /> ABHA health ID
        </h3>
        {hasAbha ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
            <div>
              {abhaNumber && <p className="font-medium">{abhaNumber}</p>}
              {abhaAddress && <p className="text-muted-foreground">{abhaAddress}</p>}
              <p className="mt-1 text-xs text-muted-foreground">Recorded by staff — not yet verified with ABDM.</p>
            </div>
            {canEdit && (
              <Button variant="outline" size="sm" onClick={() => void unlinkAbha()}>
                Unlink
              </Button>
            )}
          </div>
        ) : canEdit ? (
          <form onSubmit={saveAbha} className="space-y-2">
            <Input placeholder="ABHA number (14 digits)" value={abha.number} onChange={(e) => setAbha({ ...abha, number: e.target.value })} />
            <Input placeholder="ABHA address (name@abdm)" value={abha.address} onChange={(e) => setAbha({ ...abha, address: e.target.value })} />
            <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border p-3">
              <input type="checkbox" checked={abha.consent} onChange={(e) => setAbha({ ...abha, consent: e.target.checked })} className="h-4 w-4 accent-primary" />
              <span className="text-sm">Patient consents to linking their ABHA</span>
            </label>
            <Button type="submit" size="sm" disabled={abhaBusy || !abha.consent || (!abha.number && !abha.address)} className="w-full">
              {abhaBusy ? 'Saving…' : 'Record ABHA'}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">No ABHA linked.</p>
        )}
      </section>
    </div>
  );
}
