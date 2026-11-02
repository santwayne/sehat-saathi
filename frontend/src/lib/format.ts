// Formatting helpers for the Super Admin console.

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
export const formatINR = (v: number | null | undefined) => (v === null || v === undefined ? '—' : inr.format(v));

export function formatDate(v: string | null | undefined) {
  if (!v) return '—';
  // Plain YYYY-MM-DD strings are calendar dates: show as-is, no timezone shift.
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  return new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(v: string | null | undefined) {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Standard table cell padding for admin tables.
export const td = 'px-4 py-2.5 align-top';
