import {
  ReflowChange,
  ReflowInput,
  ReflowResult,
  ScheduledInterval,
  WorkCenter,
  WorkOrder,
} from "./types";
import {
  addWorkingMinutes,
  formatIso,
  maxDate,
  minutesBetween,
  moveToNextWorkingInstant,
  parseIso,
} from "../utils/date-utils";

export class ReflowService {
  reflow(input: ReflowInput): ReflowResult {
    // Quick lookup maps so we do not scan full arrays again and again.
    const workCenterById = new Map<string, WorkCenter>(input.workCenters.map((wc) => [wc.docId, wc]));
    const workOrderById = new Map<string, WorkOrder>(input.workOrders.map((wo) => [wo.docId, wo]));

    // Validate references first so scheduling does not fail halfway.
    this.validateReferences(workOrderById, workCenterById);

    // Dependency-safe order.
    // Example: if B depends on A, A appears before B in this order.
    const orderedWorkOrderIds = this.topologicalSort(input.workOrders);

    // Keeps machine reservations in time order per work center.
    const reservationsByCenterId = new Map<string, ScheduledInterval[]>();

    // Final calculated schedule for each work order.
    const scheduledByWorkOrderId = new Map<string, { start: Date; end: Date }>();

    // Human-readable reasons for changes per work order.
    const reasonsByWorkOrderId = new Map<string, string[]>();

    // Main scheduling loop: schedule one work order at a time.
    for (const workOrderId of orderedWorkOrderIds) {
      const workOrder = workOrderById.get(workOrderId)!;
      const workCenter = workCenterById.get(workOrder.data.workCenterId)!;
      const reservations = this.ensureReservationBucket(reservationsByCenterId, workCenter.docId);

      // Maintenance work orders are fixed and cannot move.
      // We only validate and reserve them as-is.
      if (workOrder.data.isMaintenance) {
        const fixedStart = parseIso(workOrder.data.startDate);
        const fixedEnd = parseIso(workOrder.data.endDate);

        if (fixedEnd <= fixedStart) {
          throw new Error(`Maintenance work order ${workOrder.docId} has invalid start/end`);
        }

        const latestParentEnd = this.getLatestParentEnd(workOrder, scheduledByWorkOrderId);
        if (latestParentEnd && latestParentEnd > fixedStart) {
          throw new Error(
            `Maintenance work order ${workOrder.docId} is fixed but violates dependency timing`
          );
        }

        this.ensureNoOverlap(workOrder.docId, fixedStart, fixedEnd, reservations);
        this.reserve(workOrder.docId, fixedStart, fixedEnd, reservations);
        scheduledByWorkOrderId.set(workOrder.docId, { start: fixedStart, end: fixedEnd });
        reasonsByWorkOrderId.set(workOrder.docId, ["Fixed maintenance order (not rescheduled)"]);
        continue;
      }

      let candidateStart = parseIso(workOrder.data.startDate);
      const reasons: string[] = [];

      // Rule: child must wait for all parents.
      // Example: if parents end at 10:00 and 11:30, child can start at 11:30.
      const latestParentEnd = this.getLatestParentEnd(workOrder, scheduledByWorkOrderId);
      if (latestParentEnd && latestParentEnd > candidateStart) {
        candidateStart = latestParentEnd;
        const blockingParents = this.getBlockingParentIds(
          workOrder,
          latestParentEnd,
          scheduledByWorkOrderId
        );
        reasons.push(
          `Waited for dependency completion (${blockingParents.join(", ")}) until ${formatIso(latestParentEnd)}`
        );
      }

      let scheduledEnd = new Date(candidateStart);
      // Keep trying until this order gets a conflict-free [start, end] range.
      for (let guard = 0; guard < 10000; guard += 1) {
        // Push start to next machine-available and shift-valid instant.
        candidateStart = this.findEarliestCenterWorkingStart(
          workOrder,
          workCenter,
          reservations,
          candidateStart,
          reasons
        );

        scheduledEnd = addWorkingMinutes(
          candidateStart,
          workOrder.data.durationMinutes,
          workCenter.data.shifts,
          workCenter.data.maintenanceWindows
        );

        // If full interval overlaps, push start after overlap and retry.
        const overlap = this.findFirstOverlap(candidateStart, scheduledEnd, reservations);
        if (!overlap) {
          break;
        }

        reasons.push(`Machine busy with ${overlap.workOrderId}; moved start after it finished`);
        candidateStart = moveToNextWorkingInstant(
          overlap.end,
          workCenter.data.shifts,
          workCenter.data.maintenanceWindows
        );
      }

      const wallClockMinutes = minutesBetween(candidateStart, scheduledEnd);
      // If wall time is larger than working duration, we paused due to shift/maintenance.
      // Example: duration=120 but start->end spans 180 mins => 60 mins were paused.
      if (wallClockMinutes > workOrder.data.durationMinutes) {
        if (this.intersectsMaintenanceWindow(candidateStart, scheduledEnd, workCenter)) {
          reasons.push("Paused during maintenance window on the work center");
        }
        if (!this.isWithinSingleShiftWindow(candidateStart, scheduledEnd, workCenter)) {
          reasons.push("Paused at shift boundary and resumed in next active shift");
        }
      }

      this.ensureNoOverlap(workOrder.docId, candidateStart, scheduledEnd, reservations);
      this.reserve(workOrder.docId, candidateStart, scheduledEnd, reservations);
      scheduledByWorkOrderId.set(workOrder.docId, { start: candidateStart, end: scheduledEnd });
      reasonsByWorkOrderId.set(workOrder.docId, Array.from(new Set(reasons)));
    }

    // Build output with updated start/end dates.
    const updatedWorkOrders = input.workOrders.map((workOrder) => {
      const scheduled = scheduledByWorkOrderId.get(workOrder.docId);
      if (!scheduled) {
        throw new Error(`Missing scheduled result for work order ${workOrder.docId}`);
      }

      return {
        ...workOrder,
        data: {
          ...workOrder.data,
          startDate: formatIso(scheduled.start),
          endDate: formatIso(scheduled.end),
        },
      };
    });

    const changes = this.buildChanges(input.workOrders, updatedWorkOrders, reasonsByWorkOrderId);
    const explanation = this.buildExplanation(changes, input.workOrders.length);

    // Final output expected by caller (demo/tests/API usage).
    return {
      updatedWorkOrders,
      changes,
      explanation,
    };
  }

  private validateReferences(
    workOrderById: Map<string, WorkOrder>,
    workCenterById: Map<string, WorkCenter>
  ): void {
    // Defensive checks for common bad-input issues.
    for (const workOrder of workOrderById.values()) {
      if (!workCenterById.has(workOrder.data.workCenterId)) {
        throw new Error(
          `Work order ${workOrder.docId} references unknown work center ${workOrder.data.workCenterId}`
        );
      }

      if (workOrder.data.durationMinutes < 0) {
        throw new Error(`Work order ${workOrder.docId} has negative durationMinutes`);
      }

      for (const dependencyId of workOrder.data.dependsOnWorkOrderIds) {
        if (!workOrderById.has(dependencyId)) {
          throw new Error(`Work order ${workOrder.docId} depends on unknown work order ${dependencyId}`);
        }
      }
    }
  }

  private topologicalSort(workOrders: WorkOrder[]): string[] {
    // Kahn's algorithm for dependency ordering + cycle detection.
    const childrenByParent = new Map<string, string[]>();
    const indegreeById = new Map<string, number>();

    for (const workOrder of workOrders) {
      indegreeById.set(workOrder.docId, 0);
      childrenByParent.set(workOrder.docId, []);
    }

    for (const workOrder of workOrders) {
      for (const parentId of workOrder.data.dependsOnWorkOrderIds) {
        indegreeById.set(workOrder.docId, (indegreeById.get(workOrder.docId) ?? 0) + 1);
        childrenByParent.get(parentId)?.push(workOrder.docId);
      }
    }

    const queue: string[] = [];
    for (const [workOrderId, indegree] of indegreeById.entries()) {
      if (indegree === 0) {
        queue.push(workOrderId);
      }
    }

    const ordered: string[] = [];

    // Pull ready nodes (indegree 0), then reduce indegrees of their children.
    while (queue.length > 0) {
      const current = queue.shift()!;
      ordered.push(current);

      for (const childId of childrenByParent.get(current) ?? []) {
        const next = (indegreeById.get(childId) ?? 0) - 1;
        indegreeById.set(childId, next);
        if (next === 0) {
          queue.push(childId);
        }
      }
    }

    if (ordered.length !== workOrders.length) {
      throw new Error("Circular dependency detected in work orders");
    }

    return ordered;
  }

  private getLatestParentEnd(
    workOrder: WorkOrder,
    scheduledByWorkOrderId: Map<string, { start: Date; end: Date }>
  ): Date | null {
    // Find the latest parent completion.
    let latest: Date | null = null;

    for (const dependencyId of workOrder.data.dependsOnWorkOrderIds) {
      const parent = scheduledByWorkOrderId.get(dependencyId);
      if (!parent) {
        throw new Error(`Parent work order ${dependencyId} was not scheduled before ${workOrder.docId}`);
      }

      latest = latest ? maxDate(latest, parent.end) : parent.end;
    }

    return latest;
  }

  private getBlockingParentIds(
    workOrder: WorkOrder,
    latestParentEnd: Date,
    scheduledByWorkOrderId: Map<string, { start: Date; end: Date }>
  ): string[] {
    // Return the parent ids that are actually blocking this order start.
    const blocking: string[] = [];
    for (const dependencyId of workOrder.data.dependsOnWorkOrderIds) {
      const parent = scheduledByWorkOrderId.get(dependencyId);
      if (parent && parent.end.getTime() === latestParentEnd.getTime()) {
        blocking.push(dependencyId);
      }
    }
    return blocking.length > 0 ? blocking : workOrder.data.dependsOnWorkOrderIds;
  }

  private ensureReservationBucket(
    reservationsByCenterId: Map<string, ScheduledInterval[]>,
    workCenterId: string
  ): ScheduledInterval[] {
    // Create reservation list lazily per work center.
    const existing = reservationsByCenterId.get(workCenterId);
    if (existing) {
      return existing;
    }

    const created: ScheduledInterval[] = [];
    reservationsByCenterId.set(workCenterId, created);
    return created;
  }

  private findEarliestCenterWorkingStart(
    workOrder: WorkOrder,
    workCenter: WorkCenter,
    reservations: ScheduledInterval[],
    initialCandidate: Date,
    reasons: string[]
  ): Date {
    // Keep adjusting start until it is both:
    // 1) not inside another reservation, and 2) in a valid working instant.
    let candidate = new Date(initialCandidate);

    for (let guard = 0; guard < 10000; guard += 1) {
      const previous = candidate;

      // Example: if candidate=09:30 and another order runs 09:00-10:00,
      // move candidate to 10:00.
      const availableStart = this.nextNonOverlappingStart(candidate, reservations);
      if (availableStart.getTime() !== candidate.getTime()) {
        candidate = availableStart;
        reasons.push("Work center conflict (machine already occupied)");
      }

      // Example: if candidate lands at 19:00 and shift is 08:00-17:00,
      // move to next shift start.
      const shifted = moveToNextWorkingInstant(
        candidate,
        workCenter.data.shifts,
        workCenter.data.maintenanceWindows
      );
      if (shifted.getTime() !== candidate.getTime()) {
        if (this.isInMaintenanceWindow(candidate, workCenter)) {
          reasons.push("Start moved to avoid maintenance window");
        } else {
          reasons.push("Start moved to next active shift");
        }
        candidate = shifted;
      }

      if (candidate.getTime() === previous.getTime()) {
        return candidate;
      }
    }

    throw new Error(`Could not find earliest valid start for work order ${workOrder.docId}`);
  }

  private nextNonOverlappingStart(candidate: Date, reservations: ScheduledInterval[]): Date {
    // If candidate is inside an interval, move to that interval's end.
    if (reservations.length === 0) {
      return candidate;
    }

    for (const interval of reservations) {
      if (candidate >= interval.end) {
        continue;
      }

      if (candidate < interval.start) {
        return candidate;
      }

      return new Date(interval.end);
    }

    return candidate;
  }

  private ensureNoOverlap(
    workOrderId: string,
    start: Date,
    end: Date,
    reservations: ScheduledInterval[]
  ): void {
    // Final overlap guard before we reserve the interval.
    for (const interval of reservations) {
      if (interval.workOrderId === workOrderId) {
        continue;
      }

      if (start < interval.end && end > interval.start) {
        throw new Error(
          `Work order ${workOrderId} overlaps with ${interval.workOrderId} on same work center`
        );
      }
    }
  }

  private findFirstOverlap(
    start: Date,
    end: Date,
    reservations: ScheduledInterval[]
  ): ScheduledInterval | null {
    // Returns first interval that intersects [start, end], if any.
    for (const interval of reservations) {
      if (start < interval.end && end > interval.start) {
        return interval;
      }
    }
    return null;
  }

  private reserve(
    workOrderId: string,
    start: Date,
    end: Date,
    reservations: ScheduledInterval[]
  ): void {
    // Save reservation and keep them sorted by start time.
    reservations.push({ workOrderId, start, end });
    reservations.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  private buildChanges(
    original: WorkOrder[],
    updated: WorkOrder[],
    reasonsByWorkOrderId: Map<string, string[]>
  ): ReflowChange[] {
    // Compare old vs new schedule and keep only changed orders.
    const updatedById = new Map<string, WorkOrder>(updated.map((w) => [w.docId, w]));

    const changes: ReflowChange[] = [];

    for (const originalOrder of original) {
      const updatedOrder = updatedById.get(originalOrder.docId);
      if (!updatedOrder) {
        continue;
      }

      const oldStart = parseIso(originalOrder.data.startDate);
      const newStart = parseIso(updatedOrder.data.startDate);
      const oldEnd = parseIso(originalOrder.data.endDate);
      const newEnd = parseIso(updatedOrder.data.endDate);

      if (oldStart.getTime() === newStart.getTime() && oldEnd.getTime() === newEnd.getTime()) {
        continue;
      }

      const reasons = [...(reasonsByWorkOrderId.get(originalOrder.docId) ?? [])];
      if (reasons.length === 0) {
        reasons.push("Schedule recalculated to satisfy constraints");
      }

      changes.push({
        workOrderId: originalOrder.docId,
        oldStartDate: originalOrder.data.startDate,
        newStartDate: updatedOrder.data.startDate,
        oldEndDate: originalOrder.data.endDate,
        newEndDate: updatedOrder.data.endDate,
        shiftMinutes: minutesBetween(oldStart, newStart),
        reasons,
      });
    }

    return changes;
  }

  private buildExplanation(changes: ReflowChange[], totalOrders: number): string[] {
    // Small summary line per changed work order for demo/readme output.
    if (changes.length === 0) {
      return ["No schedule changes were needed. Existing schedule already satisfied all constraints."];
    }

    const lines = [`Reflow updated ${changes.length} of ${totalOrders} work orders.`];

    for (const change of changes) {
      const startDelayMinutes = minutesBetween(parseIso(change.oldStartDate), parseIso(change.newStartDate));
      const endDelayMinutes = minutesBetween(parseIso(change.oldEndDate), parseIso(change.newEndDate));
      lines.push(
        `- ${change.workOrderId}: start delay ${startDelayMinutes} min, end delay ${endDelayMinutes} min. Why: ${change.reasons.join(" | ")}`
      );
    }

    return lines;
  }

  private isInMaintenanceWindow(date: Date, workCenter: WorkCenter): boolean {
    // True when `date` lands inside any blocked maintenance window.
    for (const window of workCenter.data.maintenanceWindows) {
      const start = parseIso(window.startDate);
      const end = parseIso(window.endDate);
      if (date >= start && date < end) {
        return true;
      }
    }
    return false;
  }

  private intersectsMaintenanceWindow(start: Date, end: Date, workCenter: WorkCenter): boolean {
    // True when [start, end] intersects any maintenance window.
    // Example: job 12:30-15:30 intersects maintenance 13:00-14:00.
    for (const window of workCenter.data.maintenanceWindows) {
      const windowStart = parseIso(window.startDate);
      const windowEnd = parseIso(window.endDate);
      if (start < windowEnd && end > windowStart) {
        return true;
      }
    }
    return false;
  }

  private isWithinSingleShiftWindow(start: Date, end: Date, workCenter: WorkCenter): boolean {
    // Helper for reason text: tells if interval stayed in a single shift block.
    // If not, we know job had to pause at least once.
    if (start.getUTCFullYear() !== end.getUTCFullYear()) {
      return false;
    }
    if (start.getUTCMonth() !== end.getUTCMonth()) {
      return false;
    }
    if (start.getUTCDate() !== end.getUTCDate()) {
      return false;
    }

    const dayOfWeek = start.getUTCDay();
    for (const shift of workCenter.data.shifts) {
      if (shift.dayOfWeek !== dayOfWeek) {
        continue;
      }

      const shiftStart = new Date(start);
      shiftStart.setUTCHours(shift.startHour, 0, 0, 0);
      const shiftEnd = new Date(start);
      shiftEnd.setUTCHours(shift.endHour, 0, 0, 0);
      if (start >= shiftStart && end <= shiftEnd) {
        return true;
      }
    }

    return false;
  }
}
