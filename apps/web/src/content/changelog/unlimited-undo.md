---
title: Undo history has no step limit
version: 0.1.0
merged: 2026-10-13
kind: Improved
---
⌘Z can now go back through your whole history in a repository, not just the last 200 steps. Older steps are stored on disk and loaded only when you reach them, so a long history doesn't slow the app down.
