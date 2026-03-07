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
    const workCenterById = new Map<string, WorkCenter>(input.workCenters.map((wc) => [wc.docId, wc]));
    const workOrderById = new Map<string, WorkOrder>(input.workOrders.map((wo) => [wo.docId, wo]));

    this.validateReferences(workOrderById, workCenterById);

    const orderedWorkOrderIds = this.topologicalSort(input.workOrders);
    const reservationsByCenterId = new Map<string, ScheduledInterval[]>();
    const scheduledByWorkOrderId = new Map<string, { start: Date; end: Date }>();
    const reasonsByWorkOrderId = new Map<string, string[]>();

    for (const workOrderId of orderedWorkOrderIds) {
      const workOrder = workOrderById.get(workOrderId)!;
      const workCenter = workCenterById.get(workOrder.data.workCenterId)!;
      const reservations = this.ensureReservationBucket(reservationsByCenterId, workCenter.docId);

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

      const latestParentEnd = this.getLatestParentEnd(workOrder, scheduledByWorkOrderId);
      if (latestParentEnd && latestParentEnd > candidateStart) {
        candidateStart = latestParentEnd;
        reasons.push("Dependency delay (waiting for parent completion)");
      }

      let scheduledEnd = new Date(candidateStart);
      for (let guard = 0; guard < 10000; guard += 1) {
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

        const overlap = this.findFirstOverlap(candidateStart, scheduledEnd, reservations);
        if (!overlap) {
          break;
        }

        reasons.push(`Work center conflict with ${overlap.workOrderId}, pushed after overlap`);
        candidateStart = moveToNextWorkingInstant(
          overlap.end,
          workCenter.data.shifts,
          workCenter.data.maintenanceWindows
        );
      }

      this.ensureNoOverlap(workOrder.docId, candidateStart, scheduledEnd, reservations);
      this.reserve(workOrder.docId, candidateStart, scheduledEnd, reservations);
      scheduledByWorkOrderId.set(workOrder.docId, { start: candidateStart, end: scheduledEnd });
      reasonsByWorkOrderId.set(workOrder.docId, Array.from(new Set(reasons)));
    }

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

  private ensureReservationBucket(
    reservationsByCenterId: Map<string, ScheduledInterval[]>,
    workCenterId: string
  ): ScheduledInterval[] {
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
    let candidate = new Date(initialCandidate);

    for (let guard = 0; guard < 10000; guard += 1) {
      const previous = candidate;

      const availableStart = this.nextNonOverlappingStart(candidate, reservations);
      if (availableStart.getTime() !== candidate.getTime()) {
        candidate = availableStart;
        reasons.push("Work center conflict (machine already occupied)");
      }

      const shifted = moveToNextWorkingInstant(
        candidate,
        workCenter.data.shifts,
        workCenter.data.maintenanceWindows
      );
      if (shifted.getTime() !== candidate.getTime()) {
        candidate = shifted;
        reasons.push("Shift or maintenance adjustment");
      }

      if (candidate.getTime() === previous.getTime()) {
        return candidate;
      }
    }

    throw new Error(`Could not find earliest valid start for work order ${workOrder.docId}`);
  }

  private nextNonOverlappingStart(candidate: Date, reservations: ScheduledInterval[]): Date {
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
    reservations.push({ workOrderId, start, end });
    reservations.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  private buildChanges(
    original: WorkOrder[],
    updated: WorkOrder[],
    reasonsByWorkOrderId: Map<string, string[]>
  ): ReflowChange[] {
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
      if (newStart > oldStart) {
        reasons.push("Start moved later to satisfy constraints");
      }
      if (newEnd > oldEnd) {
        reasons.push("End moved later after working-time recalculation");
      }
      if (reasons.length === 0) {
        reasons.push("Schedule normalized");
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
    if (changes.length === 0) {
      return ["No schedule changes were needed. Existing schedule already satisfied all constraints."];
    }

    const lines = [`Reflow updated ${changes.length} of ${totalOrders} work orders.`];

    for (const change of changes) {
      lines.push(
        `- ${change.workOrderId}: start ${change.oldStartDate} -> ${change.newStartDate}, end ${change.oldEndDate} -> ${change.newEndDate}`
      );
    }

    return lines;
  }
}
