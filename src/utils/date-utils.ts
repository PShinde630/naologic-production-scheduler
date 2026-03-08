import { DateTime } from "luxon";
import { MaintenanceWindow, Shift } from "../reflow/types";

interface Range {
  start: DateTime;
  end: DateTime;
}

function toUtcDateTime(date: Date): DateTime {
  return DateTime.fromJSDate(date, { zone: "utc" });
}

function toDocDayOfWeek(dateTime: DateTime): number {
  // Luxon weekday: Monday=1 ... Sunday=7, doc format: Sunday=0 ... Saturday=6
  return dateTime.weekday % 7;
}

export function parseIso(input: string): Date {
  const parsed = DateTime.fromISO(input, { zone: "utc" });
  if (!parsed.isValid) {
    throw new Error(`Invalid ISO date: ${input}`);
  }
  return parsed.toJSDate();
}

export function formatIso(date: Date): string {
  return toUtcDateTime(date).toISO({ suppressMilliseconds: false }) ?? date.toISOString();
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

export function addMinutes(date: Date, minutes: number): Date {
  return toUtcDateTime(date).plus({ minutes }).toJSDate();
}

export function minutesBetween(start: Date, end: Date): number {
  const diff = toUtcDateTime(end).diff(toUtcDateTime(start), "minutes").minutes;
  return Math.max(0, Math.floor(diff));
}

export function clampToHourUTC(date: Date, hour: number): Date {
  return toUtcDateTime(date).startOf("day").plus({ hours: hour }).toJSDate();
}

export function shiftWindowForDate(date: Date, shift: Shift): Range {
  const base = toUtcDateTime(date).startOf("day");
  return {
    start: base.plus({ hours: shift.startHour }),
    end: base.plus({ hours: shift.endHour }),
  };
}

function dayStartUTC(dateTime: DateTime): DateTime {
  return dateTime.startOf("day");
}

function shiftsForDay(shifts: Shift[], dayOfWeek: number): Shift[] {
  return shifts
    .filter((s) => s.dayOfWeek === dayOfWeek)
    .sort((a, b) => a.startHour - b.startHour);
}

function findCurrentShiftWindow(dateTime: DateTime, shifts: Shift[]): Range | null {
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
  return windows
    .map((w) => ({
      start: DateTime.fromISO(w.startDate, { zone: "utc" }),
      end: DateTime.fromISO(w.endDate, { zone: "utc" }),
    }))
    .filter((w) => w.start.isValid && w.end.isValid && w.end > w.start)
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());
}

function findMaintenanceCovering(dateTime: DateTime, windows: Range[]): Range | null {
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
  if (durationMinutes < 0) {
    throw new Error("durationMinutes cannot be negative");
  }

  if (durationMinutes === 0) {
    return new Date(startDate);
  }

  const windows = normalizeWindows(maintenanceWindows);
  let cursor = toUtcDateTime(moveToNextWorkingInstant(startDate, shifts, maintenanceWindows));
  let remaining = durationMinutes;

  for (let guard = 0; guard < 20000; guard += 1) {
    cursor = toUtcDateTime(moveToNextWorkingInstant(cursor.toJSDate(), shifts, maintenanceWindows));

    const currentShift = findCurrentShiftWindow(cursor, shifts);
    if (!currentShift) {
      cursor = findNextShiftStart(cursor, shifts);
      continue;
    }

    const nextMaintenanceStart = nextMaintenanceStartInRange(cursor, currentShift.end, windows);
    const segmentEnd = nextMaintenanceStart ?? currentShift.end;
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
