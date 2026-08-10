import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider } from './context/AuthContext';
import { useAuth } from './context/AuthContext';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Flags from './pages/Flags';
import Prescriptions from './pages/Prescriptions';
import Patients from './pages/Patients';
import Settings from './pages/Settings';

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { staff } = useAuth();
  if (!staff) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <Toaster richColors position="top-right" />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route
          path="/app"
          element={
            <AuthGuard>
              <Dashboard />
            </AuthGuard>
          }
        />
        <Route
          path="/app/flags"
          element={
            <AuthGuard>
              <Flags />
            </AuthGuard>
          }
        />
        <Route
          path="/app/prescriptions"
          element={
            <AuthGuard>
              <Prescriptions />
            </AuthGuard>
          }
        />
        <Route
          path="/app/patients"
          element={
            <AuthGuard>
              <Patients />
            </AuthGuard>
          }
        />
        <Route
          path="/app/settings"
          element={
            <AuthGuard>
              <Settings />
            </AuthGuard>
          }
        />
      </Routes>
    </AuthProvider>
  );
}
