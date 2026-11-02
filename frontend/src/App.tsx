import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider } from './context/AuthContext';
import { useAuth } from './context/AuthContext';
import { ClinicProvider } from './context/ClinicContext';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Flags from './pages/Flags';
import Prescriptions from './pages/Prescriptions';
import Patients from './pages/Patients';
import Settings from './pages/Settings';
import Analytics from './pages/Analytics';
import Refills from './pages/Refills';
import SuperAdminClinics from './pages/SuperAdminClinics';
import Overview from './pages/admin/Overview';
import Billing from './pages/admin/Billing';
import Usage from './pages/admin/Usage';
import Integrations from './pages/admin/Integrations';
import PlatformHealth from './pages/admin/PlatformHealth';
import AuditLog from './pages/admin/AuditLog';
import AdminSettings from './pages/admin/AdminSettings';

// Hospital staff pages. Super Admin is a platform operator and has no access
// to patient data, so it is sent to its own Overview instead.
function StaffGuard({ children }: { children: React.ReactNode }) {
  const { staff } = useAuth();
  if (!staff) return <Navigate to="/login" replace />;
  if (staff.role === 'super_admin') return <Navigate to="/app/overview" replace />;
  return <>{children}</>;
}

function SuperAdminGuard({ children }: { children: React.ReactNode }) {
  const { staff } = useAuth();
  if (!staff) return <Navigate to="/login" replace />;
  if (staff.role !== 'super_admin') return <Navigate to="/app" replace />;
  return <>{children}</>;
}

const staffRoutes: [string, React.ComponentType][] = [
  ['/app', Dashboard],
  ['/app/flags', Flags],
  ['/app/prescriptions', Prescriptions],
  ['/app/patients', Patients],
  ['/app/analytics', Analytics],
  ['/app/refills', Refills],
  ['/app/settings', Settings],
];

const superAdminRoutes: [string, React.ComponentType][] = [
  ['/app/overview', Overview],
  ['/app/clinics', SuperAdminClinics],
  ['/app/billing', Billing],
  ['/app/usage', Usage],
  ['/app/integrations', Integrations],
  ['/app/health', PlatformHealth],
  ['/app/audit', AuditLog],
  ['/app/account', AdminSettings],
];

export default function App() {
  return (
    <AuthProvider>
      <ClinicProvider>
        <Toaster richColors position="top-right" />
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          {staffRoutes.map(([path, Page]) => (
            <Route key={path} path={path} element={<StaffGuard><Page /></StaffGuard>} />
          ))}
          {superAdminRoutes.map(([path, Page]) => (
            <Route key={path} path={path} element={<SuperAdminGuard><Page /></SuperAdminGuard>} />
          ))}
        </Routes>
      </ClinicProvider>
    </AuthProvider>
  );
}
