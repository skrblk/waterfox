/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { SessionStore: LazyURLSessionStore } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/SessionStore.sys.mjs"
);
const { TreeTabsBookmarks: LazyURLBookmarks } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsBookmarks.sys.mjs"
);
const { TreeTabsUI: LazyURLTreeUI } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsUI.sys.mjs"
);

function lazyURLState(url, title, userTypedValue = null) {
  return {
    entries: [{ url, title }],
    index: 1,
    ...(userTypedValue ? { userTypedValue, userTypedClear: 1 } : {}),
  };
}

function captureTreeLinkExport(tab) {
  const descriptor = Object.getOwnPropertyDescriptor(Services, "clipboard");
  const exported = {};
  const sink = {
    kGlobalClipboard: Ci.nsIClipboard.kGlobalClipboard,
    setData(transferable) {
      for (const flavor of ["text/plain", "text/html"]) {
        const data = {};
        transferable.getTransferData(flavor, data);
        exported[flavor] = data.value.QueryInterface(Ci.nsISupportsString).data;
      }
    },
  };
  try {
    Object.defineProperty(Services, "clipboard", {
      configurable: true,
      value: sink,
    });
    if (Services.clipboard !== sink) {
      throw new Error("The clipboard write must be intercepted");
    }
    LazyURLTreeUI.onWindowOpened(window);
    LazyURLTreeUI._controllers.get(window)._copyTreeAsLinks([tab]);
    return exported;
  } finally {
    if (descriptor) {
      Object.defineProperty(Services, "clipboard", descriptor);
    } else {
      delete Services.clipboard;
    }
  }
}

function assertLazyTreeExports(tab, url, title) {
  const [bookmark] = LazyURLBookmarks.encodeTabs([tab]);
  is(bookmark.url, url, "Bookmark This Tree preserves the intended URL");
  is(bookmark.title, title, "Bookmark This Tree preserves the current title");
  const copied = captureTreeLinkExport(tab);
  is(copied["text/plain"], `* ${url}`, "The plain tree export keeps the URL");
  ok(
    copied["text/html"].includes(`href="${url}"`),
    "The HTML tree export keeps the URL"
  );
  ok(!tab.linkedPanel, "Exporting the tree does not load the pending tab");
}

async function withLazyURLTab(task) {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.verticalTabs.tree.enabled", true],
      ["browser.tabs.verticalTabs.tree.autoAttach", 0],
    ],
  });
  let tab;
  try {
    tab = gBrowser.addTrustedTab("https://example.com/lazy-export-initial", {
      createLazyBrowser: true,
      skipAnimation: true,
    });
    ok(!tab.linkedPanel, "The fixture starts with a real pending browser");
    await task(tab);
  } finally {
    if (tab?.isConnected) {
      await BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function test_tree_exports_preserve_ordinary_pending_url() {
  await withLazyURLTab(tab => {
    LazyURLSessionStore.setTabState(
      tab,
      lazyURLState("https://example.com/pending-page", "Pending page")
    );
    delete tab.linkedBrowser._cachedCurrentURI;
    assertLazyTreeExports(tab, "https://example.com/pending-page", "Pending page");
  });
});

add_task(async function test_tree_exports_use_uncommitted_pending_target() {
  await withLazyURLTab(tab => {
    LazyURLSessionStore.setTabState(
      tab,
      lazyURLState(
        "about:blank",
        "Unvisited bookmark",
        "https://example.com/unvisited-bookmark"
      )
    );
    delete tab.linkedBrowser._cachedCurrentURI;
    is(
      LazyURLSessionStore.getLazyTabValue(tab, "userTypedValue"),
      "https://example.com/unvisited-bookmark",
      "The pending target remains in the real session state"
    );
    assertLazyTreeExports(
      tab,
      "https://example.com/unvisited-bookmark",
      "Unvisited bookmark"
    );
  });
});

add_task(async function test_tree_exports_follow_replaced_pending_state() {
  await withLazyURLTab(tab => {
    LazyURLSessionStore.setTabState(
      tab,
      lazyURLState("https://example.com/old-page", "Old title")
    );
    delete tab.linkedBrowser._cachedCurrentURI;
    is(
      tab.linkedBrowser.currentURI.spec,
      "https://example.com/old-page",
      "Reading the initial address primes the lazy URI cache"
    );
    LazyURLSessionStore.setTabState(
      tab,
      lazyURLState("https://example.com/new-page", "New title")
    );
    is(
      LazyURLSessionStore.getLazyTabValue(tab, "url"),
      "https://example.com/new-page",
      "The real session state has the replacement address"
    );
    assertLazyTreeExports(tab, "https://example.com/new-page", "New title");
  });
});
