import type { AppSettings, SeenState } from './App';

const settingsKey = 'github-build-notifier-settings';
const seenStateKey = 'github-build-notifier-seen-state';

export async function loadSettings(): Promise<Partial<AppSettings>> {
  try {
    const raw = localStorage.getItem(settingsKey);
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as Partial<AppSettings>;
  } catch {
    return {};
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  localStorage.setItem(settingsKey, JSON.stringify(settings));
}

export async function loadSeenState(): Promise<Partial<SeenState>> {
  try {
    const raw = localStorage.getItem(seenStateKey);
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as Partial<SeenState>;
  } catch {
    return {};
  }
}

export async function saveSeenState(state: SeenState): Promise<void> {
  localStorage.setItem(seenStateKey, JSON.stringify(state));
}
