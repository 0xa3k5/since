---
title: Next beta
order: 2
released: false
headline: Preferences, remotes and a simpler sidebar.
soft: Plus a round of pull request fixes.
highlights:
  - title: Preferences on ⌘,
    text: Every setting in one searchable window, grouped, with your git config alongside.
  - title: Remotes, in the app
    text: Add, edit, rename and remove remotes, and pick which one pull requests use.
  - title: One sidebar tree
    text: Activities on top, then your refs. Hide sections you don't use, or long-press to reorder.
changes:
  - { kind: Added, text: "A searchable preferences window on ⌘," }
  - { kind: Added, text: "Add, edit, rename and remove remotes" }
  - { kind: Added, text: "Choose which remote the pull request features use" }
  - { kind: Added, text: "Update a stuck pull request's branch on GitHub, right from Review" }
  - { kind: Added, text: "Check out a pull request here from the Review inbox" }
  - { kind: Added, text: "Offer to stash your changes when they block a branch switch" }
  - { kind: Added, text: "Choose what a double-click on a Map row checks out" }
  - { kind: Added, text: "Press ↵ to apply the selected stash" }
  - { kind: Added, text: "Resize the sidebar, file list and stashes list by dragging" }
  - { kind: Added, text: "Hide and reorder sidebar sections; long-press to drag" }
  - { kind: Improved, text: "The sidebar is one tree, with activities on top of your refs" }
  - { kind: Improved, text: "The app uses plain git words everywhere: branches, worktrees, pull requests" }
  - { kind: Improved, text: "A calmer toast after stashing" }
  - { kind: Improved, text: "Preferences rows are grouped, and the git config list is easier to scan" }
  - { kind: Improved, text: "Branches and Clean up follow-ups: clearer labels and states" }
  - { kind: Improved, text: "Small spacing and layout fixes across the app" }
  - { kind: Fixed, text: "Huge patches no longer crash the app" }
  - { kind: Fixed, text: "Double-clicking a Map row checks it out every time" }
  - { kind: Fixed, text: "Pull request actions use the right remote, including one named “auto”" }
  - { kind: Fixed, text: "Pull request status and checkout are more reliable" }
---
This build adds a preferences window, lets you manage remotes without the terminal, and folds the sidebar into one tree you can arrange the way you like. Pull request actions now work with any remote, and very large patches no longer take the app down.
