import { createContext, useContext, useState, type ReactNode } from 'react';
import { api } from '../lib/api';

export interface Staff {
  id: string;
  clinic_id: string;
  name: string;
  role: 'admin' | 'coordinator' | 'nurse' | 'doctor';
  phone: string;
}

interface AuthContextValue {
  staff: Staff | null;
  login: (phone: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [staff, setStaff] = useState<Staff | null>(() => {
    const raw = localStorage.getItem('ss_staff');
    return raw ? JSON.parse(raw) : null;
  });

  async function login(phone: string, password: string) {
    const res = await api.post<{ token: string; staff: Staff }>('/api/auth/login', { phone, password });
    localStorage.setItem('ss_token', res.token);
    localStorage.setItem('ss_staff', JSON.stringify(res.staff));
    setStaff(res.staff);
  }

  function logout() {
    localStorage.removeItem('ss_token');
    localStorage.removeItem('ss_staff');
    setStaff(null);
  }

  return <AuthContext.Provider value={{ staff, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
