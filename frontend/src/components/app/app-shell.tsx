import { NavLink, useLocation } from 'react-router-dom';
import { Activity, Flag, LayoutDashboard, LogOut, Pill, Settings, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/app', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/app/flags', label: 'Flags', icon: Flag, end: false },
  { to: '/app/prescriptions', label: 'Prescriptions', icon: Pill, end: false },
  { to: '/app/patients', label: 'Patients', icon: Users, end: false },
  { to: '/app/settings', label: 'Settings', icon: Settings, end: false },
] as const;

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  coordinator: 'Care Coordinator',
  nurse: 'Nurse',
  doctor: 'Doctor',
};

function initials(name: string) {
  return name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function AppShell({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { staff, logout } = useAuth();
  const location = useLocation();

  const visibleNav = NAV.filter(
    (item) => item.to !== '/app/settings' || staff?.role === 'admin',
  );

  return (
    <div className="flex min-h-screen w-full bg-background">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
        <div className="flex items-center gap-2.5 px-5 py-6">
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Activity className="size-5" aria-hidden />
          </span>
          <span className="leading-tight">
            <span className="block font-display text-base font-semibold text-sidebar-foreground">
              Sehat Saathi
            </span>
            <span className="block text-xs text-muted-foreground">Clinic companion</span>
          </span>
        </div>

        <nav className="flex-1 space-y-1 px-3" aria-label="Main">
          {visibleNav.map((item) => {
            const active = item.end
              ? location.pathname === item.to
              : location.pathname.startsWith(item.to);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  active
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                )}
              >
                <item.icon className="size-4" aria-hidden />
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-sidebar-border px-5 py-4 text-xs text-muted-foreground">
          {staff?.clinic_id ? `Clinic ${staff.clinic_id}` : 'Sehat Saathi'}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-border bg-background/95 px-6 py-3.5 backdrop-blur">
          <nav className="flex gap-1 overflow-x-auto md:hidden" aria-label="Main">
            {visibleNav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'rounded-md px-2.5 py-1.5 text-xs font-medium',
                    isActive
                      ? 'bg-secondary text-secondary-foreground'
                      : 'text-muted-foreground',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground sm:inline">
              {staff?.role === 'doctor' ? 'Your patients only' : 'Clinic-wide'}
            </span>
            <div className="text-right leading-tight">
              <span className="block text-sm font-semibold text-foreground">{staff?.name}</span>
              <span className="block text-xs text-muted-foreground">
                {ROLE_LABEL[staff?.role ?? ''] ?? staff?.role}
              </span>
            </div>
            <span
              aria-hidden
              className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
            >
              {initials(staff?.name ?? '?')}
            </span>
            <button
              onClick={logout}
              aria-label="Log out"
              className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              <LogOut className="size-4" aria-hidden />
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">
                {title}
              </h1>
              {description ? (
                <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
              ) : null}
            </div>
            {actions}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
