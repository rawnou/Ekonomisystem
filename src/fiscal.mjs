import { validDate } from "./imports.mjs";

// Bokföringslagen 3 kap. 1 och 3 §§. Balans modellerar ett första år.
export function validateFiscalYear(start, end) {
  validDate(start);
  validDate(end);
  const limit = new Date(start + "T00:00:00Z");
  const day = limit.getUTCDate();
  limit.setUTCDate(1);
  limit.setUTCMonth(limit.getUTCMonth() + 18);
  const lastDay = new Date(limit);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  limit.setUTCDate(Math.min(day, lastDay.getUTCDate()));
  if (end < start || new Date(end + "T00:00:00Z") >= limit)
    throw new Error(
      "Ogiltigt räkenskapsår. Ett första räkenskapsår får omfatta högst 18 månader.",
    );
}
