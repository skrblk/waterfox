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

add_task(async function test_tree_exports_use_uncommitted_browser_typed_target() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.verticalTabs.tree.enabled", true],
      ["browser.tabs.verticalTabs.tree.autoAttach", 0],
    ],
  });
  let tab;
  try {
    tab = gBrowser.addTrustedTab("https://example.com/uncommitted-load", {
      skipAnimation: true,
    });
    is(
      tab.linkedBrowser.currentURI.spec,
      "about:blank",
      "The newly opened tab has not committed its initial navigation yet"
    );
    is(
      tab.linkedBrowser.userTypedValue,
      "https://example.com/uncommitted-load",
      "The target URL is held in browser.userTypedValue while uncommitted"
    );
    const [bookmark] = LazyURLBookmarks.encodeTabs([tab]);
    is(
      bookmark.url,
      "https://example.com/uncommitted-load",
      "Bookmark This Tree preserves the uncommitted target URL"
    );
    const copied = captureTreeLinkExport(tab);
    is(
      copied["text/plain"],
      "* https://example.com/uncommitted-load",
      "The plain tree export preserves the uncommitted target URL"
    );
    ok(
      copied["text/html"].includes(
        'href="https://example.com/uncommitted-load"'
      ),
      "The HTML tree export preserves the uncommitted target URL"
    );
  } finally {
    if (tab?.isConnected) {
      await BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_tree_exports_ignore_unsent_blank_tab_drafts() {
  const tab = gBrowser.addTrustedTab("about:blank", { skipAnimation: true });
  try {
    for (const draft of ["https://example.com/unsent", "unsubmitted search words"]) {
      tab.linkedBrowser.userTypedValue = draft;
      const [bookmark] = LazyURLBookmarks.encodeTabs([tab]);
      is(bookmark.url, "about:blank", "A draft does not replace the blank page URL");
      is(
        captureTreeLinkExport(tab)["text/plain"],
        "* about:blank",
        "Copy This Tree exports the page rather than the unsent draft"
      );
    }
  } finally {
    await BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_tree_exports_preserve_pending_navigation_after_edit() {
  const tab = gBrowser.addTrustedTab("https://example.com/pending-export", {
    skipAnimation: true,
  });
  try {
    is(tab.linkedBrowser.currentURI.spec, "about:blank", "The navigation is uncommitted");
    tab.linkedBrowser.userTypedValue = "unsubmitted replacement search";
    const [bookmark] = LazyURLBookmarks.encodeTabs([tab]);
    is(bookmark.url, "https://example.com/pending-export", "The submitted target survives a later draft");
    is(
      captureTreeLinkExport(tab)["text/plain"],
      "* https://example.com/pending-export",
      "Copy This Tree keeps the pending navigation target"
    );
  } finally {
    await BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_tree_exports_ignore_restored_unsent_blank_tab_draft() {
  await withLazyURLTab(tab => {
    LazyURLSessionStore.setTabState(tab, {
      entries: [{ url: "about:blank", title: "Blank page" }],
      index: 1,
      userTypedValue: "unsubmitted restored search",
      userTypedClear: 0,
    });
    delete tab.linkedBrowser._cachedCurrentURI;
    assertLazyTreeExports(tab, "about:blank", "Blank page");
  });
});

add_task(async function test_tree_exports_preserve_initial_target_across_discard() {
  for (const [url, draft, expected] of [
    ["https://example.com/discard-target", null, "https://example.com/discard-target"],
    ["https://example.com/discard-target", "unsent replacement", "https://example.com/discard-target"],
    ["about:blank", "unsent search", "about:blank"],
  ]) {
    const tab = gBrowser.addTrustedTab(url, { skipAnimation: true });
    try {
      if (draft) {
        tab.linkedBrowser.userTypedValue = draft;
      }
      ok(gBrowser.discardBrowser(tab, true), "The real browser is discarded");
      const [bookmark] = LazyURLBookmarks.encodeTabs([tab]);
      is(bookmark.url, expected, "Discard preserves the requested page, excluding drafts");
      is(captureTreeLinkExport(tab)["text/plain"], `* ${expected}`, "Copy keeps the same requested page");
      ok(!tab.linkedPanel, "Export leaves the discarded browser unloaded");
    } finally {
      await BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(async function test_tree_exports_ignore_canceled_target_after_blank_commit() {
  const tab = gBrowser.addTrustedTab("https://example.com/canceled-export", {
    skipAnimation: true,
  });
  try {
    const browser = tab.linkedBrowser;
    browser.stop();
    browser.loadURI(Services.io.newURI("about:blank"), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    await TestUtils.waitForCondition(
      () => browser.browsingContext.sessionHistory.count > 0 && !browser.webProgress.isLoadingDocument,
      "The new blank navigation commits"
    );
    const [bookmark] = LazyURLBookmarks.encodeTabs([tab]);
    is(bookmark.url, "about:blank", "A canceled target cannot override the committed blank page");
    is(captureTreeLinkExport(tab)["text/plain"], "* about:blank", "Copy excludes the canceled target");
  } finally {
    await BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_replaced_lazy_state_drops_previous_initial_target() {
  const tab = gBrowser.addTrustedTab("https://example.com/replaced-discard", {
    skipAnimation: true,
  });
  try {
    ok(gBrowser.discardBrowser(tab, true), "The initial target is discarded");
    LazyURLSessionStore.setTabState(tab, {
      entries: [{ url: "about:blank", title: "Replacement blank" }],
      index: 1,
      userTypedValue: "replacement draft",
      userTypedClear: 0,
    });
    delete tab.linkedBrowser._cachedCurrentURI;
    assertLazyTreeExports(tab, "about:blank", "Replacement blank");
  } finally {
    await BrowserTestUtils.removeTab(tab);
  }
});
