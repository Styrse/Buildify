import type { AppSettings, Repository, WorkflowRun } from './App';

const githubApiBase = 'https://api.github.com';

const defaultHeaders = (token: string) => ({
  Authorization: `token ${token}`,
  Accept: 'application/vnd.github+json',
});

export type GitHubUser = {
  login: string;
};

export async function fetchAuthenticatedUser(token: string): Promise<GitHubUser | null> {
  if (!token) {
    return null;
  }

  try {
    const response = await fetch(`${githubApiBase}/user`, {
      headers: defaultHeaders(token),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return typeof data.login === 'string' ? { login: data.login } : null;
  } catch (error) {
    return null;
  }
}

export async function testConnection(token: string): Promise<boolean> {
  return (await fetchAuthenticatedUser(token)) !== null;
}

export async function checkConnection(token: string): Promise<boolean> {
  return testConnection(token);
}

export async function fetchRepositories(token: string): Promise<Repository[]> {
  const repos: Repository[] = [];
  let page = 1;

  while (true) {
    const response = await fetch(`${githubApiBase}/user/repos?per_page=100&page=${page}`, {
      headers: defaultHeaders(token),
    });

    if (!response.ok) {
      throw new Error(`GitHub repos fetch failed (${response.status})`);
    }

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    repos.push(...data.map((repo: any) => ({
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
    })));
    page += 1;
  }

  return repos;
}

export async function fetchRepositoriesWithActions(token: string): Promise<Repository[]> {
  const repos = await fetchRepositories(token);
  const checkedRepos = await Promise.all(repos.map(async (repo) => {
    try {
      const response = await fetch(`${githubApiBase}/repos/${repo.full_name}/actions/workflows?per_page=1`, {
        headers: defaultHeaders(token),
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      return data.total_count > 0 ? repo : null;
    } catch {
      return null;
    }
  }));

  return checkedRepos.filter((repo): repo is Repository => repo !== null);
}

function getRunSummary(run: any): string {
  const summary = typeof run.display_title === 'string' ? run.display_title : '';
  if (summary.trim()) {
    return summary.trim();
  }

  const commitMessage = typeof run.head_commit?.message === 'string' ? run.head_commit.message : '';
  return commitMessage.split(/\r?\n/)[0].trim();
}

export async function fetchRepositoriesWithWorkflowRuns(
  token: string,
  followedRepositories: Record<string, boolean> = {},
): Promise<{
  repository: Repository;
  workflowRuns: WorkflowRun[];
}[]> {
  const repos = (await fetchRepositoriesWithActions(token)).filter(
    (repo) => followedRepositories[repo.full_name] !== false,
  );

  return Promise.all(repos.map(async (repo) => {
    try {
      const response = await fetch(`${githubApiBase}/repos/${repo.full_name}/actions/runs?per_page=20`, {
        headers: defaultHeaders(token),
      });
      if (!response.ok) {
        return { repository: repo, workflowRuns: [] };
      }
      const runsData = await response.json();
      const workflowRuns: WorkflowRun[] = (runsData.workflow_runs || []).map((run: any) => ({
        id: run.id,
        html_url: run.html_url,
        repository: repo.full_name,
        workflow_name: run.name || run.workflow_name || 'Unknown workflow',
        summary: getRunSummary(run),
        head_branch: run.head_branch,
        status: run.status,
        conclusion: run.conclusion,
        created_at: run.created_at,
        updated_at: run.updated_at,
      })).filter((run) => run.status === 'completed' || run.status === 'queued' || run.status === 'in_progress');

      return { repository: repo, workflowRuns };
    } catch {
      return { repository: repo, workflowRuns: [] };
    }
  }));
}
