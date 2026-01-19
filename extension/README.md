# VS Code Speedrun Overlay

This extension sends live coding metrics from VS Code to a local overlay server,
so you can display a speedrun-style HUD in OBS.

Features
- Live timer + splits
- Code mix per file type (JS/CSS/HTML/TXT/OTH)
- Activity metrics (KPM, precision, focus, pace)
- Diagnostics summary
- Build status (manual or auto via tasks)

Setup
1) Open the overlay in OBS:
   - `overlay/overlay.html?server=localhost:17890`
2) Configure the extension (optional):
   - Settings: `speedrunOverlay.serverUrl`

How to use (VS Code integration)
- Status bar buttons:
  - SR Run: start/resume
  - SR Pause: pause
  - SR Split: add split
  - SR Stop: stop
  - SR Reset: reset
- Command palette:
  - "Speedrun: Start/Resume"
  - "Speedrun: Pause"
  - "Speedrun: Add Split"
  - "Speedrun: Stop (save summary)"
  - "Speedrun: Reset"

Auto-start server
- On the first "Run", the extension auto-starts the bundled local server
  if `serverUrl` points to localhost.

Build status
- Manual commands:
  - "Speedrun: Build Start"
  - "Speedrun: Build Stop (Success)"
  - "Speedrun: Build Stop (Fail)"
- Auto mode:
  - When a VS Code task of group Build (or name matching build/compile/dev/watch/etc.)
    starts/stops, the extension updates build status.
  - If diagnostics report errors during a running build, the build is marked as failed.

Notes
- Precision is affected by undo/redo (Ctrl+Z/Ctrl+Y).
- The overlay connects by WebSocket to `serverUrl` (default `http://localhost:17890`).
