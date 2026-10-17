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
  group tabs emptied in that time, by a bulk close for example, stayed for
  good, nested ones included. The request is now kept and run once the
  restore ends.

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
