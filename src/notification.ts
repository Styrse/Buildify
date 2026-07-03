import {
  isPermissionGranted,
  requestPermission,
  sendNotification as sendTauriNotification,
} from '@tauri-apps/plugin-notification';
import { invoke } from '@tauri-apps/api/core';
import { openUrl as openerOpenUrl } from '@tauri-apps/plugin-opener';

async function sendBrowserNotification(title: string, body: string, url?: string, icon?: string): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    throw new Error('Notifications are not available');
  }

  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }

  if (Notification.permission !== 'granted') {
    throw new Error('Notification permission was not granted');
  }

  const options: NotificationOptions = { body };
  if (icon) {
    options.icon = icon;
  }

  const notification = new Notification(title, options);
  notification.onclick = () => {
    if (url) {
      openerOpenUrl(url);
    }
  };
}

export async function ensureNotificationPermission(): Promise<boolean> {
  let permissionGranted = await isPermissionGranted();
  if (!permissionGranted) {
    const permission = await requestPermission();
    permissionGranted = permission === 'granted';
  }

  return permissionGranted;
}

export async function sendNotification(title: string, body: string, url?: string, icon?: string): Promise<void> {
  try {
    if (!(await ensureNotificationPermission())) {
      throw new Error('Notification permission was not granted');
    }

    try {
      await invoke('send_native_notification', { title, body, url, icon });
      return;
    } catch {
      // Fall back to Tauri's cross-platform plugin when the custom Windows toast is unavailable.
    }

    sendTauriNotification({
      title,
      body,
      autoCancel: true,
      group: 'github-builds',
      extra: url ? { url } : undefined,
    });
  } catch (error) {
    try {
      await sendBrowserNotification(title, body, url, icon);
    } catch {
      throw error;
    }
  }
}

export async function openUrl(url: string): Promise<void> {
  await openerOpenUrl(url);
}
