import { WorkOrder } from "./types";
import { parseIso } from "../utils/date-utils";

export interface ConstraintViolation {
  workOrderId: string;
  message: string;
}

export function validateNoOverlaps(workOrders: WorkOrder[]): ConstraintViolation[] {
  const byCenter = new Map<string, WorkOrder[]>();
  for (const wo of workOrders) {
    const list = byCenter.get(wo.data.workCenterId) ?? [];
    list.push(wo);
    byCenter.set(wo.data.workCenterId, list);
  }

  const violations: ConstraintViolation[] = [];
  for (const orders of byCenter.values()) {
    const sorted = [...orders].sort(
      (a, b) => parseIso(a.data.startDate).getTime() - parseIso(b.data.startDate).getTime()
    );

    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const prevEnd = parseIso(prev.data.endDate);
      const currStart = parseIso(curr.data.startDate);
      if (currStart < prevEnd) {
        violations.push({
          workOrderId: curr.docId,
          message: `Overlaps with ${prev.docId} on work center ${curr.data.workCenterId}`,
        });
      }
    }
  }

  return violations;
}

export function validateDependencies(workOrders: WorkOrder[]): ConstraintViolation[] {
  const byId = new Map(workOrders.map((wo) => [wo.docId, wo]));
  const violations: ConstraintViolation[] = [];

  for (const wo of workOrders) {
    const start = parseIso(wo.data.startDate);
    for (const parentId of wo.data.dependsOnWorkOrderIds) {
      const parent = byId.get(parentId);
      if (!parent) {
        violations.push({ workOrderId: wo.docId, message: `Missing dependency ${parentId}` });
        continue;
      }
      const parentEnd = parseIso(parent.data.endDate);
      if (start < parentEnd) {
        violations.push({
          workOrderId: wo.docId,
          message: `Starts before parent ${parentId} completes`,
        });
      }
    }
  }

  return violations;
}

export function validateTemporalIntegrity(workOrders: WorkOrder[]): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];

  for (const wo of workOrders) {
    const start = parseIso(wo.data.startDate);
    const end = parseIso(wo.data.endDate);
    if (end <= start) {
      violations.push({ workOrderId: wo.docId, message: "End must be after start" });
    }
  }

  return violations;
}
