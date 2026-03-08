import { describe, expect, it } from "vitest";
import { ReflowService } from "../src/reflow/reflow.service";
import { ReflowInput, WorkCenter, WorkOrder } from "../src/reflow/types";

function buildLine1(): WorkCenter {
  return {
    docId: "LINE-1",
    docType: "workCenter",
    data: {
      name: "Extrusion Line 1",
      shifts: [
        { dayOfWeek: 1, startHour: 8, endHour: 17 },
        { dayOfWeek: 2, startHour: 8, endHour: 17 },
        { dayOfWeek: 3, startHour: 8, endHour: 17 },
        { dayOfWeek: 4, startHour: 8, endHour: 17 },
        { dayOfWeek: 5, startHour: 8, endHour: 17 }
      ],
      maintenanceWindows: [
        {
          startDate: "2026-03-09T13:00:00Z",
          endDate: "2026-03-09T14:00:00Z",
          reason: "Planned maintenance"
        }
      ]
    }
  };
}

function wo(params: {
  id: string;
  start: string;
  end: string;
  durationMinutes: number;
  dependsOn?: string[];
  workCenterId?: string;
  isMaintenance?: boolean;
}): WorkOrder {
  return {
    docId: params.id,
    docType: "workOrder",
    data: {
      workOrderNumber: params.id,
      manufacturingOrderId: "MO-EDGE",
      workCenterId: params.workCenterId ?? "LINE-1",
      startDate: params.start,
      endDate: params.end,
      durationMinutes: params.durationMinutes,
      isMaintenance: params.isMaintenance ?? false,
      dependsOnWorkOrderIds: params.dependsOn ?? []
    }
  };
}

describe("ReflowService edge cases", () => {
  const reflowService = new ReflowService();

  it("throws when a dependency id does not exist", () => {
    const input: ReflowInput = {
      workCenters: [buildLine1()],
      workOrders: [
        wo({
          id: "A",
          start: "2026-03-09T08:00:00Z",
          end: "2026-03-09T10:00:00Z",
          durationMinutes: 120,
          dependsOn: ["MISSING"]
        })
      ]
    };

    expect(() => reflowService.reflow(input)).toThrow("depends on unknown work order MISSING");
  });

  it("throws when a work order references unknown work center", () => {
    const input: ReflowInput = {
      workCenters: [buildLine1()],
      workOrders: [
        wo({
          id: "A",
          start: "2026-03-09T08:00:00Z",
          end: "2026-03-09T10:00:00Z",
          durationMinutes: 120,
          workCenterId: "LINE-UNKNOWN"
        })
      ]
    };

    expect(() => reflowService.reflow(input)).toThrow(
      "references unknown work center LINE-UNKNOWN"
    );
  });

  it("throws when durationMinutes is negative", () => {
    const input: ReflowInput = {
      workCenters: [buildLine1()],
      workOrders: [
        wo({
          id: "A",
          start: "2026-03-09T08:00:00Z",
          end: "2026-03-09T10:00:00Z",
          durationMinutes: -10
        })
      ]
    };

    expect(() => reflowService.reflow(input)).toThrow("has negative durationMinutes");
  });

  it("throws when fixed maintenance order violates dependency timing", () => {
    const input: ReflowInput = {
      workCenters: [buildLine1()],
      workOrders: [
        wo({
          id: "PARENT",
          start: "2026-03-09T08:00:00Z",
          end: "2026-03-09T11:00:00Z",
          durationMinutes: 180
        }),
        wo({
          id: "MAINT",
          start: "2026-03-09T10:00:00Z",
          end: "2026-03-09T10:30:00Z",
          durationMinutes: 30,
          isMaintenance: true,
          dependsOn: ["PARENT"]
        })
      ]
    };

    expect(() => reflowService.reflow(input)).toThrow(
      "Maintenance work order MAINT is fixed but violates dependency timing"
    );
  });

  it("throws for circular dependencies in a larger cycle", () => {
    const input: ReflowInput = {
      workCenters: [buildLine1()],
      workOrders: [
        wo({
          id: "A",
          start: "2026-03-09T08:00:00Z",
          end: "2026-03-09T09:00:00Z",
          durationMinutes: 60,
          dependsOn: ["C"]
        }),
        wo({
          id: "B",
          start: "2026-03-09T09:00:00Z",
          end: "2026-03-09T10:00:00Z",
          durationMinutes: 60,
          dependsOn: ["A"]
        }),
        wo({
          id: "C",
          start: "2026-03-09T10:00:00Z",
          end: "2026-03-09T11:00:00Z",
          durationMinutes: 60,
          dependsOn: ["B"]
        })
      ]
    };

    expect(() => reflowService.reflow(input)).toThrow("Circular dependency detected in work orders");
  });
});
