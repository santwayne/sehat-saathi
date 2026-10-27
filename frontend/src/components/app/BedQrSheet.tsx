import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Printer } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/lib/api';

interface Bed {
  id: string;
  label: string;
  ward: string | null;
  code: string;
  link: string | null;
  patient_name: string | null;
}

// Roadmap "QR code at every hospital bed": one printable QR per bed. Scanning
// opens WhatsApp with the bed's code prefilled, so the patient is tied to
// their bed from the very first message.
export function BedQrSheet({
  clinicId,
  clinicName,
  open,
  onOpenChange,
}: {
  clinicId: string;
  clinicName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [beds, setBeds] = useState<Bed[]>([]);
  const [qrs, setQrs] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ prefix: '', from: '1', to: '10', ward: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<{ data: Bed[] }>(`/api/beds?clinic_id=${clinicId}`)
      .then((r) => setBeds(r.data))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Could not load beds'));
  }, [clinicId]);

  useEffect(() => {
    if (open && clinicId) load();
  }, [open, clinicId, load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const b of beds) {
        if (b.link) next[b.id] = await QRCode.toDataURL(b.link, { width: 320, margin: 1, color: { dark: '#16302c', light: '#ffffff' } });
      }
      if (!cancelled) setQrs(next);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [beds]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post<{ data: Bed[]; skipped: number }>('/api/beds', {
        clinic_id: clinicId,
        prefix: form.prefix,
        from: Number(form.from),
        to: Number(form.to),
        ward: form.ward || undefined,
      });
      toast.success(`${res.data.length} bed(s) created${res.skipped ? `, ${res.skipped} already existed` : ''}`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create beds');
    } finally {
      setBusy(false);
    }
  }

  async function retire(id: string) {
    try {
      await api.delete(`/api/beds/${id}`);
      setBeds((prev) => prev.filter((b) => b.id !== id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove bed');
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{clinicName} — bed QR codes</SheetTitle>
          <SheetDescription>
            Print one per bed. A patient who scans it opens WhatsApp and enrolls themselves, already linked to their bed.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={create} className="no-print mt-4 grid grid-cols-2 gap-2 px-4 sm:grid-cols-5">
          <Input placeholder="Prefix (A-)" value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} />
          <Input required type="number" min={0} placeholder="From" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
          <Input required type="number" min={0} placeholder="To" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
          <Input placeholder="Ward" value={form.ward} onChange={(e) => setForm({ ...form, ward: e.target.value })} />
          <Button type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add beds'}</Button>
        </form>

        {beds.length > 0 && (
          <div className="no-print mt-3 px-4">
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="mr-1.5 size-4" /> Print all
            </Button>
          </div>
        )}

        <style>{`
          @media print {
            body * { visibility: hidden; }
            [data-bed-sheet], [data-bed-sheet] * { visibility: visible; }
            [data-bed-sheet] { position: absolute; left: 0; top: 0; width: 100%; }
            .no-print { display: none !important; }
          }
        `}</style>
        <div data-bed-sheet className="mt-4 grid grid-cols-2 gap-3 px-4 pb-6 sm:grid-cols-3">
          {beds.length === 0 ? (
            <p className="col-span-full py-8 text-center text-sm text-muted-foreground">No beds yet — add a range above.</p>
          ) : (
            beds.map((b) => (
              <div key={b.id} className="break-inside-avoid rounded-xl border border-border bg-card p-3 text-center">
                {qrs[b.id] ? (
                  <img src={qrs[b.id]} alt={`QR for bed ${b.label}`} className="mx-auto size-32" />
                ) : (
                  <div className="mx-auto flex size-32 items-center justify-center text-xs text-muted-foreground">
                    {b.link ? '…' : 'No WhatsApp number'}
                  </div>
                )}
                <p className="mt-1 font-display text-base font-semibold">Bed {b.label}</p>
                {b.ward && <p className="text-xs text-muted-foreground">{b.ward}</p>}
                <p className="text-xs text-muted-foreground">Scan to connect on WhatsApp</p>
                <button onClick={() => void retire(b.id)} className="no-print mt-1 text-xs text-muted-foreground hover:text-destructive">
                  Remove
                </button>
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
