# Closing tabs without restoring unloaded neighbors

## Behavior

Closing a tab must not implicitly restore an unloaded successor. Among eligible
loaded tabs, the existing successor, owner, tree and positional priorities are
unchanged. Explicitly selecting an unloaded tab still restores it.

If unloaded tabs survive but no loaded successor is eligible, closing creates
one inert `about:blank` tab in the same window and container. It is placed after
the closing tab's native group or outer tree and detached from automatic
attachment/grouping. This preserves the surviving tree rather than inserting a
new root into its middle; it does not promise an immediately adjacent screen
row or an unchanged sidebar viewport.

Tabs scheduled to close are not survivors. Closing the last tab or the entire
remaining tree retains the existing `browser.tabs.closeWindowWithLastTab`
behavior. A fallback is never created just to keep an otherwise empty window
alive, or during speculative prewarming before a close is permitted.

## Implementation decisions

These are implementation choices for this correction, not additional preferences
selected by a user:

| Choice | Reason and alternative |
| --- | --- |
| Test `linkedPanel`, not the `discarded` styling attribute | Protect both explicitly unloaded tabs and lazy session/new tabs. A manual-only policy would leave another restoration path open. |
| Filter before every successor priority | Filtering adjacency alone misses unloaded explicit successors, owners and tree candidates. |
| Keep prediction side-effect-free | Both close prewarming sites can run before the operation is permitted. Only the actual handoff may create the fallback. |
| Reuse the existing tree close set | Distinguish unloaded survivors from descendants that are about to close, without duplicating close-policy rules. |
| Use `about:blank` rather than the configured New Tab page | Avoid replacing accidental restoration with a page that can perform additional work. |
| Keep non-close callers' default policy | Explicit unloading already supplies its own exclusions; ordinary deliberate selection is not intercepted. |

An unloaded successor explicitly nominated by an extension is also skipped on
close. Loaded successor precedence remains unchanged. This is a deliberate
compatibility tradeoff of the no-implicit-restoration rule, not a new global
restriction on selecting unloaded tabs.

No application version, preference default, session format or release workflow
is changed. The tab-alignment and other interaction proposals are separate.

## Verification

Baseline: Waterfox 6.7.4, source commit
`b5e33a99f3e4ca206a187076db39944ab98499fd`, Linux build `20260921193338`.

[Native verification run](https://github.com/skrblk/waterfox/actions/runs/36522820972)
used an isolated stock Linux release and then the same release with the exact
candidate `tabbrowser.js` substituted in its browser archive. The packaged
baseline JavaScript matched the pinned source byte-for-byte. Test-framework
helpers were adapted through Marionette; the tabbrowser, tree service, window
handling and browser insertion were the real browser implementation.

The 41 cases produced 108 failed assertions on stock and zero failures in 455
assertions after the correction, with no harness errors. Coverage includes
horizontal, vertical and tree tabs; both unloaded neighbors; owner and explicit
successor overrides; bulk closes; all-survivors-unloaded; cancellation; pinned
and lazy tabs; collapsed groups; split panes; adoption into another window;
private windows; five tree close policies; repeated fallback closing; and
last-tab/whole-tree window policies. Cancellation injects a negative
`permitUnload` response; it is not a native-dialog automation test.

The new browser-chrome test is registered in the ordinary tabs manifest:

```sh
./mach test browser/components/tabbrowser/test/browser/tabs/browser_close_unloaded_tabs.js
```

That command and the full browser-chrome suite were not run in this environment.
Native release execution, eight source-method regression checks, two additional
close-boundary checks, JavaScript syntax checks and pinned Prettier checks were
run. A full source build, repository ESLint, Windows/macOS and an interactive
Niri/multiple-monitor run remain unverified. The source commit does not update
an installed browser or publish a release.
