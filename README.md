# Buildify

A simple Windows tray app built with Tauri, React, TypeScript, and Rust. It polls GitHub Actions workflows and sends native Windows notifications when builds complete.

## Features

- GitHub token input with connection testing
- Polling interval options: 15, 30, 60, 120, 300 seconds
- Background polling and manual "Check now"
- Native Windows notifications for completed workflow runs
- Tray menu with open, check now, pause/resume, and quit
- Local state persistence for seen workflow runs

## Install dependencies

1. Install Node.js (LTS) and npm.
2. Install Rust and Cargo.
3. From the project folder:

```bash
npm install
```

## Run in dev mode

```bash
npm run dev
```

The app will launch in a Tauri window. Close the window to keep it running in the tray.

## Create a GitHub token

1. Go to https://github.com/settings/tokens.
2. Create a fine-grained personal access token.
3. Grant the token these permissions:
   - Metadata: Read
   - Actions: Read
   - Repository access: All repositories
4. Copy the token and paste it into the app settings.

## Build the Windows app

```bash
npm run build
```

The packaged installer or binaries will appear in `src-tauri/target/release/bundle/windows`.

## Polling logic

- The app polls GitHub at the selected interval.
- It loads saved settings and seen state on startup.
- On first run with a token, existing completed runs are marked as seen without notifications.
- The app notifies only when a run transitions from `queued` or `in_progress` to `completed`.
- Seen run IDs and status are persisted locally so notifications are not repeated across restarts.
