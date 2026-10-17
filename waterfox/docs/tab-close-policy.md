# Closing tabs without restoring unloaded neighbours

## Behaviour

Closing a tab must not restore an unloaded tab as a side effect. The
successor finder (`_findTabToBlurTo`) skips tabs that are unloaded (no
`linkedPanel`), closing, or closed as part of a multiselection, for every
caller: the close handoff, the prewarming before a close, explicit unloading
and successor selection. Among the remaining loaded tabs the existing
priorities (explicit successor, owner, tree, position) are unchanged.
Selecting an unloaded tab on purpose still restores it.

Pinned tabs sit apart from the rest: leaving an unpinned tab never selects a
pinned tab by position, through the tree or the strip order. A pinned explicit
successor or owner still counts.

When no loaded tab remains, the close handoff uses the same fallback as
explicit unloading: Firefox View when its tab is open or its button is
visible, otherwise a new tab. No fallback is created when the closing tab is
not selected or when nothing would survive the close. Closing the last tab or
a whole tree keeps the `browser.tabs.closeWindowWithLastTab` behaviour,
because the tree close set is passed into the handoff.

## Implementation decisions

| Choice | Reason |
| --- | --- |
| Test `linkedPanel`, not the `discarded` attribute | Covers explicitly unloaded tabs and lazy session tabs alike. |
| Exclude inside the finder | Filtering only adjacency would miss unloaded explicit successors, owners and tree candidates; one place serves every caller. |
| Reuse explicit unloading's fallback | One fallback for both operations. The new-tab page replaces the inert `about:blank` used by an earlier version of this change. |
| Pass the tree close set | Distinguishes unloaded survivors from descendants about to close without duplicating close-policy rules. |
| Leave pinned tabs out of the positional search | Pinned tabs are always loaded, so with unloaded neighbours the search otherwise ends at the top of the strip, far from the tab being closed. |
| Keep prewarming side-effect free | Prewarming may run before a close is permitted; only the handoff selects or opens a tab. |

An unloaded successor nominated by an extension is skipped on close as well;
this is a deliberate consequence of the no-restoration rule.

## Verification

The regression cases live in
`browser/components/tabbrowser/test/browser/tabs/browser_tabSuccessors.js`
and
`waterfox/browser/components/tabbrowser/test/browser/browser_tree_tabs_basic.js`.

The original Marionette check used an isolated Waterfox 6.7.4 Linux release,
first unchanged and then with the candidate `tabbrowser.js` substituted:
https://github.com/skrblk/waterfox/actions/runs/36662579610. Its workflow and
scripts are on `investigation/tab-handoff-2026-09-30`.

On 2026-10-17, the same approach against the official Waterfox 6.7.6 Linux
release with the current fork modules passed all five successor tasks
(49 assertions), plus the tree close-handoff, whole-tree window-policy and
pinned-tab cases. These use a reduced browser-chrome adapter. The complete
basic-tree file subsequently passed all 13 tasks and 58 assertions after
the adapter's document-load and missing-helper support was corrected.
The adapter uses top-level document polling rather than the full native
mochitest load-event contract. A full `mach` test run, a source build,
Windows and macOS remain outside this verification.
