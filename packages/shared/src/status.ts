import { z } from "zod";

export const ServiceStatusSchema = z.object({
  service: z.enum(["web", "knowledge-web", "operations-web", "worker"]),
  status: z.literal("available"),
});

export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

export function createServiceStatus(service: ServiceStatus["service"]): ServiceStatus {
  return ServiceStatusSchema.parse({
    service,
    status: "available",
  });
}
