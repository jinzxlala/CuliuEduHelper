import { createServiceStatus, type ServiceStatus } from "@culiu/shared";

export function buildWorkerHealth(): ServiceStatus {
  return createServiceStatus("worker");
}
