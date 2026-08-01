import { createServiceStatus, type ServiceStatus } from "@culiu/shared";

export function buildWebHealth(): ServiceStatus {
  return createServiceStatus("web");
}
