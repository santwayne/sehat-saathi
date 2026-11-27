/**
 * One phone format everywhere (bug list 27 Nov 2026, #3).
 *
 * Before this, the same person could be saved as "918264161658",
 * "7986032428" or "+91 70870 64479" depending on which screen saved them.
 * Login and the WhatsApp webhook both compare numbers, so one person could
 * sign in with one form and fail with another, and a family member saved
 * without 91 never matched their own WhatsApp reply.
 *
 * Canonical form = E.164 digits without the "+": "91XXXXXXXXXX".
 * No "+" on purpose: WhatsApp sends sender ids as bare digits
 * ("917087064479") and every webhook lookup compares against that.
 *
 *   "+91 98765 43210" → "919876543210"
 *   "09876543210"     → "919876543210"   (leading trunk 0)
 *   "9876543210"      → "919876543210"   (10 digits = Indian mobile)
 *   "00919876543210"  → "919876543210"   (international 00 prefix)
 *   "14165550123"     → "14165550123"    (already has a country code)
 */
const DEFAULT_COUNTRY_CODE = '91';

/** Digits only, nothing else changed. Use for ids WhatsApp itself sends. */
function digitsOnly(phone) {
  return String(phone ?? '').replace(/\D/g, '');
}

/** Typed / stored number → canonical "91XXXXXXXXXX". Returns '' for empty input. */
function normalizePhone(phone) {
  const raw = String(phone ?? '').trim();
  // "+65 9123 4567" / "0065…" already says which country it is: keep it.
  const hasCountryCode = raw.startsWith('+') || raw.startsWith('00');
  let d = digitsOnly(raw).replace(/^0+/, '');
  if (d.length === 10 && !hasCountryCode) d = `${DEFAULT_COUNTRY_CODE}${d}`;
  return d;
}

/** 10–15 digits after normalising (E.164 allows at most 15). */
function isValidPhone(normalized) {
  return /^\d{10,15}$/.test(String(normalized ?? ''));
}

/**
 * Every stored form an older row might still have for this number, so a
 * lookup finds rows saved before migration 011 too: "919876543210",
 * "9876543210", "09876543210".
 */
function phoneVariants(phone) {
  const canonical = normalizePhone(phone);
  const out = new Set([canonical, digitsOnly(phone)]);
  if (canonical.startsWith(DEFAULT_COUNTRY_CODE) && canonical.length === 12) {
    const national = canonical.slice(2);
    out.add(national);
    out.add(`0${national}`);
  }
  out.delete('');
  return [...out];
}

module.exports = { DEFAULT_COUNTRY_CODE, digitsOnly, normalizePhone, isValidPhone, phoneVariants };
