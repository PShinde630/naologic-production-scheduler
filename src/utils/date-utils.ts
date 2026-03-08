import { DateTime } from "luxon";
import { MaintenanceWindow, Shift } from "../reflow/types";

interface Range {
  start: DateTime;
  end: DateTime;
}

function toUtcDateTime(date: Date): DateTime {
  // Keep all calculations in UTC to avoid timezone confusion.
  return DateTime.fromJSDate(date, { zone: "utc" });
}

function toDocDayOfWeek(dateTime: DateTime): number {
  // Luxon weekday: Monday=1 ... Sunday=7, doc format: Sunday=0 ... Saturday=6
  return dateTime.weekday % 7;
}

export function parseIso(input: string): Date {
  // Parse ISO string safely and fail fast on bad values.
  const parsed = DateTime.fromISO(input, { zone: "utc" });
  if (!parsed.isValid) {
    throw new Error(`Invalid ISO date: ${input}`);
  }
  return parsed.toJSDate();
}

export function formatIso(date: Date): string {
  // Output with milliseconds so results are consistent in logs/tests.
  return toUtcDateTime(date).toISO({ suppressMilliseconds: false }) ?? date.toISOString();
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

export function addMinutes(date: Date, minutes: number): Date {
  // Adds working/non-working agnostic minutes to a timestamp.
  return toUtcDateTime(date).plus({ minutes }).toJSDate();
}

export function minutesBetween(start: Date, end: Date): number {
  // Returns non-negative minute difference, floored.
  const diff = toUtcDateTime(end).diff(toUtcDateTime(start), "minutes").minutes;
  return Math.max(0, Math.floor(diff));
}

export function clampToHourUTC(date: Date, hour: number): Date {
  // Example: 2026-03-09T12:34 + hour=8 => 2026-03-09T08:00:00Z
  return toUtcDateTime(date).startOf("day").plus({ hours: hour }).toJSDate();
}

export function shiftWindowForDate(date: Date, shift: Shift): Range {
  // Convert a shift config to real start/end timestamps for that date.
  const base = toUtcDateTime(date).startOf("day");
  return {
    start: base.plus({ hours: shift.startHour }),
    end: base.plus({ hours: shift.endHour }),
  };
}

function dayStartUTC(dateTime: DateTime): DateTime {
  // Reset to 00:00 of same UTC day.
  return dateTime.startOf("day");
}

function shiftsForDay(shifts: Shift[], dayOfWeek: number): Shift[] {
  // Return day shifts sorted so we can scan in chronological order.
  return shifts
    .filter((s) => s.dayOfWeek === dayOfWeek)
    .sort((a, b) => a.startHour - b.startHour);
}

function findCurrentShiftWindow(dateTime: DateTime, shifts: Shift[]): Range | null {
  // Find shift that currently contains dateTime.
  // Example: 10:30 with shift 08:00-17:00 => returns that shift range.
  const dayShifts = shiftsForDay(shifts, toDocDayOfWeek(dateTime));

  for (const shift of dayShifts) {
    const window = shiftWindowForDate(dateTime.toJSDate(), shift);
    if (dateTime >= window.start && dateTime < window.end) {
      return window;
    }
  }

  return null;
}

function findNextShiftStart(dateTime: DateTime, shifts: Shift[]): DateTime {
  // Find next valid shift start in upcoming days.
  // Example: 19:00 Monday => 08:00 Tuesday.
  const baseDay = dayStartUTC(dateTime);

  for (let offsetDays = 0; offsetDays < 14; offsetDays += 1) {
    const day = baseDay.plus({ days: offsetDays });
    const dayShifts = shiftsForDay(shifts, toDocDayOfWeek(day));

    for (const shift of dayShifts) {
      const candidate = day.startOf("day").plus({ hours: shift.startHour });
      if (candidate >= dateTime) {
        return candidate;
      }
    }
  }

  throw new Error("No upcoming shift found in the next 14 days; shift config may be invalid.");
}

function normalizeWindows(windows: MaintenanceWindow[]): Range[] {
  // Parse, clean, and sort maintenance windows once for faster checks.
  return windows
    .map((w) => ({
      start: DateTime.fromISO(w.startDate, { zone: "utc" }),
      end: DateTime.fromISO(w.endDate, { zone: "utc" }),
    }))
    .filter((w) => w.start.isValid && w.end.isValid && w.end > w.start)
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());
}

function findMaintenanceCovering(dateTime: DateTime, windows: Range[]): Range | null {
  // Returns maintenance window if dateTime is inside one.
  for (const window of windows) {
    if (dateTime >= window.start && dateTime < window.end) {
      return window;
    }

    if (window.start > dateTime) {
      return null;
    }
  }

  return null;
}

function nextMaintenanceStartInRange(
  from: DateTime,
  to: DateTime,
  windows: Range[]
): DateTime | null {
  // Find next maintenance start between [from, to).
  for (const window of windows) {
    if (window.start >= to) {
      return null;
    }

    if (window.start > from && window.start < to) {
      return window.start;
    }
  }

  return null;
}

export function moveToNextWorkingInstant(
  date: Date,
  shifts: Shift[],
  maintenanceWindows: MaintenanceWindow[]
): Date {
  // Move cursor to first timestamp where work is allowed.
  // Rules: inside shift and outside maintenance.
  const windows = normalizeWindows(maintenanceWindows);
  let cursor = toUtcDateTime(date);

  for (let guard = 0; guard < 10000; guard += 1) {
    const currentShift = findCurrentShiftWindow(cursor, shifts);
    if (!currentShift) {
      cursor = findNextShiftStart(cursor, shifts);
      continue;
    }

    const coveringMaintenance = findMaintenanceCovering(cursor, windows);
    if (coveringMaintenance) {
      cursor = coveringMaintenance.end;
      continue;
    }

    return cursor.toJSDate();
  }

  throw new Error("Could not find next working instant; check shift or maintenance configuration.");
}

export function addWorkingMinutes(
  startDate: Date,
  durationMinutes: number,
  shifts: Shift[],
  maintenanceWindows: MaintenanceWindow[]
): Date {
  // Core helper:
  // consume only "working minutes", skipping shift gaps and maintenance windows.
  // Example: start 16:00, duration 120, shift ends 17:00 => resume next day 08:00 for remaining 60.
  if (durationMinutes < 0) {
    throw new Error("durationMinutes cannot be negative");
  }

  if (durationMinutes === 0) {
    return new Date(startDate);
  }

  const windows = normalizeWindows(maintenanceWindows);
  let cursor = toUtcDateTime(moveToNextWorkingInstant(startDate, shifts, maintenanceWindows));
  let remaining = durationMinutes;

  // Walk segment by segment until remaining working minutes become 0.
  for (let guard = 0; guard < 20000; guard += 1) {
    cursor = toUtcDateTime(moveToNextWorkingInstant(cursor.toJSDate(), shifts, maintenanceWindows));

    const currentShift = findCurrentShiftWindow(cursor, shifts);
    if (!currentShift) {
      cursor = findNextShiftStart(cursor, shifts);
      continue;
    }

    const nextMaintenanceStart = nextMaintenanceStartInRange(cursor, currentShift.end, windows);
    const segmentEnd = nextMaintenanceStart ?? currentShift.end;

    // Workable chunk = [cursor, segmentEnd)
    // segmentEnd can be shift end or maintenance start, whichever comes first.
    const workableMinutes = Math.max(0, Math.floor(segmentEnd.diff(cursor, "minutes").minutes));

    if (workableMinutes <= 0) {
      cursor = segmentEnd.plus({ minutes: 1 });
      continue;
    }

    if (remaining <= workableMinutes) {
      return cursor.plus({ minutes: remaining }).toJSDate();
    }

    remaining -= workableMinutes;
    cursor = segmentEnd;
  }

  throw new Error("Exceeded working-time calculation guard; schedule may be impossible.");
}
