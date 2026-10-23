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
- Navigating from an older entry inserts the new entry after it and retains the
  existing forward branch.
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

The Navigation API exposes only the contiguous entries allowed by its origin
and ancestor-document checks. Same-document history mutations update the local
list immediately; native joint-history changes are reconciled when the parent
process acknowledges the mutation.

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
