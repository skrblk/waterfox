# Waterfox

```
Browsers are not my area of expertise. This is a bunch of modifications and bugfix attempts.
-> do not interpret this fork as meticulously engineered production software
                                                                 (or do so at your own peril)
```

Waterfox is a customisable browser based on Mozilla Firefox. This repository contains Mozilla platform code, Waterfox product code, branding, features, packaging, and release files.

## Changes in this fork

This repository is Waterfox with a few changes on top of the newest upstream
release. [Releases](https://github.com/skrblk/waterfox/releases) of this fork are
named after the upstream release they are built on plus a letter, and carry the
changes as a patch series.

- **Closing a tab does not restore unloaded tabs.** When the selected tab
  closes, the next tab is chosen among loaded tabs only. When none is left,
  Firefox View or a new tab opens, as explicit unloading already did. A pinned
  tab is never chosen by position when an unpinned tab closes. Details:
  [waterfox/docs/tab-close-policy.md](waterfox/docs/tab-close-policy.md).
- **Tree tabs line up by level.** The disclosure chevron sits in the row's
  start padding instead of a reserved content slot, so a root tab no longer
  moves when it gains or loses children, and parents line up with leaves of
  the same level.
- **Emptied group tabs close after a window restore.** With
  `browser.tabs.verticalTabs.tree.closeParentBehavior` set to 4, a closed
  parent is replaced by a group tab, and the group tab closes once it holds
  one child or none. While a window was restoring (up to ten seconds after it
  opens or is restored) that cleanup was skipped and its request dropped, so
  group tabs emptied in that time, by a bulk close for example, stayed, nested
  ones included, until something else rescanned all group tabs: a tab
  finishing its restore, such as an unloaded tab being selected, or tree tabs
  being turned on. The request is now kept and run once the restore ends.

- **Tree exports preserve pending addresses.** Bookmarking a tree and copying
  its links use the pending session address, including a replaced pending
  state, without loading the tabs.
- **Nested group cleanup preserves promoted children.** Redundant temporary
  groups are removed deepest-first, and their parents count the children
  that remain. Cleanup follows temporary child groups without entering
  unrelated permanent groups.
- **Middle-clicking the tree disclosure keeps the tab open.** Primary clicks
  still collapse or expand the tree, and middle-clicking the ordinary row
  still closes the tab.
- **Tree edits made during the restore guard are saved afterward.** Once all
  restore blockers clear, both window structure and per-tab metadata catch
  up. An unresolved saved snapshot remains protected.
- **Pinned-opener groups retain their position.** Opening related tabs after
  switching tabs appends them after the existing subtree.
- **Group replacements preserve their tree and strip position.** Root groups
  replace the original root slot after pinned tabs. Subgroups preserve
  their first member's slot unless an explicit position is supplied.
- **Automatic group cleanup leaves undo history alone.** Removing redundant
  temporary groups does not add closed-tab entries. Deliberate group
  closes remain undoable.
- **The disclosure context menu opens on its first use.** Right-clicking
  a tree disclosure opens that tab's native context menu before any row
  context menu has been opened, and after the sidebar target is reset.
- **Restore transitions retain catch-up bookkeeping.** Stale saves are
  canceled before manual restoration, and a queued save blocked by a
  closed-tree restore retains its dirty marker. These are defensive
  safeguards; production save loss from those interleavings was not
  reproduced.
- **Creating a group leaves a selected folded group collapsed.** Internal
  chrome pages are excluded from same-site auto-attachment, so a new
  group is not briefly attached under the selected group.
- **Initial requests identify pending tabs without accepting drafts.** New
  group tabs are recognized before their documents load. Tree bookmarks
  and copied links retain an uncommitted first navigation through
  immediate discard, while unsubmitted address-bar drafts do not replace
  the page or pending navigation address.
- **Navigation keeps earlier history.** Redirect hops, replacement navigations
  and state replacements retain their previous entries. New branches keep
  existing forward history. The per-tab cap is one billion entries, and saved
  sessions retain all Back and Forward entries. Details and native regression
  checks: [tools/history-preservation](tools/history-preservation/README.md).
- **Back and Forward retain separate branches.** Navigating from an earlier
  entry creates another continuation without joining or deleting its siblings.
  Back follows the parent; Forward follows the last selected continuation.
  The Back/Forward history menu exposes an expandable tree, with native entry
  restoration and branch duplication into another tab. Relationships survive
  session restoration. Details: [history tree](tools/history-preservation/README.md#branching-history).

## Building

Waterfox uses the Mozilla build system. The usual `./mach` entry points apply:

```sh
./mach bootstrap
./mach build
./mach package
./mach test --auto
```

## Contributing

Most Firefox development documentation still applies to this tree. Use the Firefox Source Docs for the shared Mozilla build system, testing tools, and platform code.

## Resources

- [Waterfox website](https://www.waterfox.net/)
- [Firefox Source Docs](https://firefox-source-docs.mozilla.org/)
