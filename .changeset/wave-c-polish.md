---
'@iron-proxy/core': patch
'@iron-proxy/electron': patch
---

Small fixes from the wave C review.

- Several processes on one data directory (the tray app, the CLI, a running `serve`) no longer drop each other's changes. `FileProfileStore`, `FileStateStore` and `FileUsageStore` write under a lock file next to the data file (`<file>.lock`, created exclusively, retried for up to about 2 s, removed as stale after 10 s), re-read the file and apply only this process's own changes (profiles or states put, ids deleted, usage records appended since the last write) before the atomic write. A read re-loads the file when it changed on disk, with this process's unsaved changes on top. A profile added in the tray survives the CLI's next write, a park is not lost, a delete is not brought back, and usage records from every process add up. The stores take an optional `lock: { timeoutMs?, staleMs? }` and expose `externalWrites`, the number of file versions written by another process they have read.
- Atomic JSON writes retry a rename Windows briefly refuses while another process has the file open.
- Notifications: when a park was already shown because the next account took longer than `maxHoldMs` to answer, the switch that follows is kept quiet if that park was shown within `throttleMs`, so one incident still makes one notification.
