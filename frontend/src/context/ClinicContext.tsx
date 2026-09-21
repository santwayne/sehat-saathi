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
  patient_count: number;
  open_flag_count: number;
  doctor_count: number;
}

interface ClinicContextValue {
  clinics: ClinicSummary[];
  loading: boolean;
  selectedClinicId: string | null;
  setSelectedClinicId: (id: string | null) => void;
  refresh: () => void;
}

const ClinicContext = createContext<ClinicContextValue | null>(null);

// Holds the Super Admin console's "which hospital's data am I currently
// looking at" state (Super Admin spec, A8's clinic-switcher). Only
// meaningful for role === 'super_admin' — other roles are always scoped to
// their own clinic server-side regardless of this value.
export function ClinicProvider({ children }: { children: ReactNode }) {
  const { staff } = useAuth();
  const [clinics, setClinics] = useState<ClinicSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedClinicId, setSelectedClinicIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem('ss_selected_clinic_id');
    } catch {
      return null;
    }
  });

  function setSelectedClinicId(id: string | null) {
    setSelectedClinicIdState(id);
    try {
      if (id) localStorage.setItem('ss_selected_clinic_id', id);
      else localStorage.removeItem('ss_selected_clinic_id');
    } catch {
      // localStorage unavailable (private browsing etc.) — in-memory state still works
    }
  }

  function refresh() {
    if (staff?.role !== 'super_admin') return;
    setLoading(true);
    api
      .get<{ data: ClinicSummary[] }>('/api/clinics')
      .then((res) => {
        setClinics(res.data);
        // Default to the first clinic so the rest of the dashboard has
        // something scoped to show, rather than an all-clinics blend.
        if (!selectedClinicId && res.data.length > 0) {
          setSelectedClinicId(res.data[0].id);
        }
      })
      .catch(() => setClinics([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff?.role]);

  return (
    <ClinicContext.Provider value={{ clinics, loading, selectedClinicId, setSelectedClinicId, refresh }}>
      {children}
    </ClinicContext.Provider>
  );
}

export function useClinicSwitcher() {
  const ctx = useContext(ClinicContext);
  if (!ctx) throw new Error('useClinicSwitcher must be used within ClinicProvider');
  return ctx;
}

/**
 * Resolves the clinic_id query param every data-fetching page should append
 * to its API calls: for a super_admin, the switcher's current selection; for
 * everyone else, undefined (the server already scopes them to their own clinic).
 */
export function useEffectiveClinicId(): string | undefined {
  const { staff } = useAuth();
  const { selectedClinicId } = useClinicSwitcher();
  if (staff?.role === 'super_admin') return selectedClinicId ?? undefined;
  return undefined;
}
