import { Clock, ShieldOff } from 'lucide-react';
import { AppShell } from '@/components/app/app-shell';
import { useAuth } from '@/context/AuthContext';

/** Shown instead of a patient-record page when the hospital can't open records. */
export function RecordsUnavailable() {
  const { staff } = useAuth();
  const waiting = staff?.records_access === 'awaiting_approval';
  const suspended = staff?.records_access === 'suspended';

  return (
    <AppShell title={waiting ? 'Waiting for approval' : 'Patient records'}>
      <div className="mx-auto max-w-xl rounded-xl border border-border bg-card p-8 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
          {waiting ? <Clock className="size-6" aria-hidden /> : <ShieldOff className="size-6" aria-hidden />}
        </div>
        {waiting ? (
          <>
            <h2 className="font-display text-lg font-semibold text-foreground">Your hospital is being set up</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Patient records open as soon as Sehat Saathi approves your hospital. Meanwhile you can add staff, doctors
              and bed QR codes from Settings.
            </p>
          </>
        ) : suspended ? (
          <>
            <h2 className="font-display text-lg font-semibold text-foreground">Hospital suspended</h2>
            <p className="mt-2 text-sm text-muted-foreground">Please contact Sehat Saathi support.</p>
          </>
        ) : (
          <>
            <h2 className="font-display text-lg font-semibold text-foreground">Patient records are not part of your plan</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Your hospital is on a plan without patient records, so Sehat Saathi does not store any patient data for
              you. To keep and manage patient records, ask Sehat Saathi to move you to a plan with patient records.
            </p>
          </>
        )}
      </div>
    </AppShell>
  );
}
