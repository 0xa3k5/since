---
title: Undo for actions that throw work away
version: 0.1.0
merged: 2026-10-13
kind: Added
---
⌘Z now also undoes the actions that discard uncommitted work, not just changes to branches, tags and HEAD:

- discarding files, hunks or selected lines
- a hard reset
- choosing our or their version of a conflicted file
- dropping, applying or popping a stash

Before each of these, GitLanes saves the files it is about to touch, byte for byte, so undo restores them exactly. If that copy can't be saved, the action doesn't run. Undo won't overwrite a file you changed afterwards. Toasts for these actions have an Undo button, and the Edit menu names the step, for example "Undo Discard 4 lines in app.js".

The undo history keeps working after `git gc`, so undoing a branch delete still finds its commits.
