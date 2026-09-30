# Waterfox

Waterfox is a customisable browser based on Mozilla Firefox. This repository contains Mozilla platform code, Waterfox product code, branding, features, packaging, and release files.

## Changes in this fork

- **Closing a tab does not restore unloaded tabs.** When the selected tab
  closes, the next tab is chosen among loaded tabs only. When none is left,
  Firefox View or a new tab opens, as explicit unloading already did. Details:
  [waterfox/docs/tab-close-policy.md](waterfox/docs/tab-close-policy.md).

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
