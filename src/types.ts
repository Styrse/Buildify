import type { WorkflowRun } from './App';

export type NotificationSender = (title: string, body: string, url?: string, icon?: string) => Promise<void>;

export type WorkflowRunPayload = WorkflowRun;
