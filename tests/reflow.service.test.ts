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
}): WorkOrder {
  return {
    docId: params.id,
    docType: "workOrder",
    data: {
      workOrderNumber: params.id,
      manufacturingOrderId: "MO-TEST",
      workCenterId: "LINE-1",
      startDate: params.start,
      endDate: params.end,
      durationMinutes: params.durationMinutes,
      isMaintenance: false,
      dependsOnWorkOrderIds: params.dependsOn ?? []
    }
  };
}

function byId(input: ReflowInput, id: string): WorkOrder {
  const found = input.workOrders.find((w) => w.docId === id);
  if (!found) {
    throw new Error(`Missing work order ${id}`);
  }
  return found;
}

describe("ReflowService", () => {
  const reflowService = new ReflowService();

  it("applies dependency and maintenance delay cascade", () => {
    const input: ReflowInput = {
      workCenters: [buildLine1()],
      workOrders: [
        wo({ id: "A", start: "2026-03-09T08:00:00Z", end: "2026-03-09T12:00:00Z", durationMinutes: 240 }),
        wo({ id: "B", start: "2026-03-09T09:00:00Z", end: "2026-03-09T11:00:00Z", durationMinutes: 120, dependsOn: ["A"] }),
        wo({ id: "C", start: "2026-03-09T10:00:00Z", end: "2026-03-09T11:00:00Z", durationMinutes: 60, dependsOn: ["B"] })
      ]
    };

    const result = reflowService.reflow(input);

    expect(byId({ ...input, workOrders: result.updatedWorkOrders }, "B").data.startDate).toBe("2026-03-09T12:00:00.000Z");
    expect(byId({ ...input, workOrders: result.updatedWorkOrders }, "B").data.endDate).toBe("2026-03-09T15:00:00.000Z");
    expect(byId({ ...input, workOrders: result.updatedWorkOrders }, "C").data.startDate).toBe("2026-03-09T15:00:00.000Z");
    expect(result.changes.length).toBe(2);
  });

  it("splits work across shift boundary", () => {
    const input: ReflowInput = {
      workCenters: [buildLine1()],
      workOrders: [
        wo({ id: "S1", start: "2026-03-10T16:00:00Z", end: "2026-03-10T18:00:00Z", durationMinutes: 120 })
      ]
    };

    const result = reflowService.reflow(input);
    const updated = byId({ ...input, workOrders: result.updatedWorkOrders }, "S1");

    expect(updated.data.startDate).toBe("2026-03-10T16:00:00.000Z");
    expect(updated.data.endDate).toBe("2026-03-11T09:00:00.000Z");
    expect(result.changes[0].reasons.join(" ")).toContain("shift boundary");
  });

  it("pauses work for maintenance window", () => {
    const input: ReflowInput = {
      workCenters: [buildLine1()],
      workOrders: [
        wo({ id: "M1", start: "2026-03-09T12:30:00Z", end: "2026-03-09T14:30:00Z", durationMinutes: 120 })
      ]
    };

    const result = reflowService.reflow(input);
    const updated = byId({ ...input, workOrders: result.updatedWorkOrders }, "M1");

    expect(updated.data.endDate).toBe("2026-03-09T15:30:00.000Z");
    expect(result.changes[0].reasons.join(" ")).toContain("maintenance window");
  });

  it("resolves machine overlap by pushing later order", () => {
    const input: ReflowInput = {
      workCenters: [buildLine1()],
      workOrders: [
        wo({ id: "O1", start: "2026-03-10T08:00:00Z", end: "2026-03-10T10:00:00Z", durationMinutes: 120 }),
        wo({ id: "O2", start: "2026-03-10T09:00:00Z", end: "2026-03-10T10:00:00Z", durationMinutes: 60 })
      ]
    };

    const result = reflowService.reflow(input);
    const updated = byId({ ...input, workOrders: result.updatedWorkOrders }, "O2");

    expect(updated.data.startDate).toBe("2026-03-10T10:00:00.000Z");
    expect(updated.data.endDate).toBe("2026-03-10T11:00:00.000Z");
    expect(result.changes[0].reasons.join(" ")).toContain("machine");
  });

  it("throws for circular dependencies", () => {
    const input: ReflowInput = {
      workCenters: [buildLine1()],
      workOrders: [
        wo({ id: "X", start: "2026-03-09T08:00:00Z", end: "2026-03-09T10:00:00Z", durationMinutes: 120, dependsOn: ["Y"] }),
        wo({ id: "Y", start: "2026-03-09T10:00:00Z", end: "2026-03-09T12:00:00Z", durationMinutes: 120, dependsOn: ["X"] })
      ]
    };

    expect(() => reflowService.reflow(input)).toThrow("Circular dependency detected in work orders");
  });
});
