---
title: Beta 1
version: 0.1.0-beta.1
order: 1
released: true
headline: Review, Catch up and Branches.
soft: Keep up with a busy repository.
shot: ../../assets/app/catchup-dark.png
shotAlt: Catch up, listing the pull requests that merged since your checkpoint, grouped by day
highlights:
  - title: Review, one list at a time
    text: Needs you, Stuck and Ready. A pull request's description, checks and files read in one scroll.
  - title: Catch up
    text: What merged since your checkpoint, by day, with a reader for each pull request.
  - title: Branches and Clean up
    text: Every branch and worktree, which ones would conflict, and a bulk clean-up you can undo.
changes:
  - { kind: Added, text: "A live commit graph that streams your whole history, with no commit cap" }
  - { kind: Added, text: "Unlimited undo and redo for every ref change, discard, hard reset and stash" }
  - { kind: Added, text: "An undo timeline that previews a restore before you make it" }
  - { kind: Added, text: "Undo a conflicted rebase in one step" }
  - { kind: Added, text: "Split a commit into several" }
  - { kind: Added, text: "A built-in three-way merge conflict editor" }
  - { kind: Added, text: "File history and blame on ⌘⇧H" }
  - { kind: Added, text: "Stash selected files, staged changes or single lines" }
  - { kind: Added, text: "Stage selected lines with ↵, or drag files to stage them" }
  - { kind: Added, text: "Worktrees, plus submodule status, update and open" }
  - { kind: Added, text: "Git LFS detection and status" }
  - { kind: Added, text: "Open files in your own diff and merge tools" }
  - { kind: Added, text: "Write commit messages with your own AI tool, if you turn it on" }
  - { kind: Added, text: "A warning before you commit with the wrong identity" }
  - { kind: Added, text: "GPG and SSH commit signing, with passphrase prompts" }
  - { kind: Added, text: "GitHub pull requests in the graph and sidebar: create, check out, approve, merge and close" }
  - { kind: Added, text: "Review: Needs you, Stuck and Ready, with failing checks and conflicts on each row" }
  - { kind: Added, text: "Fix a stuck pull request, or send it back with a ready-made prompt" }
  - { kind: Added, text: "Merge every ready pull request in a conflict-free order" }
  - { kind: Added, text: "Catch up on what merged since your checkpoint, on any branch" }
  - { kind: Added, text: "Branches on ⌘3, with a conflict forecast and Clean up as its Finished tab" }
  - { kind: Added, text: "Review a whole branch, ticking files off as you go" }
  - { kind: Added, text: "A searchable shortcuts window on ⌘/, and rebind any shortcut" }
  - { kind: Added, text: "Back and forward with ⌘[ and ⌘]" }
  - { kind: Added, text: "Switch to a recent repository from ⌘K or the File menu" }
  - { kind: Added, text: "Switch branches from the branch pill in the header" }
  - { kind: Added, text: "Copy a link to the selected commit with ⌘⇧C" }
  - { kind: Added, text: "Toggle the sidebar with ⌘S" }
  - { kind: Added, text: "Colour swatches next to colour codes in diffs" }
  - { kind: Added, text: "Co-author avatars in the graph" }
  - { kind: Added, text: "Automatic updates, with Check for Updates in the app menu and ⌘K" }
  - { kind: Added, text: "A welcome screen with an undo playground, and a choice of features on first launch" }
  - { kind: Added, text: "An orange look in light and dark; follow the system or pick one with ⌃⌘T" }
  - { kind: Improved, text: "Agents and bots show as authors next to the person who ran them" }
  - { kind: Improved, text: "Commit messages and pull request descriptions render as formatted text" }
  - { kind: Improved, text: "The sidebar folds into an icon rail on narrow windows" }
  - { kind: Improved, text: "Select several files, or drag across lines in a diff" }
  - { kind: Improved, text: "Arrow keys move through every list" }
  - { kind: Improved, text: "Large commits show a loading indicator instead of a blank pane" }
  - { kind: Fixed, text: "A locked SSH signing key fails right away instead of hanging" }
  - { kind: Fixed, text: "Remote credentials never show in the sidebar" }
  - { kind: Fixed, text: "Stashing a single file works for untracked and renamed files" }
  - { kind: Fixed, text: "No more colour swatches on Markdown anchors and hex-like words" }
  - { kind: Fixed, text: "Review no longer keeps loading pull requests forever" }
---
The first build we're sharing. Alongside the live commit graph and undo for everything, it adds three views for keeping up with a busy repository: Review for open pull requests, Catch up for what merged while you were away, and Branches for every branch and worktree, with a clean-up that ⌘Z can take back.
