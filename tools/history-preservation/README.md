# Navigation history preservation

Waterfox enables `browser.sessionhistory.preserve_entries` by default. Content
navigation continues while the browser retains earlier navigation entries:

- HTTP redirect chains retain each address, including the request data needed
  to revisit a POST address during the live session.
- `location.replace()`, early script redirects, refresh redirects and explicit
  Navigation API replacements add entries.
- `history.replaceState()` and `navigation.updateCurrentEntry()` retain the
  previous serialized state as an additional entry, including repeated updates
  at the same address.
- Navigating from an older entry creates another child and retains the existing
  forward branch separately.
- Cache eviction and frame removal retain serialized frame history.

The default per-tab cap, `browser.sessionhistory.max_entries`, is 1,000,000,000.
`browser.sessionstore.max_serialize_back` and
`browser.sessionstore.max_serialize_forward` are both `-1`, retaining all entries
when saving a session. `browser.navigation.requireUserInteraction` is `false`,
so Back does not skip entries merely because a page had no interaction.

These defaults can be overridden in `about:config`. Setting
`browser.sessionhistory.preserve_entries` to `false` restores upstream
replacement, branching and frame-history cleanup behavior; the other retention
preferences are independent.

## Branching history

Waterfox also enables `browser.sessionhistory.tree_enabled` by default. After
visiting A, B and C, going Back to B and navigating to D retains this structure:

```text
A
└─ B
   ├─ C
   └─ D ← current
```

Back from D returns to B. Forward from B returns to D, the last selected child.
Selecting C changes B's Forward continuation to C. Each continuation retains
its own descendants. A new branch ends at its own leaf; another branch is never
treated as that leaf's Forward destination. Repeated addresses, distinct saved
states and iframe-only steps remain separate history nodes.

Open the existing Back/Forward history menu to select another branch. Disclosure
arrows expand or collapse descendants. Up/Down and Home/End move the selection;
Left/Right collapse, expand or move between parent and child; Enter or Space
visits the selected entry. Middle-click or Ctrl-click (Command-click on macOS)
duplicates the selected entry and complete saved tree into another tab. The
original tab remains on its current branch. This uses ordinary tab duplication,
including its container/private context and serialized-state limits; live POST
streams are available in the original session but are not copied to the new tab.

Entries are restored through native session history, rather than by loading a
list of URLs. Branch choices take effect when traversal commits; canceled
navigation leaves the selected path unchanged. The picker virtualizes its rows
and shows the numerical depth when indentation reaches its visual limit.

Websites see the selected ordered path through `history.length`, relative
`history.go()` and Back/Forward availability. The Navigation API applies its
ordinary origin and ancestor-document filtering to that path. Other branches
remain available through the browser's history picker.

The session format saves node identities, parents and selected children beside
the existing entries. Older sessions without those relationships are imported
as a line: their addresses and states survive, but lost fork points cannot be
reconstructed reliably. Invalid relationship metadata also falls back to a line.
Turning only `tree_enabled` off retains the earlier preservation behavior, where
new entries are inserted before the retained forward entries in a single list.

The entry cap applies to the whole retained tree. Purging old entries can leave
several roots; surviving siblings are not joined to one another. Explicit finite
serialization limits count Back steps to a common ancestor and Forward steps
down each branch. Entries beyond either bound are omitted from the saved
session. The default `-1` limits retain every branch, including disconnected
roots. Explicit clearing still removes the other retained entries.

## Behavior and boundaries

Sites can observe additional entries, state-change events and different Back
and Forward availability. A redirect address that still redirects will redirect
again when revisited. An address remains available after its redirect is
removed, subject to the browser's ordinary HTTP cache behavior.

History entries retain addresses, serialized state and the browser's existing
restoration data. Ordinary document-cache limits remain in place. This feature
does not record arbitrary DOM or JavaScript mutations, reconstruct script-created
frame DOM after eviction, or guarantee that a server will return an earlier
version of a page. History storage and restoration costs grow with retained
entries. Explicit history deletion and private-browsing persistence boundaries
continue to apply.

Static frames retain their restoration positions when dynamic siblings move or
disappear. Ambiguous frame records from older sessions remain stored rather than
being applied to another frame. Submitted POST bodies remain in memory; the
session format does not save those bodies across browser restarts.

Clearing history keeps the displayed page and removes the other retained steps.
Redirect addresses captured before a clear are discarded. A navigation that
finishes afterward records its completed destination as a new step.

Same-document history mutations update the site's selected list immediately;
native joint-history changes are reconciled when the parent process acknowledges
the mutation.

## Native regression checks

`test_history.py` launches a native browser in an isolated temporary profile,
serves local HTTP and HTTPS test pages, and uses `marionette_driver` to inspect
and traverse its actual session history. It checks redirects, live POST replay, replacement state,
refreshes, branching, iframe history, origin boundaries, retention limits,
session restoration and the disabled-policy control. OpenSSL generates a
temporary localhost certificate for the isolated HTTPS-upgrade test.

```sh
python test_history.py --binary /path/to/waterfox --out /path/to/results
```

Use `--case test_method_name` to select a case. Results are written to
`results.json`, with the native browser log in `gecko.log`.

Tree-specific cases enable the tree explicitly. The older preservation cases
exercise the linear compatibility mode by default; `--tree` enables the tree for
those cases too. Tests that assert the older linear branch ordering have separate
tree counterparts. Pure graph validation, remapping and session-writer checks
run without a browser:

```sh
node --test tools/history-preservation/test_history_tree.mjs
```
