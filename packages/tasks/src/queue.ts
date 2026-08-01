import {
  Queue,
  Worker,
  type JobsOptions,
  type Processor,
  type QueueOptions,
  type WorkerOptions,
} from "bullmq";
import type Redis from "ioredis";

import { TASK_QUEUE_NAME, TaskEnvelopeSchema, type TaskEnvelope, type TaskName } from "./schema.js";

export type TaskHandler = (task: TaskEnvelope) => Promise<unknown>;
export type TaskHandlers = Readonly<Record<TaskName, TaskHandler>>;

export interface TaskQueueOptions {
  connection: Redis;
  queueName?: string;
}

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: {
    delay: 1_000,
    type: "fixed",
  },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 1_000 },
};

export function createTaskQueue(options: TaskQueueOptions): Queue<TaskEnvelope> {
  const queueOptions: QueueOptions = {
    connection: options.connection,
    defaultJobOptions,
  };
  return new Queue<TaskEnvelope>(options.queueName ?? TASK_QUEUE_NAME, queueOptions);
}

export async function enqueueTask(
  queue: Queue<TaskEnvelope>,
  untrustedTask: TaskEnvelope,
): Promise<string> {
  const task = TaskEnvelopeSchema.parse(untrustedTask);
  const job = await queue.add(task.taskName, task, {
    jobId: task.idempotencyKey,
  });
  if (job.id === undefined) {
    throw new Error("BullMQ did not return a job identifier.");
  }
  return job.id;
}

export interface TaskWorkerOptions extends TaskQueueOptions {
  concurrency?: number;
  handlers: TaskHandlers;
}

export function createTaskWorker(options: TaskWorkerOptions): Worker<TaskEnvelope> {
  const processor: Processor<TaskEnvelope> = async (job) => {
    const task = TaskEnvelopeSchema.parse(job.data);
    if (task.taskName !== job.name) {
      throw new Error("Task name does not match the BullMQ job name.");
    }
    return options.handlers[task.taskName](task);
  };

  const workerOptions: WorkerOptions = {
    concurrency: options.concurrency ?? 1,
    connection: options.connection,
  };

  return new Worker<TaskEnvelope>(options.queueName ?? TASK_QUEUE_NAME, processor, workerOptions);
}
