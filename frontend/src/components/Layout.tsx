import { NavLink, Outlet, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const NAV = [
  { to: '/app', label: 'Dashboard', end: true },
  { to: '/app/flags', label: 'Flags' },
  { to: '/app/prescriptions', label: 'Prescriptions' },
  { to: '/app/patients', label: 'Patients' },
  { to: '/app/settings', label: 'Settings' },
];

export default function Layout() {
  const { staff, logout } = useAuth();

  if (!staff) return <Navigate to="/login" replace />;

  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside className="w-56 shrink-0 border-r border-slate-200 bg-white flex flex-col">
        <div className="px-5 py-5 font-semibold text-teal-800 text-lg">Sehat Saathi</div>
        <nav className="flex-1 px-2 space-y-1">
          {NAV.filter((item) => item.to !== '/app/settings' || staff.role === 'admin').map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm font-medium ${
                  isActive ? 'bg-teal-50 text-teal-800' : 'text-slate-600 hover:bg-slate-100'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-slate-200 bg-white flex items-center justify-end px-6 gap-3">
          <span className="text-sm text-slate-600">
            {staff.name} · <span className="capitalize">{staff.role}</span>
          </span>
          <button onClick={logout} className="text-sm text-slate-500 hover:text-slate-800">
            Log out
          </button>
        </header>
        <main className="flex-1 p-6 min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
