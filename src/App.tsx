import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchAuthenticatedUser, fetchRepositoriesWithActions } from './githubApi';
import type { GitHubConfig } from './githubApi';
import { DEFAULT_GITHUB_SERVER_URL, deriveEndpoints, normalizeServerUrl } from './githubUrls';
import { ensureNotificationPermission, openUrl, sendNotification } from './notification';
import { loadSettings, loadSeenState, saveSeenState, saveSettings } from './storage';
import { Poller } from './poller';
import './App.css';

export type Repository = {
  id: number;
  name: string;
  full_name: string;
};

export type WorkflowRun = {
  id: number;
  html_url: string;
  repository: string;
  workflow_name: string;
  summary: string;
  head_branch: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
};

export type AppSettings = {
  token: string;
  serverUrl: string;
  pollingIntervalSeconds: number;
  followedRepositories: Record<string, boolean>;
};

export type SeenState = {
  seenRunIds: Record<number, { status: string; conclusion: string | null }>;
  lastSyncedAt: string;
};

type Theme = 'light' | 'dark';
type Tone = 'success' | 'warning' | 'danger' | 'neutral';
type Tab = 'dashboard' | 'repositories' | 'settings';

const defaultSettings: AppSettings = {
  token: '',
  serverUrl: DEFAULT_GITHUB_SERVER_URL,
  pollingIntervalSeconds: 60,
  followedRepositories: {},
};

const defaultSeenState: SeenState = {
  seenRunIds: {},
  lastSyncedAt: new Date().toISOString(),
};

const reconnectIntervalMs = 5 * 60 * 1000;

const getInitialTheme = (): Theme => {
  const savedTheme = window.localStorage.getItem('buildify-theme');
  if (savedTheme === 'light' || savedTheme === 'dark') {
    return savedTheme;
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const getConnectionTone = (status: string): Tone => {
  if (status === 'Connected' || status === 'Saved') return 'success';
  if (status.toLowerCase().includes('fail')) return 'danger';
  if (status === 'Testing...') return 'warning';
  return 'neutral';
};

const getRunTone = (conclusion: string | null): Tone => {
  if (conclusion === 'success') return 'success';
  if (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out') {
    return 'danger';
  }
  if (conclusion === 'neutral' || conclusion === 'skipped') return 'warning';
  return 'neutral';
};

const truncateRunSummary = (summary: string, maxLength = 96) => {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
};

const formatRunDateTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [seenState, setSeenStateState] = useState<SeenState>(defaultSeenState);
  const seenStateRef = useRef<SeenState>(defaultSeenState);
  const [connectionStatus, setConnectionStatus] = useState('Not connected');
  const [githubUsername, setGithubUsername] = useState<string>('');
  const [lastChecked, setLastChecked] = useState<string>('Never');
  const [repositoryCount, setRepositoryCount] = useState<number>(0);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [isLoadingRepositories, setIsLoadingRepositories] = useState<boolean>(false);
  const [runningCount, setRunningCount] = useState<number>(0);
  const [recentEvents, setRecentEvents] = useState<string[]>([]);
  const [isPolling, setIsPolling] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [latestRuns, setLatestRuns] = useState<WorkflowRun[]>([]);
  const isCheckingRef = useRef(false);
  const isReconnectingRef = useRef(false);
  const persistedServerUrlRef = useRef(DEFAULT_GITHUB_SERVER_URL);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('buildify-theme', theme);
  }, [theme]);

  const updateSeenState = useCallback((state: SeenState) => {
    seenStateRef.current = state;
    setSeenStateState(state);
  }, []);

  const logEvent = useCallback((message: string) => {
    setRecentEvents((prev) => [
      `${new Date().toLocaleTimeString()}: ${message}`,
      ...prev.slice(0, 19),
    ]);
  }, []);

  useEffect(() => {
    void ensureNotificationPermission().then((granted) => {
      if (!granted) {
        logEvent('Notification permission was not granted.');
      }
    }).catch((error) => {
      logEvent('Notification setup failed: ' + (error instanceof Error ? error.message : 'unknown error'));
    });
  }, [logEvent]);

  const loadRepositoriesForToken = useCallback(async (config: GitHubConfig, shouldLog = false) => {
    if (!config.token) {
      setRepositories([]);
      return;
    }

    setIsLoadingRepositories(true);
    try {
      const fetchedRepositories = await fetchRepositoriesWithActions(config);
      setRepositories(fetchedRepositories);
      if (shouldLog) {
        logEvent(`Loaded ${fetchedRepositories.length} Actions-enabled repositories.`);
      }
    } catch (error) {
      setRepositories([]);
      if (shouldLog) {
        logEvent('Repository list failed: ' + (error instanceof Error ? error.message : 'unknown error'));
      }
    } finally {
      setIsLoadingRepositories(false);
    }
  }, [logEvent]);

  useEffect(() => {
    const init = async () => {
      const loadedSettings = await loadSettings();
      const loadedSeenState = await loadSeenState();
      const merged: AppSettings = { ...defaultSettings, ...loadedSettings };
      setSettings(merged);
      persistedServerUrlRef.current = normalizeServerUrl(merged.serverUrl);
      const mergedSeen = { ...defaultSeenState, ...loadedSeenState };
      updateSeenState(mergedSeen);
      if (merged.token) {
        const config: GitHubConfig = { token: merged.token, serverUrl: merged.serverUrl };
        isReconnectingRef.current = true;
        try {
          const user = await fetchAuthenticatedUser(config);
          setGithubUsername(user?.login ?? '');
          setConnectionStatus(user ? 'Connected' : 'Connection failed');
          if (user) {
            await loadRepositoriesForToken(config);
          }
        } finally {
          isReconnectingRef.current = false;
        }
      }
    };

    init();
  }, [loadRepositoriesForToken, updateSeenState]);

  const runConnectionCheck = useCallback(async (
    source: 'manual' | 'background',
    successStatus: 'Connected' | 'Saved' = 'Connected',
  ) => {
    if (!settings.token || isReconnectingRef.current) {
      return false;
    }

    isReconnectingRef.current = true;
    if (source === 'manual') {
      setConnectionStatus('Testing...');
    }

    const config: GitHubConfig = { token: settings.token, serverUrl: settings.serverUrl };

    try {
      const user = await fetchAuthenticatedUser(config);
      setGithubUsername(user?.login ?? '');
      if (user) {
        await loadRepositoriesForToken(config, source === 'manual');
      } else {
        setRepositories([]);
      }

      const isConnected = user !== null;
      setConnectionStatus(isConnected ? successStatus : 'Connection failed');

      if (source === 'manual') {
        logEvent(isConnected ? 'Connection test succeeded.' : 'Connection test failed.');
      } else if (isConnected) {
        logEvent('Connection restored automatically.');
      } else {
        logEvent('Automatic reconnect attempt failed.');
      }

      return isConnected;
    } finally {
      isReconnectingRef.current = false;
    }
  }, [loadRepositoriesForToken, logEvent, settings.serverUrl, settings.token]);

  const handleSaveSettings = async () => {
    setIsSaving(true);
    try {
      const nextServerUrl = normalizeServerUrl(settings.serverUrl);
      const serverChanged = nextServerUrl !== persistedServerUrlRef.current;
      let nextSettings: AppSettings = { ...settings, serverUrl: nextServerUrl };

      if (serverChanged) {
        // Run ids and repository names are only unique within one server.
        const freshSeenState: SeenState = { seenRunIds: {}, lastSyncedAt: new Date().toISOString() };
        updateSeenState(freshSeenState);
        await saveSeenState(freshSeenState);
        nextSettings = { ...nextSettings, followedRepositories: {} };
        setGithubUsername('');
        setRepositories([]);
        logEvent('GitHub server changed. Cleared seen runs and follow list.');
      }

      setSettings(nextSettings);
      await saveSettings(nextSettings);
      persistedServerUrlRef.current = nextServerUrl;
      await runConnectionCheck('manual', 'Saved');
      logEvent('Settings saved.');
    } catch (error) {
      setConnectionStatus('Save failed');
      logEvent('Error saving settings.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestConnection = async () => {
    await runConnectionCheck('manual', 'Connected');
  };

  const handleRepositoryFollowChange = (fullName: string, followed: boolean) => {
    const nextFollowedRepositories = { ...settings.followedRepositories };
    if (followed) {
      delete nextFollowedRepositories[fullName];
    } else {
      nextFollowedRepositories[fullName] = false;
    }

    const nextSettings = { ...settings, followedRepositories: nextFollowedRepositories };
    setSettings(nextSettings);
    void saveSettings(nextSettings);
  };

  const handleFollowAllRepositories = () => {
    const nextFollowedRepositories = { ...settings.followedRepositories };
    repositories.forEach((repo) => {
      delete nextFollowedRepositories[repo.full_name];
    });
    const nextSettings = { ...settings, followedRepositories: nextFollowedRepositories };
    setSettings(nextSettings);
    void saveSettings(nextSettings);
  };

  const handleFollowNoRepositories = () => {
    const nextSettings = {
      ...settings,
      followedRepositories: {
        ...settings.followedRepositories,
        ...Object.fromEntries(repositories.map((repo) => [repo.full_name, false])),
      },
    };
    setSettings(nextSettings);
    void saveSettings(nextSettings);
  };

  const runPoll = useCallback(async (source: 'manual' | 'background') => {
    if (!settings.token) {
      if (source === 'manual') {
        logEvent('Token is required before checking.');
      }
      return;
    }

    if (isCheckingRef.current) {
      logEvent(source === 'manual' ? 'Check skipped because another poll is already running.' : 'Background poll skipped because another poll is already running.');
      return;
    }

    isCheckingRef.current = true;

    try {
      const poller = new Poller(
        settings,
        seenStateRef.current,
        updateSeenState,
        logEvent,
        sendNotification,
      );
      const result = await poller.checkNow();
      setRepositoryCount(result.repositoryCount);
      setRunningCount(result.runningCount);
      setLatestRuns(result.latestCompletedRuns);
      setLastChecked(new Date().toLocaleTimeString());
    } catch (error) {
      logEvent(
        `${source === 'manual' ? 'Check now' : 'Background poll'} failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    } finally {
      isCheckingRef.current = false;
    }
  }, [settings, logEvent, updateSeenState]);

  const handleCheckNow = useCallback(async () => {
    await runPoll('manual');
  }, [runPoll]);

  const handleTogglePolling = useCallback(() => {
    setIsPolling((prev) => {
      const next = !prev;
      logEvent(`Polling ${next ? 'resumed' : 'paused'}.`);
      return next;
    });
  }, [logEvent]);

  useEffect(() => {
    if (!settings.token || !isPolling) {
      return undefined;
    }

    const interval = setInterval(async () => {
      await runPoll('background');
    }, settings.pollingIntervalSeconds * 1000);

    return () => clearInterval(interval);
  }, [settings, isPolling, runPoll]);

  useEffect(() => {
    if (!settings.token || connectionStatus === 'Connected' || connectionStatus === 'Saved') {
      return undefined;
    }

    const interval = setInterval(() => {
      void runConnectionCheck('background', 'Connected');
    }, reconnectIntervalMs);

    return () => clearInterval(interval);
  }, [connectionStatus, runConnectionCheck, settings.token]);

  useEffect(() => {
    let unlistenCheckNow: (() => void) | undefined;
    let unlistenToggle: (() => void) | undefined;

    const setupListeners = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlistenCheckNow = await listen('tray-check-now', async () => {
        await handleCheckNow();
      });
      unlistenToggle = await listen('tray-toggle-pause', async () => {
        handleTogglePolling();
      });
    };

    setupListeners();

    return () => {
      unlistenCheckNow?.();
      unlistenToggle?.();
    };
  }, [handleCheckNow, handleTogglePolling]);

  const recentDisplay = useMemo(() => recentEvents.slice(0, 6), [recentEvents]);
  const seenCount = useMemo(() => Object.keys(seenState.seenRunIds).length, [seenState.seenRunIds]);
  const connectionTone = getConnectionTone(connectionStatus);
  const endpoints = useMemo(() => deriveEndpoints(settings.serverUrl), [settings.serverUrl]);
  const githubTokenSettingsUrl = `${endpoints.webBase}/settings/personal-access-tokens/new`;
  const githubProfileUrl = githubUsername ? `${endpoints.webBase}/${githubUsername}` : endpoints.webBase;
  const followedRepositoryCount = useMemo(
    () => repositories.filter((repo) => settings.followedRepositories[repo.full_name] !== false).length,
    [repositories, settings.followedRepositories],
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Desktop tray monitor</p>
          <h1>Buildify</h1>
          <p>GitHub Actions status, polling, and notifications in one small window.</p>
        </div>
        <div className="header-actions">
          <button type="button" className="secondary-button" onClick={() => void openUrl(githubProfileUrl)}>
            GitHub
          </button>
          <button
            type="button"
            className="theme-toggle"
            aria-pressed={theme === 'dark'}
            onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
          >
            <span className="toggle-track" aria-hidden="true">
              <span className="toggle-thumb" />
            </span>
            <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
          </button>
        </div>
      </header>

      <nav className="tab-nav" aria-label="Views">
        {(['dashboard', 'repositories', 'settings'] as Tab[]).map((tab) => (
          <button
            type="button"
            key={tab}
            className={`tab-button ${activeTab === tab ? 'active' : ''}`}
            aria-current={activeTab === tab ? 'page' : undefined}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </nav>

      <main className="tab-panel">
        {activeTab === 'dashboard' && (
          <>
            <section className="summary-grid" aria-label="Current status">
              <article className="summary-card">
                <span className="summary-label">Connection</span>
                <strong>{connectionStatus}</strong>
                <span className={`status-pill ${connectionTone}`}>{connectionTone}</span>
              </article>
              <article className="summary-card">
                <span className="summary-label">Polling</span>
                <strong>{isPolling ? 'Active' : 'Paused'}</strong>
                <span className={`status-pill ${isPolling ? 'success' : 'warning'}`}>
                  {settings.pollingIntervalSeconds}s interval
                </span>
              </article>
              <article className="summary-card">
                <span className="summary-label">Repositories</span>
                <strong>{followedRepositoryCount}</strong>
                <span>{repositoryCount} checked last run</span>
              </article>
              <article className="summary-card">
                <span className="summary-label">Running</span>
                <strong>{runningCount}</strong>
                <span>workflows now</span>
              </article>
            </section>

            <section className="dashboard-grid">
              <section className="panel runtime-panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">Runtime</p>
                    <h2>Status</h2>
                  </div>
                  <span className={`status-pill ${isPolling ? 'success' : 'warning'}`}>
                    {isPolling ? 'Active' : 'Paused'}
                  </span>
                </div>

                <div className="metric-list">
                  <div>
                    <span>Last checked</span>
                    <strong>{lastChecked}</strong>
                  </div>
                  <div>
                    <span>Seen runs</span>
                    <strong>{seenCount}</strong>
                  </div>
                  <div>
                    <span>Latest completed</span>
                    <strong>{latestRuns.length}</strong>
                  </div>
                </div>

                <div className="action-row">
                  <button type="button" onClick={handleTogglePolling}>
                    {isPolling ? 'Pause polling' : 'Resume polling'}
                  </button>
                  <button type="button" className="secondary-button" onClick={handleCheckNow}>
                    Check now
                  </button>
                </div>
              </section>

              <section className="panel latest-panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">Workflows</p>
                    <h2>Latest Completed Runs</h2>
                  </div>
                </div>

                {latestRuns.length === 0 ? (
                  <div className="empty-state">No completed workflows yet.</div>
                ) : (
                  <ul className="run-list">
                    {latestRuns.map((run) => (
                      <li key={run.id}>
                        <div>
                          <strong>{run.workflow_name}</strong>
                          <span>
                            {run.repository} / {run.head_branch}
                          </span>
                          <span className="run-meta">
                            Completed {formatRunDateTime(run.updated_at)}
                          </span>
                          {run.summary && (
                            <span className="run-summary" title={run.summary}>
                              {truncateRunSummary(run.summary)}
                            </span>
                          )}
                        </div>
                        <div className="run-actions">
                          <span className={`status-pill ${getRunTone(run.conclusion)}`}>
                            {run.conclusion ?? run.status}
                          </span>
                          <button
                            type="button"
                            className="ghost-button compact-button"
                            onClick={() => void openUrl(run.html_url)}
                          >
                            Open
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="panel events-panel dashboard-activity">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">Activity</p>
                    <h2>Recent Events</h2>
                  </div>
                </div>

                {recentDisplay.length === 0 ? (
                  <div className="empty-state">No recent events.</div>
                ) : (
                  <ol className="event-list">
                    {recentDisplay.slice(0, 4).map((event, index) => (
                      <li key={`${event}-${index}`}>{event}</li>
                    ))}
                  </ol>
                )}
              </section>
            </section>
          </>
        )}

        {activeTab === 'repositories' && (
          <section className="panel repositories-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Repositories</p>
                <h2>Follow List</h2>
              </div>
              <span className="status-pill neutral">
                {followedRepositoryCount}/{repositories.length}
              </span>
            </div>

            <div className="repo-toolbar">
              <button type="button" className="secondary-button" onClick={handleFollowAllRepositories}>
                All
              </button>
              <button type="button" className="secondary-button" onClick={handleFollowNoRepositories}>
                None
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void loadRepositoriesForToken({ token: settings.token, serverUrl: settings.serverUrl }, true)}
                disabled={!settings.token || isLoadingRepositories}
              >
                {isLoadingRepositories ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>

            {repositories.length === 0 ? (
              <div className="empty-state">
                {isLoadingRepositories ? 'Loading repositories...' : 'No Actions-enabled repositories loaded.'}
              </div>
            ) : (
              <div className="repo-list">
                {repositories.map((repo) => (
                  <label className="repo-row" key={repo.id}>
                    <input
                      type="checkbox"
                      checked={settings.followedRepositories[repo.full_name] !== false}
                      onChange={(event) => handleRepositoryFollowChange(repo.full_name, event.target.checked)}
                    />
                    <span>
                      <strong>{repo.name}</strong>
                      <small>{repo.full_name}</small>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>
        )}

        {activeTab === 'settings' && (
          <section className="panel settings-panel settings-tab-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Account</p>
                <h2>Settings</h2>
              </div>
              <span className={`status-pill ${connectionTone}`}>{connectionStatus}</span>
            </div>

            <label className="field">
              <span className="field-label">GitHub server URL</span>
              <input
                type="url"
                value={settings.serverUrl}
                onChange={(event) => setSettings({ ...settings, serverUrl: event.target.value })}
                placeholder="https://github.com"
              />
              <span className="field-hint">API: {endpoints.apiBase}</span>
            </label>

            <label className="field">
              <span className="field-label">GitHub access token</span>
              <input
                type="password"
                value={settings.token}
                onChange={(event) => setSettings({ ...settings, token: event.target.value })}
                placeholder="ghp_..."
              />
            </label>

            <details className="token-help">
              <summary className="token-help-summary">Token help</summary>
              <div className="token-help-content">
                <div className="token-help-header">
                  <strong>Create token</strong>
                  <button
                    type="button"
                    className="ghost-button compact-button"
                    onClick={() => void openUrl(githubTokenSettingsUrl)}
                  >
                    Open GitHub token page
                  </button>
                </div>
                <p>Create a fine-grained personal access token and grant these permissions:</p>
                <ul className="token-help-list">
                  <li>Metadata: Read</li>
                  <li>Actions: Read</li>
                  <li>Repository access: All repositories</li>
                </ul>
              </div>
            </details>

            <label className="field">
              <span className="field-label">Polling interval</span>
              <select
                value={settings.pollingIntervalSeconds}
                onChange={(event) =>
                  setSettings({ ...settings, pollingIntervalSeconds: Number(event.target.value) })
                }
              >
                <option value={15}>15 seconds</option>
                <option value={30}>30 seconds</option>
                <option value={60}>60 seconds</option>
                <option value={120}>120 seconds</option>
                <option value={300}>300 seconds</option>
              </select>
            </label>

            <div className="action-row">
              <button type="button" onClick={handleSaveSettings} disabled={isSaving}>
                {isSaving ? 'Saving...' : 'Save settings'}
              </button>
              <button type="button" className="secondary-button" onClick={handleTestConnection}>
                Test connection
              </button>
            </div>
          </section>
        )}
      </main>

      <footer className="footer-note">
        <p>Closing the window keeps the app running from the tray.</p>
      </footer>
    </div>
  );
}

export default App;
