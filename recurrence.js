// Port of the Android app's Recurrence.kt. Keep the two in step.
// Times are fixed to Asia/Kolkata (UTC+05:30, no daylight saving).

export const IST_OFFSET_MIN = 330;
const DAY_MS = 86400000;
const MAX_DAYS = 366 * 20;

export function dayNum(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS);
}
export function isoOf(dn) {
  return new Date(dn * DAY_MS).toISOString().slice(0, 10);
}
export function todayIso(nowMs = Date.now()) {
  return isoOf(Math.floor((nowMs + IST_OFFSET_MIN * 60000) / DAY_MS));
}
export function dayStartMs(iso) {
  return dayNum(iso) * DAY_MS - IST_OFFSET_MIN * 60000;
}
function atMs(dn, h, mi) {
  return dn * DAY_MS + (h * 60 + mi) * 60000 - IST_OFFSET_MIN * 60000;
}
function isoWeekday(dn) {
  return ((new Date(dn * DAY_MS).getUTCDay() + 6) % 7) + 1; // 1=Mon..7=Sun
}
function daysInMonth(dn) {
  const d = new Date(dn * DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

export function isSubDaily(a) {
  return a.type === "INTERVAL" && (a.intervalUnit === "MINUTES" || a.intervalUnit === "HOURS");
}

function matchesDate(a, startDn, dn) {
  switch (a.type) {
    case "DAILY": return true;
    case "WEEKDAYS": return (a.weekdays || []).includes(isoWeekday(dn));
    case "INTERVAL": {
      const step = Math.max(1, a.interval || 1) * (a.intervalUnit === "WEEKS" ? 7 : 1);
      const days = dn - startDn;
      return days >= 0 && days % step === 0;
    }
    case "MONTHLY": {
      const last = daysInMonth(dn);
      const dom = new Date(dn * DAY_MS).getUTCDate();
      const target = a.dayOfMonth === -1 ? last : Math.min(Math.max(1, a.dayOfMonth || 1), last);
      return dom === target;
    }
    default: return false;
  }
}

/** Generator of occurrence times (ms), in order. fromMs lets sub-daily alarms jump ahead. */
export function* occurrences(a, fromMs = null) {
  const h = Math.min(23, Math.max(0, a.hour ?? 9));
  const mi = Math.min(59, Math.max(0, a.minute ?? 0));
  if (a.type === "ONCE") {
    const dn = dayNum(a.date);
    if (dn != null) yield atMs(dn, h, mi);
    return;
  }
  const startDn = dayNum(a.startDate);
  if (startDn == null) return;
  const endDn = dayNum(a.endDate);
  const max = a.maxCount ?? null;

  if (isSubDaily(a)) {
    const start = atMs(startDn, h, mi);
    const step = Math.max(1, a.interval || 1) * (a.intervalUnit === "HOURS" ? 60 : 1) * 60000;
    const endEx = endDn != null ? (endDn + 1) * DAY_MS - IST_OFFSET_MIN * 60000 : null;
    let k = 0;
    if (fromMs != null && fromMs > start) k = Math.ceil((fromMs - start) / step);
    for (let i = 0; i < 1000000; i++, k++) {
      if (max != null && k >= max) return;
      const t = start + k * step;
      if (endEx != null && t >= endEx) return;
      yield t;
    }
    return;
  }

  let count = 0;
  for (let dn = startDn; dn <= startDn + MAX_DAYS; dn++) {
    if (endDn != null && dn > endDn) return;
    if (!matchesDate(a, startDn, dn)) continue;
    if (max != null && count >= max) return;
    count++;
    yield atMs(dn, h, mi);
  }
}

export function nextOccurrence(a, afterMs) {
  for (const t of occurrences(a, isSubDaily(a) ? afterMs : null)) if (t > afterMs) return t;
  return null;
}

export function occurrencesBetween(a, fromMs, toMs) {
  const out = [];
  for (const t of occurrences(a, isSubDaily(a) ? fromMs : null)) {
    if (t < fromMs) continue;
    if (t >= toMs) break;
    out.push(t);
  }
  return out;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function ordinal(n) {
  const s = (n % 100 >= 11 && n % 100 <= 13) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
  return n + s;
}

export function describe(a) {
  const t = String(a.hour).padStart(2, "0") + ":" + String(a.minute).padStart(2, "0");
  let base;
  switch (a.type) {
    case "ONCE": base = `${a.date || "?"} at ${t}`; break;
    case "DAILY": base = `Every day at ${t}`; break;
    case "WEEKDAYS": base = [...(a.weekdays || [])].sort().map(d => DAY_NAMES[d - 1]).join(", ") + ` at ${t}`; break;
    case "INTERVAL": {
      const unit = { MINUTES: "minute", HOURS: "hour", DAYS: "day", WEEKS: "week" }[a.intervalUnit] || "day";
      const every = a.interval === 1 ? `Every ${unit}` : `Every ${a.interval} ${unit}s`;
      base = isSubDaily(a) ? `${every} from ${t}` : `${every} at ${t}`;
      break;
    }
    case "MONTHLY": base = `Monthly on the ${a.dayOfMonth === -1 ? "last day" : ordinal(a.dayOfMonth)} at ${t}`; break;
    default: base = t;
  }
  const extras = [];
  if (a.endDate) extras.push(`until ${a.endDate}`);
  if (a.maxCount) extras.push(`${a.maxCount} times`);
  if (a.preAlertMin > 0) extras.push(`warn ${a.preAlertMin} min before`);
  return extras.length ? `${base} (${extras.join(", ")})` : base;
}
