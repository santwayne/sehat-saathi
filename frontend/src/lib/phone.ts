/**
 * Phone helpers for the dashboard (bug list 27 Nov 2026, #3). The server
 * saves every number as "91XXXXXXXXXX" (services/phone.js); these only make
 * numbers readable and give the same hint on every form.
 */

/** "919876543210" → "+91 98765 43210"; anything else is shown as given. */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  const d = phone.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  if (/^\d{11,15}$/.test(d)) return `+${d}`;
  return phone;
}

export const PHONE_HINT = '10-digit mobile number, e.g. 98765 43210 (+91 is added automatically).';
export const PHONE_PLACEHOLDER = '98765 43210';
