export type ISODateString = string;

export interface BaseDoc<TType extends string, TData> {
  docId: string;
  docType: TType;
  data: TData;
}

export interface Shift {
  // 0-6, Sunday = 0
  dayOfWeek: number;
  // 0-23
  startHour: number;
  // 0-23
  endHour: number;
}

export interface MaintenanceWindow {
  startDate: ISODateString;
  endDate: ISODateString;
  reason?: string;
}

export interface WorkOrderData {
  workOrderNumber: string;
  manufacturingOrderId: string;
  workCenterId: string;
  startDate: ISODateString;
  endDate: ISODateString;
  durationMinutes: number;
  isMaintenance: boolean;
  dependsOnWorkOrderIds: string[];
}

export interface WorkCenterData {
  name: string;
  shifts: Shift[];
  maintenanceWindows: MaintenanceWindow[];
}

export interface ManufacturingOrderData {
  manufacturingOrderNumber: string;
  itemId: string;
  quantity: number;
  dueDate: ISODateString;
}

export type WorkOrder = BaseDoc<"workOrder", WorkOrderData>;
export type WorkCenter = BaseDoc<"workCenter", WorkCenterData>;
export type ManufacturingOrder = BaseDoc<"manufacturingOrder", ManufacturingOrderData>;

export interface ReflowInput {
  workOrders: WorkOrder[];
  workCenters: WorkCenter[];
  manufacturingOrders?: ManufacturingOrder[];
}

export interface ReflowChange {
  workOrderId: string;
  oldStartDate: ISODateString;
  newStartDate: ISODateString;
  oldEndDate: ISODateString;
  newEndDate: ISODateString;
  shiftMinutes: number;
  reasons: string[];
}

export interface ReflowResult {
  updatedWorkOrders: WorkOrder[];
  changes: ReflowChange[];
  explanation: string[];
}

export interface ScheduledInterval {
  workOrderId: string;
  start: Date;
  end: Date;
}
