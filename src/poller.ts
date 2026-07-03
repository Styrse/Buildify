import type { AppSettings, SeenState, WorkflowRun } from './App';
import { fetchRepositoriesWithWorkflowRuns } from './githubApi';
import { saveSeenState } from './storage';
import type { NotificationSender } from './types';

export type PollResult = {
  repositoryCount: number;
  runningCount: number;
  latestCompletedRuns: WorkflowRun[];
};

const conclusionTitles: Record<string, string> = {
  success: 'Build succeeded',
  failure: 'Build failed',
  cancelled: 'Build cancelled',
  timed_out: 'Build timed out',
  skipped: 'Build skipped',
};

const conclusionIcons: Record<string, string> = {
  success: '/notifications/build-success.png',
  failure: '/notifications/build-failure.png',
  cancelled: '/notifications/build-cancelled.png',
  timed_out: '/notifications/build-timed-out.png',
  skipped: '/notifications/build-skipped.png',
};

function isCompleted(run: WorkflowRun) {
  return run.status === 'completed';
}

function isRunning(run: WorkflowRun) {
  return run.status === 'queued' || run.status === 'in_progress';
}

function hasCompletedSinceLastSync(run: WorkflowRun, lastSyncedAt: string) {
  const lastSyncTime = new Date(lastSyncedAt).getTime();
  const runUpdatedTime = new Date(run.updated_at).getTime();

  return Number.isFinite(lastSyncTime) && Number.isFinite(runUpdatedTime) && runUpdatedTime > lastSyncTime;
}

function shouldNotifyExistingRun(run: WorkflowRun, seenState: SeenState) {
  const seen = seenState.seenRunIds[run.id];
  if (!seen) {
    return false;
  }

  return seen.status !== run.status && isCompleted(run);
}

function buildNotificationPayload(run: WorkflowRun) {
  const title = conclusionTitles[run.conclusion || ''] ?? 'Build completed';
  const body = `${run.repository}: ${run.workflow_name} on ${run.head_branch}`;
  const icon = conclusionIcons[run.conclusion || ''] ?? '/notifications/build-completed.png';
  return { title, body, url: run.html_url, icon };
}

export class Poller {
  private settings: AppSettings;
  private seenState: SeenState;
  private setSeenState: (state: SeenState) => void;
  private logEvent: (message: string) => void;
  private sendNotification: NotificationSender;

  constructor(
    settings: AppSettings,
    seenState: SeenState,
    setSeenState: (state: SeenState) => void,
    logEvent: (message: string) => void,
    sendNotification: NotificationSender,
  ) {
    this.settings = settings;
    this.seenState = seenState;
    this.setSeenState = setSeenState;
    this.logEvent = logEvent;
    this.sendNotification = sendNotification;
  }

  private async notifyRun(run: WorkflowRun, repositoryFullName: string) {
    const payload = buildNotificationPayload(run);

    try {
      await this.sendNotification(payload.title, payload.body, payload.url, payload.icon);
      this.logEvent(`Notification sent for ${repositoryFullName} ${run.workflow_name}`);
    } catch (error) {
      this.logEvent('Notification failed: ' + (error instanceof Error ? error.message : 'unknown error'));
    }
  }

  public async checkNow(): Promise<PollResult> {
    const repositories = await fetchRepositoriesWithWorkflowRuns(
      this.settings.token,
      this.settings.followedRepositories,
    );
    const repositoryCount = repositories.length;
    let runningCount = 0;
    const previousLastSyncedAt = this.seenState.lastSyncedAt;
    const nextSeenState = { ...this.seenState, seenRunIds: { ...this.seenState.seenRunIds } };

    for (const entry of repositories) {
      for (const run of entry.workflowRuns) {
        if (isRunning(run)) {
          runningCount += 1;
          nextSeenState.seenRunIds[run.id] = { status: run.status, conclusion: run.conclusion };
          continue;
        }

        if (!nextSeenState.seenRunIds[run.id]) {
          if (isCompleted(run) && hasCompletedSinceLastSync(run, previousLastSyncedAt)) {
            await this.notifyRun(run, entry.repository.full_name);
          }

          nextSeenState.seenRunIds[run.id] = { status: run.status, conclusion: run.conclusion };
          continue;
        }

        if (shouldNotifyExistingRun(run, nextSeenState)) {
          await this.notifyRun(run, entry.repository.full_name);
          nextSeenState.seenRunIds[run.id] = { status: run.status, conclusion: run.conclusion };
        }
      }
    }

    nextSeenState.lastSyncedAt = new Date().toISOString();
    this.setSeenState(nextSeenState);
    await saveSeenState(nextSeenState);
    const latestCompletedRuns = repositories
      .flatMap((entry) => entry.workflowRuns)
      .filter((run) => run.status === 'completed')
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 5);
    return { repositoryCount, runningCount, latestCompletedRuns };
  }
}
