import { useEffect, useState, useCallback } from 'react';
import {
  AlertTriangle,
  CalendarX,
  CheckCircle2,
  ChevronDown,
  HelpCircle,
  PillBottle,
  ScanLine,
  ShieldCheck,
  Thermometer,
} from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/app-shell';
import { AsyncSection, EmptyState } from '@/components/app/states';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ApiFlag {
  id: string;
  flag_type: string;
  priority: 'urgent' | 'normal';
  status: string;
  created_at: string;
  patient_id: string;
  patient_name: string;
  patient_phone: string | null;
  doctor_name: string | null;
}

const FLAG_TYPE_META: Record<string, { label: string; icon: typeof PillBottle; className: string }> = {
  missed_dose: { label: 'Missed dose', icon: PillBottle, className: 'bg-warning-surface text-warning-foreground' },
  symptom_reported: { label: 'Symptom reported', icon: Thermometer, className: 'bg-destructive/10 text-destructive' },
  unanswerable_question: { label: 'Unanswerable question', icon: HelpCircle, className: 'bg-secondary text-secondary-foreground' },
  no_show_risk: { label: 'No-show risk', icon: CalendarX, className: 'bg-accent text-accent-foreground' },
  ocr_low_confidence: { label: 'OCR low confidence', icon: ScanLine, className: 'bg-muted text-muted-foreground' },
};

function relativeTime(iso: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function FlagTypeBadge({ type }: { type: string }) {
  const meta = FLAG_TYPE_META[type] ?? { label: type, icon: AlertTriangle, className: 'bg-muted text-muted-foreground' };
  const Icon = meta.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium', meta.className)}>
      <Icon className="size-3.5" aria-hidden />
      {meta.label}
    </span>
  );
}

function KillSwitchRow({ flag }: { flag: ApiFlag }) {
  const [active, setActive] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function apply(next: boolean) {
    setBusy(true);
    try {
      await api.post(`/api/flags/patients/${flag.patient_id}/kill-switch`, { active: next });
      setActive(next);
      toast.success(
        next
          ? `Automated messages stopped for ${flag.patient_name}`
          : `Automated messages resumed for ${flag.patient_name}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Kill switch failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-background p-4">
      <div>
        <p className="text-sm font-semibold text-foreground">Kill switch</p>
        <p className="mt-0.5 max-w-md text-xs text-muted-foreground">
          Stops all automated check-ins and AI replies to {flag.patient_name}.
        </p>
      </div>
      <Switch
        checked={active}
        disabled={busy}
        aria-label={`Kill switch for ${flag.patient_name}`}
        onCheckedChange={(next) => (next ? setConfirming(true) : apply(false))}
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn on the kill switch?</AlertDialogTitle>
            <AlertDialogDescription>
              This will stop all automated check-ins and AI replies to this patient immediately.
              Clinic staff will need to follow up manually.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirming(false); void apply(true); }}>
              Stop messages
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FlagRow({
  flag,
  status,
  expanded,
  onToggle,
  onResolved,
}: {
  flag: ApiFlag;
  status: 'open' | 'resolved';
  expanded: boolean;
  onToggle: () => void;
  onResolved: (id: string) => void;
}) {
  const { staff } = useAuth();
  const [busy, setBusy] = useState(false);
  const urgent = flag.priority === 'urgent';

  async function resolve() {
    if (!staff) return;
    setBusy(true);
    try {
      await api.patch(`/api/flags/${flag.id}/resolve`, { staff_id: staff.id });
      onResolved(flag.id);
      toast.success('Flag resolved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't resolve this flag");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className={cn(
        'border-b border-border last:border-0',
        urgent
          ? 'border-l-4 border-l-destructive bg-destructive/[0.03]'
          : 'border-l-4 border-l-transparent',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full flex-wrap items-start justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/40"
      >
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide',
                urgent
                  ? 'bg-destructive text-destructive-foreground'
                  : 'bg-secondary text-secondary-foreground',
              )}
            >
              {urgent ? <AlertTriangle className="size-3.5" aria-hidden /> : null}
              {flag.priority}
            </span>
            <FlagTypeBadge type={flag.flag_type} />
          </div>
          <p className="text-sm font-semibold text-foreground">
            {flag.patient_name}
            {flag.patient_phone ? (
              <span className="ml-2 font-normal text-muted-foreground">{flag.patient_phone}</span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {flag.doctor_name ? `Dr. ${flag.doctor_name}` : 'Unassigned — coordinator queue'} ·{' '}
            {relativeTime(flag.created_at)}
          </p>
        </div>
        <ChevronDown
          className={cn('mt-1 size-4 text-muted-foreground transition-transform', expanded && 'rotate-180')}
          aria-hidden
        />
      </button>

      {expanded ? (
        <div className="space-y-4 border-t border-border bg-muted/30 px-5 py-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Raised</dt>
              <dd className="text-foreground">{new Date(flag.created_at).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Assigned doctor</dt>
              <dd className="text-foreground">{flag.doctor_name ?? 'Unassigned — coordinator queue'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Patient ID</dt>
              <dd className="text-foreground">{flag.patient_id}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Status</dt>
              <dd className="text-foreground capitalize">{flag.status}</dd>
            </div>
          </dl>

          <KillSwitchRow flag={flag} />

          {status === 'open' ? (
            <Button onClick={resolve} disabled={busy}>
              <CheckCircle2 className="size-4" aria-hidden />
              {busy ? 'Resolving…' : 'Resolve flag'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export default function Flags() {
  const { staff } = useAuth();
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [flags, setFlags] = useState<ApiFlag[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const scope = staff?.role === 'doctor' ? 'Your patients only' : 'Clinic-wide';

  const load = useCallback(async () => {
    if (!staff) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ data: ApiFlag[] }>(
        `/api/flags?status=${status}&role=${staff.role}&staff_id=${staff.id}`,
      );
      setFlags(res.data);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [staff, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const query = {
    data: flags ?? undefined,
    isPending: loading,
    isError: !!error,
    error,
    refetch: load,
  };

  return (
    <AppShell
      title="Flags"
      description={`${scope} — triage queue for safety signals raised from patient conversations.`}
      actions={
        <div className="flex rounded-lg border border-border bg-card p-1" role="tablist">
          {(['open', 'resolved'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={status === value}
              onClick={() => { setStatus(value); setExpandedId(null); }}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors',
                status === value
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {value}
            </button>
          ))}
        </div>
      }
    >
      <AsyncSection
        query={query}
        empty={
          <EmptyState
            icon={<ShieldCheck className="size-6" aria-hidden />}
            title={status === 'open' ? 'No open flags' : 'No resolved flags'}
            description={
              status === 'open'
                ? 'Every flag has been reviewed and resolved. Nothing needs your attention right now.'
                : 'Resolved flags will be listed here once staff close them out.'
            }
          />
        }
      >
        {(rows) => (
          <ul className="overflow-hidden rounded-xl border border-border bg-card">
            {rows.map((flag) => (
              <FlagRow
                key={flag.id}
                flag={flag}
                status={status}
                expanded={expandedId === flag.id}
                onToggle={() => setExpandedId(expandedId === flag.id ? null : flag.id)}
                onResolved={(id) => setFlags((prev) => prev?.filter((f) => f.id !== id) ?? prev)}
              />
            ))}
          </ul>
        )}
      </AsyncSection>
    </AppShell>
  );
}
