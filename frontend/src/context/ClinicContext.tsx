import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { api } from '../lib/api';

export interface ClinicSummary {
  id: string;
  name: string;
  address?: string | null;
  whatsapp_number: string;
  whatsapp_phone_number_id?: string | null;
  status: 'active' | 'suspended' | 'onboarding';
  records_mode: 'with_records' | 'without_records';
  patient_count: number;
  doctor_count: number;
}

interface ClinicContextValue {
  clinics: ClinicSummary[];
  loading: boolean;
  refresh: () => void;
}

const ClinicContext = createContext<ClinicContextValue | null>(null);

// The Super Admin console's list of hospitals (Hospitals page, and the
// hospital pickers on Billing / Audit Log). There is no longer a "which
// hospital am I viewing" switcher: Super Admin does not browse a hospital's
// patient data.
export function ClinicProvider({ children }: { children: ReactNode }) {
  const { staff } = useAuth();
  const [clinics, setClinics] = useState<ClinicSummary[]>([]);
  const [loading, setLoading] = useState(false);

  function refresh() {
    if (staff?.role !== 'super_admin') return;
    setLoading(true);
    api
      .get<{ data: ClinicSummary[] }>('/api/clinics')
      .then((res) => setClinics(res.data))
      .catch(() => setClinics([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    // The old switcher persisted its selection; clear it so nothing stale lingers.
    try {
      localStorage.removeItem('ss_selected_clinic_id');
    } catch {
      // localStorage unavailable — nothing to clear
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff?.role]);

  return <ClinicContext.Provider value={{ clinics, loading, refresh }}>{children}</ClinicContext.Provider>;
}

export function useClinicSwitcher() {
  const ctx = useContext(ClinicContext);
  if (!ctx) throw new Error('useClinicSwitcher must be used within ClinicProvider');
  return ctx;
}

/**
 * clinic_id query param for the hospital-staff pages (Dashboard, Patients,
 * Flags, Prescriptions, Refills, Analytics). Hospital staff are scoped
 * server-side from their token, and Super Admin no longer reaches these
 * pages, so this is always undefined. Kept so those pages need no changes.
 */
export function useEffectiveClinicId(): string | undefined {
  return undefined;
}
