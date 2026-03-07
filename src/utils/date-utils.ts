import { MaintenanceWindow, Shift } from "../reflow/types";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

interface Range {
  start: Date;
  end: Date;
}

export function parseIso(input: string): Date {
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO date: ${input}`);
  }
  return parsed;
}

export function formatIso(date: Date): string {
  return date.toISOString();
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

export function minutesBetween(start: Date, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / MINUTE_MS));
}

export function clampToHourUTC(date: Date, hour: number): Date {
  const d = new Date(date);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

export function shiftWindowForDate(date: Date, shift: Shift): Range {
  const start = clampToHourUTC(date, shift.startHour);
  const end = clampToHourUTC(date, shift.endHour);
  return { start, end };
}

function dayStartUTC(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function shiftsForDay(shifts: Shift[], dayOfWeek: number): Shift[] {
  return shifts
    .filter((s) => s.dayOfWeek === dayOfWeek)
    .sort((a, b) => a.startHour - b.startHour);
}

function findCurrentShiftWindow(date: Date, shifts: Shift[]): Range | null {
  const dayShifts = shiftsForDay(shifts, date.getUTCDay());
  for (const shift of dayShifts) {
    const window = shiftWindowForDate(date, shift);
    if (date >= window.start && date < window.end) {
      return window;
    }
  }
  return null;
}

function findNextShiftStart(date: Date, shifts: Shift[]): Date {
  const baseDay = dayStartUTC(date);
  for (let offsetDays = 0; offsetDays < 14; offsetDays += 1) {
    const day = new Date(baseDay.getTime() + offsetDays * DAY_MS);
    const dayShifts = shiftsForDay(shifts, day.getUTCDay());
    for (const shift of dayShifts) {
      const candidate = clampToHourUTC(day, shift.startHour);
      if (candidate >= date) {
        return candidate;
      }
    }
  }

  throw new Error("No upcoming shift found in the next 14 days; shift config may be invalid.");
}

function normalizeWindows(windows: MaintenanceWindow[]): Range[] {
  return windows
    .map((w) => ({ start: parseIso(w.startDate), end: parseIso(w.endDate) }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

function findMaintenanceCovering(date: Date, windows: Range[]): Range | null {
  for (const window of windows) {
    if (date >= window.start && date < window.end) {
      return window;
    }
    if (window.start > date) {
      return null;
    }
  }
  return null;
}

function nextMaintenanceStartInRange(from: Date, to: Date, windows: Range[]): Date | null {
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
  let cursor = new Date(date);

  for (let guard = 0; guard < 10000; guard += 1) {
    const currentShift = findCurrentShiftWindow(cursor, shifts);
    if (!currentShift) {
      cursor = findNextShiftStart(cursor, shifts);
      continue;
    }

    const coveringMaintenance = findMaintenanceCovering(cursor, windows);
    if (coveringMaintenance) {
      cursor = new Date(coveringMaintenance.end);
      continue;
    }

    return cursor;
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
  let cursor = moveToNextWorkingInstant(startDate, shifts, maintenanceWindows);
  let remaining = durationMinutes;

  for (let guard = 0; guard < 20000; guard += 1) {
    cursor = moveToNextWorkingInstant(cursor, shifts, maintenanceWindows);

    const currentShift = findCurrentShiftWindow(cursor, shifts);
    if (!currentShift) {
      cursor = findNextShiftStart(cursor, shifts);
      continue;
    }

    const nextMaintenanceStart = nextMaintenanceStartInRange(cursor, currentShift.end, windows);
    const segmentEnd = nextMaintenanceStart ?? currentShift.end;
    const workableMinutes = minutesBetween(cursor, segmentEnd);

    if (workableMinutes <= 0) {
      cursor = new Date(segmentEnd.getTime() + MINUTE_MS);
      continue;
    }

    if (remaining <= workableMinutes) {
      return addMinutes(cursor, remaining);
    }

    remaining -= workableMinutes;
    cursor = new Date(segmentEnd);
  }

  throw new Error("Exceeded working-time calculation guard; schedule may be impossible.");
}
