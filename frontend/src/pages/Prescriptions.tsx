import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ClipboardCheck,
  Clock,
  FileText,
  Loader2,
  Phone,
  ShieldAlert,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/app-shell';
import { EmptyState, ErrorState, LoadingState } from '@/components/app/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

type Confidence = 'high' | 'medium' | 'low';

interface Medicine {
  name: string;
  dosage: string;
  frequency: string;
  timing: string;
  duration: string;
  confidence: Confidence;
}

interface StructuredRx {
  diagnosis: string | null;
  follow_up_date: string | null;
  medicines: Medicine[];
  overall_confidence: Confidence;
  illegible_notes_flag: boolean;
}

interface PendingPrescription {
  id: string;
  image_url: string;
  ocr_raw_text: string;
  structured_json: StructuredRx;
  ocr_confidence: Confidence;
  created_at: string;
  patient_name: string;
  patient_phone: string;
  language_pref: string;
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function ConfidenceBadge({ level }: { level: Confidence }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
        level === 'high' && 'bg-success-surface text-foreground',
        level === 'medium' && 'bg-secondary text-secondary-foreground',
        level === 'low' && 'bg-warning-surface text-warning-foreground',
      )}
    >
      {level === 'low' && <AlertTriangle className="size-3" />}
      {level}
    </span>
  );
}

function FieldInput({
  label,
  value,
  low,
  onChange,
}: {
  label: string;
  value: string;
  low: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(low && 'border-warning bg-card')}
      />
    </div>
  );
}

function DetailPanel({
  prescription,
  submitting,
  onApprove,
}: {
  prescription: PendingPrescription;
  submitting: boolean;
  onApprove: (structured: StructuredRx) => void;
}) {
  const [draft, setDraft] = useState<StructuredRx>(() => ({
    ...prescription.structured_json,
    medicines: prescription.structured_json.medicines.map((m) => ({ ...m })),
  }));
  const [showRaw, setShowRaw] = useState(false);
  const [zoom, setZoom] = useState(1);

  const needsAttention =
    prescription.ocr_confidence !== 'high' || prescription.structured_json.illegible_notes_flag;

  const updateMedicine = (
    index: number,
    field: keyof Medicine,
    value: string,
  ) => {
    setDraft((prev) => ({
      ...prev,
      medicines: prev.medicines.map((m, i) => (i === index ? { ...m, [field]: value } : m)),
    }));
  };

  return (
    <section className="grid gap-6 xl:grid-cols-2">
      <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Original prescription
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Zoom out"
              onClick={() => setZoom((z) => Math.max(1, +(z - 0.25).toFixed(2)))}
            >
              <ZoomOut className="size-4" />
            </Button>
            <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">
              {Math.round(zoom * 100)}%
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Zoom in"
              onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}
            >
              <ZoomIn className="size-4" />
            </Button>
          </div>
        </div>
        <div className="h-[calc(100vh-13rem)] min-h-[420px] overflow-auto p-3">
          <img
            src={prescription.image_url}
            alt={`Prescription submitted by ${prescription.patient_name}`}
            className="mx-auto w-full origin-top rounded-lg shadow-sm"
            style={{ transform: `scale(${zoom})` }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {needsAttention && (
          <div className="flex items-start gap-3 rounded-xl border border-warning-border bg-warning-surface p-4">
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning-foreground" />
            <div className="text-sm text-warning-foreground">
              <p className="font-semibold">Extra care required before approving</p>
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                {prescription.ocr_confidence !== 'high' && (
                  <li>
                    OCR confidence is <strong>{prescription.ocr_confidence}</strong> — verify every
                    field against the image.
                  </li>
                )}
                {prescription.structured_json.illegible_notes_flag && (
                  <li>Illegible notes were detected on this prescription.</li>
                )}
              </ul>
            </div>
          </div>
        )}

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold">{prescription.patient_name}</h2>
              <p className="text-xs text-muted-foreground">
                {prescription.patient_phone} · {prescription.language_pref} · submitted{' '}
                {timeAgo(prescription.created_at)}
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              OCR <ConfidenceBadge level={prescription.ocr_confidence} />
            </div>
          </div>

          <Separator className="my-4" />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="diagnosis">Diagnosis</Label>
              <Input
                id="diagnosis"
                value={draft.diagnosis ?? ''}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, diagnosis: e.target.value || null }))
                }
                placeholder="Not extracted — enter from image"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="follow_up">Follow-up date</Label>
              <Input
                id="follow_up"
                type="date"
                value={draft.follow_up_date ?? ''}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, follow_up_date: e.target.value || null }))
                }
              />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Medicines ({draft.medicines.length})
          </h3>
          <div className="mt-3 space-y-4">
            {draft.medicines.map((med, index) => {
              const low = med.confidence === 'low';
              return (
                <div
                  key={index}
                  className={cn(
                    'rounded-lg border p-3',
                    low ? 'border-warning-border bg-warning-surface' : 'border-border bg-background',
                  )}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-muted-foreground">
                      #{index + 1}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {low && (
                        <span className="flex items-center gap-1 text-xs font-semibold text-warning-foreground">
                          <AlertTriangle className="size-3.5" />
                          Low confidence — check against image
                        </span>
                      )}
                      <ConfidenceBadge level={med.confidence} />
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FieldInput label="Name" value={med.name} low={low} onChange={(v) => updateMedicine(index, 'name', v)} />
                    <FieldInput label="Dosage" value={med.dosage} low={low} onChange={(v) => updateMedicine(index, 'dosage', v)} />
                    <FieldInput label="Frequency" value={med.frequency} low={low} onChange={(v) => updateMedicine(index, 'frequency', v)} />
                    <FieldInput label="Timing" value={med.timing} low={low} onChange={(v) => updateMedicine(index, 'timing', v)} />
                    <FieldInput label="Duration" value={med.duration} low={low} onChange={(v) => updateMedicine(index, 'duration', v)} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card">
          <button
            type="button"
            onClick={() => setShowRaw((s) => !s)}
            className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium"
            aria-expanded={showRaw}
          >
            <FileText className="size-4 text-muted-foreground" />
            Raw OCR text
            <ChevronDown
              className={cn(
                'ml-auto size-4 text-muted-foreground transition-transform',
                showRaw && 'rotate-180',
              )}
            />
          </button>
          {showRaw && (
            <pre className="max-h-64 overflow-auto border-t border-border bg-surface px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {prescription.ocr_raw_text}
            </pre>
          )}
        </div>

        <div className="sticky bottom-0 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
          <p className="mr-auto text-xs text-muted-foreground">
            Approving activates the patient&apos;s check-in schedule immediately.
          </p>
          <Button size="lg" disabled={submitting} onClick={() => onApprove(draft)} className="min-w-48">
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Activating…
              </>
            ) : (
              <>
                <ClipboardCheck className="size-4" />
                Approve &amp; Activate
              </>
            )}
          </Button>
        </div>
      </div>
    </section>
  );
}

export default function Prescriptions() {
  const { staff } = useAuth();
  const [queue, setQueue] = useState<PendingPrescription[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const scope = staff?.role === 'doctor' ? 'Your patients only' : 'Clinic-wide';

  useEffect(() => {
    setLoading(true);
    api
      .get<{ data: PendingPrescription[] }>('/api/prescriptions/pending')
      .then((r) => {
        setQueue(r.data);
        if (r.data.length > 0 && !selectedId) setSelectedId(r.data[0]!.id);
      })
      .catch((e) => setError(e))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (queue.length === 0) { setSelectedId(null); return; }
    if (!selectedId || !queue.some((p) => p.id === selectedId)) {
      setSelectedId(queue[0]!.id);
    }
  }, [queue, selectedId]);

  const selected = useMemo(() => queue.find((p) => p.id === selectedId) ?? null, [queue, selectedId]);

  async function approve(structured_json: StructuredRx) {
    if (!selected || !staff) return;
    setSubmitting(true);
    try {
      await api.post(`/api/prescriptions/${selected.id}/verify`, {
        structured_json,
        staff_user_id: staff.id,
      });
      const patientName = selected.patient_name;
      setQueue((prev) => prev.filter((p) => p.id !== selected.id));
      toast.success('Prescription approved & activated', {
        description: `Check-in schedule is now active for ${patientName}.`,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Verification failed. Nothing was sent to the patient.');
    } finally {
      setSubmitting(false);
    }
  }

  const query = {
    data: queue.length > 0 || !loading ? queue : undefined,
    isPending: loading,
    isError: !!error,
    error,
    refetch: () => {
      setLoading(true);
      setError(null);
      api
        .get<{ data: PendingPrescription[] }>('/api/prescriptions/pending')
        .then((r) => setQueue(r.data))
        .catch((e) => setError(e))
        .finally(() => setLoading(false));
    },
  };

  return (
    <AppShell
      title="Prescriptions"
      description={`${scope} — manual verification queue.`}
      actions={
        <Badge variant="outline" className="border-border text-muted-foreground">
          {queue.length} pending
        </Badge>
      }
    >
      {loading ? (
        <LoadingState rows={3} label="Loading prescription queue…" />
      ) : error ? (
        <ErrorState error={error} onRetry={query.refetch} />
      ) : queue.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck className="size-6" aria-hidden />}
          title="Queue cleared"
          description="No prescriptions awaiting verification."
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Queue — oldest first
            </h2>
            <ul className="space-y-2">
              {queue.map((rx) => (
                <li key={rx.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(rx.id)}
                    className={cn(
                      'w-full rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary/50',
                      rx.id === selectedId
                        ? 'border-primary ring-1 ring-primary'
                        : 'border-border',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium leading-tight">{rx.patient_name}</p>
                      <ConfidenceBadge level={rx.ocr_confidence} />
                    </div>
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <Phone className="size-3" />
                      {rx.patient_phone}
                    </p>
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="size-3" />
                      {timeAgo(rx.created_at)} · {rx.language_pref}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          {selected ? (
            <DetailPanel
              key={selected.id}
              prescription={selected}
              submitting={submitting}
              onApprove={approve}
            />
          ) : (
            <section className="flex min-h-[400px] items-center justify-center rounded-xl border border-dashed border-border bg-card">
              <p className="text-sm text-muted-foreground">
                Select a prescription from the queue to begin verification.
              </p>
            </section>
          )}
        </div>
      )}
    </AppShell>
  );
}
