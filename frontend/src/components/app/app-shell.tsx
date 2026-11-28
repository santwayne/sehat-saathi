import { NavLink, useLocation } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  Building2,
  CreditCard,
  Flag,
  LayoutDashboard,
  Pill,
  PillBottle,
  Plug,
  ScrollText,
  Settings,
  TrendingUp,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/utils';

// Hospital staff: clinical work for their own hospital.
const CLINIC_NAV = [
  { to: '/app', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/app/flags', label: 'Flags', icon: Flag, end: false },
  { to: '/app/prescriptions', label: 'Prescriptions', icon: Pill, end: false },
  { to: '/app/patients', label: 'Patients', icon: Users, end: false },
  { to: '/app/refills', label: 'Refills', icon: PillBottle, end: false },
  { to: '/app/analytics', label: 'Analytics', icon: BarChart3, end: false },
  { to: '/app/settings', label: 'Settings', icon: Settings, end: false },
] as const;

// Super Admin: runs the platform. No patient-level pages by design.
const SUPER_ADMIN_NAV = [
  { to: '/app/overview', label: 'Overview', icon: LayoutDashboard, end: false },
  { to: '/app/clinics', label: 'Hospitals', icon: Building2, end: false },
  { to: '/app/billing', label: 'Plans & Billing', icon: CreditCard, end: false },
  { to: '/app/usage', label: 'Usage & Profit', icon: TrendingUp, end: false },
  { to: '/app/integrations', label: 'Integrations', icon: Plug, end: false },
  { to: '/app/health', label: 'Platform Health', icon: Activity, end: false },
  { to: '/app/audit', label: 'Audit Log', icon: ScrollText, end: false },
  { to: '/app/account', label: 'Settings', icon: Settings, end: false },
] as const;

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  coordinator: 'Care Coordinator',
  nurse: 'Nurse',
  doctor: 'Doctor',
  super_admin: 'Super Admin',
};

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

  const isSuperAdmin = staff?.role === 'super_admin';
  const visibleNav = isSuperAdmin
    ? SUPER_ADMIN_NAV
    : CLINIC_NAV.filter((item) => {
        // No record pages unless the plan includes records and the hospital is approved.
        const recordsOpen = !staff?.records_access || staff.records_access === 'enabled';
        if (!recordsOpen && item.to !== '/app' && item.to !== '/app/settings') return false;
        if (item.to === '/app/settings') return staff?.role === 'admin';
        if (item.to === '/app/analytics') return staff?.role !== 'doctor';
        return true;
      });

  const pill = 'shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition';
  const pillIdle = 'text-brand-200 hover:text-white hover:ring-1 hover:ring-inset hover:ring-brand-200';
  const pillActive = 'bg-white text-brand-800';

  // Loopdesk AI top bar (same as every Loopdesk tool): crimson bar, logo tile + "Loopdesk AI / Sehat Saathi",
  // pages as pills, who is signed in and Log out on the right. Same pages and rules as before.
  return (
    <div className="min-h-screen w-full bg-background">
      <header className="bg-brand-700 text-white print:hidden">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6 lg:flex-nowrap">
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-white">
              <img src="/brand/loopdesk-icon.png" alt="" width={30} height={30} className="size-[30px] object-contain" />
            </span>
            <span className="text-base font-bold tracking-tight">Loopdesk AI</span>
            <span className="text-lg text-brand-200" aria-hidden>/</span>
            <span className="text-base font-medium">{isSuperAdmin ? 'Sehat Saathi · Console' : 'Sehat Saathi'}</span>
          </div>

          <nav
            className="order-last flex w-full min-w-0 gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] lg:order-none lg:w-auto lg:flex-1"
            aria-label="Main"
          >
            {visibleNav.map((item) => {
              const active = item.end
                ? location.pathname === item.to
                : location.pathname.startsWith(item.to);
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={cn(pill, active ? pillActive : pillIdle)}
                >
                  {item.label}
                </NavLink>
              );
            })}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-4 text-sm">
            <span className="hidden rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white xl:inline">
              {isSuperAdmin
                ? 'Platform operator · never sees patient records'
                : staff?.records_access === 'not_in_plan'
                  ? 'No patient records plan'
                  : staff?.records_access === 'awaiting_approval'
                    ? 'Awaiting approval'
                    : staff?.role === 'doctor'
                      ? 'Your patients only'
                      : 'Clinic-wide'}
            </span>
            <div className="hidden text-right leading-tight sm:block">
              <span className="block max-w-[16rem] truncate font-medium text-white" title={staff?.name}>{staff?.name}</span>
              <span className="block max-w-[16rem] truncate text-xs text-brand-200">
                {ROLE_LABEL[staff?.role ?? ''] ?? staff?.role}
                {!isSuperAdmin && staff?.clinic_name ? ` · ${staff.clinic_name}` : ''}
              </span>
            </div>
            <button onClick={logout} className="font-medium text-brand-200 transition-colors hover:text-white">
              Log out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
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
  );
}
