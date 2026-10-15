# Waterfox

```
this is an idea made concrete using AI in service of my self-replicating rabbit holes
-> do not interpret it as meticulously engineered production software
                                                                 (or do so at your own peril)
                                  ⟢ concept ⟣
                                               is basically the entire point.
```

Waterfox is a customisable browser based on Mozilla Firefox. This repository contains Mozilla platform code, Waterfox product code, branding, features, packaging, and release files.

## Changes in this fork

- **Closing a tab does not restore unloaded tabs.** When the selected tab
  closes, the next tab is chosen among loaded tabs only. When none is left,
  Firefox View or a new tab opens, as explicit unloading already did. Details:
  [waterfox/docs/tab-close-policy.md](waterfox/docs/tab-close-policy.md).
- **Tree tabs line up by level.** The disclosure chevron sits in the row's
  start padding instead of a reserved content slot, so a root tab no longer
  moves when it gains or loses children, and parents line up with leaves of
  the same level.

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
