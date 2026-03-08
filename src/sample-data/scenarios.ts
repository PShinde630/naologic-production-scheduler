import { ReflowInput, WorkCenter, WorkOrder } from "../reflow/types";

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
  number: string;
  start: string;
  end: string;
  durationMinutes: number;
  dependsOn?: string[];
  isMaintenance?: boolean;
  centerId?: string;
}): WorkOrder {
  return {
    docId: params.id,
    docType: "workOrder",
    data: {
      workOrderNumber: params.number,
      manufacturingOrderId: "MO-1",
      workCenterId: params.centerId ?? "LINE-1",
      startDate: params.start,
      endDate: params.end,
      durationMinutes: params.durationMinutes,
      isMaintenance: params.isMaintenance ?? false,
      dependsOnWorkOrderIds: params.dependsOn ?? []
    }
  };
}

export const scenarios: Array<{ name: string; description: string; input: ReflowInput }> = [
  {
    name: "Delay Cascade",
    description: "A longer first job pushes dependent downstream jobs later.",
    input: {
      workCenters: [buildLine1()],
      workOrders: [
        wo({
          id: "WO-A",
          number: "WO-1001",
          start: "2026-03-09T08:00:00Z",
          end: "2026-03-09T12:00:00Z",
          durationMinutes: 240
        }),
        wo({
          id: "WO-B",
          number: "WO-1002",
          start: "2026-03-09T09:00:00Z",
          end: "2026-03-09T11:00:00Z",
          durationMinutes: 120,
          dependsOn: ["WO-A"]
        }),
        wo({
          id: "WO-C",
          number: "WO-1003",
          start: "2026-03-09T10:00:00Z",
          end: "2026-03-09T11:00:00Z",
          durationMinutes: 60,
          dependsOn: ["WO-B"]
        })
      ]
    }
  },
  {
    name: "Shift Boundary",
    description: "A job starting late in the day pauses at shift end and resumes next day.",
    input: {
      workCenters: [buildLine1()],
      workOrders: [
        wo({
          id: "WO-S1",
          number: "WO-2001",
          start: "2026-03-10T16:00:00Z",
          end: "2026-03-10T18:00:00Z",
          durationMinutes: 120
        })
      ]
    }
  },
  {
    name: "Maintenance Conflict",
    description: "A job crossing a maintenance window pauses and resumes after maintenance.",
    input: {
      workCenters: [buildLine1()],
      workOrders: [
        wo({
          id: "WO-M1",
          number: "WO-3001",
          start: "2026-03-09T12:30:00Z",
          end: "2026-03-09T14:30:00Z",
          durationMinutes: 120
        })
      ]
    }
  }
];
