'use strict';
/** Time helpers. Windows are HH:MM on a given date; math is in minutes-from-midnight. */

/** "HH:MM" -> minutes from midnight. */
function hmToMin(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** minutes from midnight -> "HH:MM". */
function minToHm(min) {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Overlap of two minute-windows [a1,b1],[a2,b2]. */
function overlapMinutes(a1, b1, a2, b2) {
  return Math.max(0, Math.min(b1, b2) - Math.max(a1, a2));
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** YYYY-MM-DD for a Date in UTC-naive terms (we operate on local date strings). */
function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Build the planning horizon list of date strings, starting from `fromDateStr`. */
function horizonDates(fromDateStr, horizonDays, includeToday) {
  const out = [];
  const [y, m, d] = fromDateStr.split('-').map(Number);
  const base = new Date(y, m - 1, d);
  const startOffset = includeToday ? 0 : 1;
  for (let i = startOffset; i < horizonDays + startOffset; i++) {
    const dt = new Date(base);
    dt.setDate(base.getDate() + i);
    out.push(dateStr(dt));
  }
  return out;
}

module.exports = { hmToMin, minToHm, overlapMinutes, clamp, dateStr, horizonDates };
