/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

requestLongerTimeout(4);

async function withCloseUnloadWindow(mode, task, options = {}) {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["sidebar.verticalTabs", mode != "horizontal"],
      ["browser.tabs.verticalTabs.tree.enabled", mode == "tree"],
      ["browser.tabs.verticalTabs.tree.autoAttach", 0],
      ["browser.tabs.verticalTabs.tree.closeParentBehavior", 1],
      ["browser.tabs.selectOwnerOnClose", true],
      ["browser.tabs.warnOnClose", false],
      ["browser.tabs.closeWindowWithLastTab", false],
      ["browser.tabs.autoGroupNewTabs", false],
    ],
  });
  const win = await BrowserTestUtils.openNewBrowserWindow(options);
  try {
    const gb = win.gBrowser;
    const tabs = [];
    for (let index = 0; index < 5; index++) {
      const tab = gb.addTrustedTab(
        `data:text/html,<title>close-unloaded-${index}</title>test`,
        {
          inBackground: true,
          skipAnimation: true,
          userContextId: options.private ? 0 : 1,
        }
      );
      await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
      tabs.push(tab);
    }
    const original = gb.tabs[0];
    await BrowserTestUtils.switchTab(gb, tabs[2]);
    await BrowserTestUtils.removeTab(original);
    await task(win, tabs);
  } finally {
    if (!win.closed) {
      await BrowserTestUtils.closeWindow(win);
    }
    await SpecialPowers.popPrefEnv();
  }
}

async function discardCloseTestTabs(win, tabs) {
  for (const tab of tabs) {
    await win.gBrowser.prepareDiscardBrowser(tab);
    ok(
      win.gBrowser.discardBrowser(tab, true),
      "The fixture discards a background tab"
    );
    ok(!tab.linkedPanel, "The discarded tab has no live panel");
  }
  let inserted = 0;
  const onInserted = event => {
    if (tabs.includes(event.target)) {
      inserted++;
    }
  };
  const tabContainer = win.gBrowser.tabContainer;
  tabContainer.addEventListener("TabBrowserInserted", onInserted);
  return () => {
    tabContainer.removeEventListener("TabBrowserInserted", onInserted);
    is(inserted, 0, "Automatic selection never restored an unloaded tab");
    for (const tab of tabs) {
      if (tab.isConnected) {
        ok(!tab.linkedPanel, "Surviving unloaded tab remains unloaded");
      }
    }
  };
}

for (const mode of ["horizontal", "vertical", "tree"]) {
  for (const operation of ["close", "unload"]) {
    for (const priority of ["adjacent", "owner", "successor"]) {
      add_task(async function automatic_selection_skips_unloaded_tabs() {
        info(`${mode}: ${operation}, ${priority}`);
        await withCloseUnloadWindow(mode, async (win, tabs) => {
          const gb = win.gBrowser;
          const [left, lazyLeft, current, lazyRight, right] = tabs;
          const verifyUnloaded = await discardCloseTestTabs(win, [
            lazyLeft,
            lazyRight,
          ]);
          try {
            if (priority == "owner") {
              current.owner = lazyLeft;
            } else if (priority == "successor") {
              gb.setSuccessor(current, lazyRight);
            }
            if (operation == "close") {
              await BrowserTestUtils.removeTab(current);
            } else {
              await gb.explicitUnloadTabs([current]);
              ok(!current.linkedPanel, "The requested tab is unloaded");
            }
            is(
              gb.selectedTab,
              right,
              "Selection skips the unloaded candidates"
            );
            ok(left.linkedPanel, "The other loaded candidate stays loaded");
            is(
              gb.tabs.length,
              operation == "close" ? 4 : 5,
              "A loaded successor needs no fallback"
            );
          } finally {
            verifyUnloaded();
          }
        });
      });
    }
  }

  add_task(async function close_with_only_unloaded_survivors() {
    await withCloseUnloadWindow(mode, async (win, tabs) => {
      const gb = win.gBrowser;
      const current = tabs[2];
      const sleeping = tabs.filter(tab => tab != current);
      const verifyUnloaded = await discardCloseTestTabs(win, sleeping);
      try {
        await BrowserTestUtils.removeTab(current);
        const fallback = gb.selectedTab;
        ok(!tabs.includes(fallback), "The fallback is a new tab");
        is(
          fallback.linkedBrowser.currentURI.spec,
          "about:blank",
          "Fallback is inert, not the configured new-tab page"
        );
        is(gb.tabs.length, 5, "Exactly one fallback replaces the closed tab");
        is(
          fallback.userContextId,
          current.userContextId,
          "The container identity is preserved"
        );
        ok(!fallback.group, "Fallback is not captured by a native group");
        is(
          gb.TreeTabsService.getParent(fallback),
          null,
          "Fallback is a tree root"
        );
      } finally {
        verifyUnloaded();
      }
    });
  });

  add_task(async function multiselect_close_does_not_wake_survivors() {
    await withCloseUnloadWindow(mode, async (win, tabs) => {
      const gb = win.gBrowser;
      const sleeping = [tabs[0], tabs[1], tabs[3]];
      const verifyUnloaded = await discardCloseTestTabs(win, sleeping);
      try {
        gb.removeTabs([tabs[2], tabs[4]], { animate: false });
        await BrowserTestUtils.waitForMutationCondition(
          gb.tabContainer,
          { childList: true, subtree: true },
          () => !tabs[2].isConnected && !tabs[4].isConnected
        );
        is(gb.tabs.length, 4, "A bulk close creates only one fallback");
        ok(
          !tabs.includes(gb.selectedTab),
          "Bulk close selects a fresh fallback"
        );
        is(
          gb.selectedBrowser.currentURI.spec,
          "about:blank",
          "Bulk fallback is blank"
        );
      } finally {
        verifyUnloaded();
      }
    });
  });
}

add_task(async function background_close_and_explicit_selection() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    const gb = win.gBrowser;
    const verifyUnloaded = await discardCloseTestTabs(win, [tabs[0], tabs[1]]);
    try {
      await BrowserTestUtils.removeTab(tabs[0]);
      is(
        gb.selectedTab,
        tabs[2],
        "Background closure does not change selection"
      );
      is(gb.tabs.length, 4, "Background closure creates no fallback");
    } finally {
      verifyUnloaded();
    }
    await BrowserTestUtils.switchTab(gb, tabs[1]);
    ok(
      tabs[1].linkedPanel,
      "Explicitly selecting an unloaded tab still restores it"
    );
  });
});

add_task(async function loaded_successor_precedence_is_preserved() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    tabs[2].owner = tabs[0];
    win.gBrowser.setSuccessor(tabs[2], tabs[4]);
    await BrowserTestUtils.removeTab(tabs[2]);
    is(
      win.gBrowser.selectedTab,
      tabs[4],
      "A loaded explicit successor still outranks the owner"
    );
  });
});

add_task(async function cancelled_close_does_not_create_or_restore_tabs() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    const gb = win.gBrowser;
    const current = tabs[2];
    const verifyUnloaded = await discardCloseTestTabs(
      win,
      tabs.filter(tab => tab != current)
    );
    const browser = current.linkedBrowser;
    const originalHasBeforeUnload = gb._hasBeforeUnload;
    const originalPermitUnload = browser.permitUnload;
    try {
      gb._hasBeforeUnload = tab => tab == current;
      browser.permitUnload = () => ({ permitUnload: false });
      gb.removeTab(current, { animate: false });
      ok(
        current.isConnected && !current.closing,
        "The negative permit response cancels closing"
      );
      is(gb.selectedTab, current, "Cancellation preserves selection");
      is(
        gb.tabs.length,
        5,
        "Prewarming does not create a blank tab before consent"
      );
    } finally {
      gb._hasBeforeUnload = originalHasBeforeUnload;
      browser.permitUnload = originalPermitUnload;
      verifyUnloaded();
    }
  });
});

for (const behavior of [0, 1, 2, 3, 4]) {
  add_task(async function tree_close_keeps_unloaded_children_asleep() {
    await withCloseUnloadWindow("tree", async (win, tabs) => {
      const gb = win.gBrowser;
      const tree = gb.TreeTabsService;
      tree.attachTab(tabs[3], tabs[2]);
      tree.attachTab(tabs[4], tabs[2]);
      Services.prefs.setIntPref(
        "browser.tabs.verticalTabs.tree.closeParentBehavior",
        behavior
      );
      const sleeping = tabs.filter(tab => tab != tabs[2]);
      const verifyUnloaded = await discardCloseTestTabs(win, sleeping);
      try {
        gb.removeTab(tabs[2], { animate: false, isUserTriggered: true });
        await TestUtils.waitForCondition(() => !tabs[2].isConnected);
        ok(
          !tabs.includes(gb.selectedTab),
          `Close policy ${behavior} does not select an unloaded child`
        );
        is(
          gb.selectedBrowser.currentURI.spec,
          "about:blank",
          "The selected fallback stays blank"
        );
        if (behavior == 2) {
          ok(
            !tabs[3].isConnected && !tabs[4].isConnected,
            "Close-tree still removes its descendants"
          );
        } else {
          ok(
            tabs[3].isConnected && tabs[4].isConnected,
            "The other close policies preserve descendants"
          );
        }
        is(
          tree.getParent(gb.selectedTab),
          null,
          "Closing a tree does not capture its fallback"
        );
      } finally {
        verifyUnloaded();
      }
    });
  });
}

add_task(async function fallback_respects_auto_attach_and_grouping() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    const gb = win.gBrowser;
    gb.addTabGroup([tabs[2], tabs[3]], { label: "Closing group" });
    gb.TreeTabsService.attachTab(tabs[3], tabs[2]);
    Services.prefs.setIntPref("browser.tabs.verticalTabs.tree.autoAttach", 2);
    Services.prefs.setBoolPref("browser.tabs.autoGroupNewTabs", true);
    const verifyUnloaded = await discardCloseTestTabs(
      win,
      tabs.filter(tab => tab != tabs[2])
    );
    try {
      await BrowserTestUtils.removeTab(tabs[2]);
      const fallback = gb.selectedTab;
      is(
        fallback.linkedBrowser.currentURI.spec,
        "about:blank",
        "The fallback remains blank with automatic grouping enabled"
      );
      ok(
        !fallback.group,
        "Automatic grouping cannot retain the fallback in the old group"
      );
      is(
        gb.TreeTabsService.getParent(fallback),
        null,
        "Automatic attachment cannot retain the fallback under a closing parent"
      );
      const roots = gb.TreeTabsService.getRootTabs(win);
      is(
        roots.indexOf(fallback),
        roots.filter(tab => tab._tPos < fallback._tPos).length,
        "Tree root order matches the native strip"
      );
    } finally {
      verifyUnloaded();
    }
  });
});

add_task(async function private_window_fallback_stays_private() {
  await withCloseUnloadWindow(
    "tree",
    async (win, tabs) => {
      const verifyUnloaded = await discardCloseTestTabs(
        win,
        tabs.filter(tab => tab != tabs[2])
      );
      try {
        await BrowserTestUtils.removeTab(tabs[2]);
        is(
          win.gBrowser.selectedBrowser.currentURI.spec,
          "about:blank",
          "Private fallback is blank"
        );
        ok(
          PrivateBrowsingUtils.isWindowPrivate(win),
          "Fallback stays in the same private window"
        );
      } finally {
        verifyUnloaded();
      }
    },
    { private: true }
  );
});

for (const closeWindow of [false, true]) {
  add_task(async function last_tab_keeps_existing_window_policy() {
    await withCloseUnloadWindow("tree", async (win, tabs) => {
      const gb = win.gBrowser;
      gb.removeTabs(
        tabs.filter(tab => tab != tabs[2]),
        { animate: false }
      );
      Services.prefs.setBoolPref(
        "browser.tabs.closeWindowWithLastTab",
        closeWindow
      );
      gb.removeTab(tabs[2], { animate: false });
      if (closeWindow) {
        await TestUtils.waitForCondition(() => win.closed);
        ok(win.closed, "Closing the last tab can still close its window");
      } else {
        is(
          gb.tabs.length,
          1,
          "Keeping the window open still supplies exactly one tab"
        );
        ok(!win.closed, "The keep-window-open preference is preserved");
      }
    });
  });
}

for (const mode of ["horizontal", "vertical", "tree"]) {
  add_task(async function loaded_tab_in_collapsed_group_is_eligible() {
    await withCloseUnloadWindow(mode, async (win, tabs) => {
      const gb = win.gBrowser;
      await BrowserTestUtils.removeTab(tabs[0]);
      const group = gb.addTabGroup([tabs[4]], { label: "Collapsed" });
      group.collapsed = true;
      const verifyUnloaded = await discardCloseTestTabs(win, [
        tabs[1],
        tabs[3],
      ]);
      try {
        await BrowserTestUtils.removeTab(tabs[2]);
        is(
          gb.selectedTab,
          tabs[4],
          "The loaded tab in a collapsed group is used before creating a fallback"
        );
        is(
          gb.tabs.length,
          3,
          "Selecting the hidden-group candidate creates no tab"
        );
      } finally {
        verifyUnloaded();
      }
    });
  });
}

add_task(async function pinned_close_skips_an_unloaded_pinned_neighbor() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    const gb = win.gBrowser;
    for (const tab of tabs.slice(2)) {
      gb.pinTab(tab);
    }
    const verifyUnloaded = await discardCloseTestTabs(win, [tabs[3]]);
    try {
      await BrowserTestUtils.removeTab(tabs[2]);
      is(
        gb.selectedTab,
        tabs[4],
        "Pinned succession skips an unloaded pinned tab"
      );
    } finally {
      verifyUnloaded();
    }
  });
});

add_task(
  async function never_loaded_tab_is_protected_without_discarded_attribute() {
    await withCloseUnloadWindow("tree", async (win, tabs) => {
      const gb = win.gBrowser;
      const lazyTab = gb.addTrustedTab("https://example.com/never-loaded", {
        createLazyBrowser: true,
        inBackground: true,
        skipAnimation: true,
        tabIndex: tabs[2]._tPos + 1,
      });
      ok(!lazyTab.linkedPanel, "The newly created tab is lazy");
      ok(
        !lazyTab.hasAttribute("discarded"),
        "No explicit-unload marker is needed"
      );
      let insertions = 0;
      const count = () => insertions++;
      lazyTab.addEventListener("TabBrowserInserted", count);
      try {
        gb.setSuccessor(tabs[2], lazyTab);
        await BrowserTestUtils.removeTab(tabs[2]);
        is(gb.selectedTab, tabs[3], "A lazy explicit successor is skipped");
        is(insertions, 0, "Closing does not materialize the never-loaded tab");
        ok(!lazyTab.linkedPanel, "The tab remains lazy");
      } finally {
        lazyTab.removeEventListener("TabBrowserInserted", count);
      }
    });
  }
);

add_task(async function repeated_fallback_closes_do_not_accumulate_tabs() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    const gb = win.gBrowser;
    const verifyUnloaded = await discardCloseTestTabs(
      win,
      tabs.filter(tab => tab != tabs[2])
    );
    try {
      for (let index = 0; index < 3; index++) {
        await BrowserTestUtils.removeTab(gb.selectedTab);
        is(
          gb.tabs.length,
          5,
          "Repeated closing keeps exactly one live fallback"
        );
        is(
          gb.selectedBrowser.currentURI.spec,
          "about:blank",
          "Repeated fallback remains inert"
        );
      }
    } finally {
      verifyUnloaded();
    }
  });
});

add_task(
  async function moving_the_active_tab_does_not_wake_source_window_tabs() {
    await withCloseUnloadWindow("tree", async (win, tabs) => {
      const gb = win.gBrowser;
      const verifyUnloaded = await discardCloseTestTabs(
        win,
        tabs.filter(tab => tab != tabs[2])
      );
      const destination = await BrowserTestUtils.openNewBrowserWindow();
      try {
        const adopted = destination.gBrowser.adoptTab(tabs[2]);
        ok(adopted, "The tab can still be adopted into another window");
        is(
          adopted.documentGlobal,
          destination,
          "The adopted tab belongs to its destination"
        );
        is(
          gb.selectedBrowser.currentURI.spec,
          "about:blank",
          "The source window supplies a blank fallback"
        );
        is(
          gb.tabs.length,
          5,
          "Adoption leaves one fallback in the source window"
        );
      } finally {
        verifyUnloaded();
        await BrowserTestUtils.closeWindow(destination);
      }
    });
  }
);

add_task(async function closing_a_split_pane_does_not_wake_other_tabs() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    const gb = win.gBrowser;
    gb.addTabSplitView([tabs[2], tabs[4]]);
    await BrowserTestUtils.switchTab(gb, tabs[2]);
    const verifyUnloaded = await discardCloseTestTabs(win, [
      tabs[0],
      tabs[1],
      tabs[3],
    ]);
    try {
      gb.removeTab(tabs[2], { animate: false, isUserTriggered: true });
      ok(
        tabs[4].isConnected,
        "The companion pane survives closing the active pane"
      );
      ok(
        ![tabs[0], tabs[1], tabs[3]].includes(gb.selectedTab),
        "Split-pane closure does not select an unloaded tab"
      );
    } finally {
      verifyUnloaded();
    }
  });
});

add_task(async function three_to_two_tabs_background_close_is_nonactivating() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    const gb = win.gBrowser;
    gb.removeTabs([tabs[0], tabs[4]], { animate: false });
    const verifyUnloaded = await discardCloseTestTabs(win, [tabs[1]]);
    try {
      await BrowserTestUtils.removeTab(tabs[3]);
      is(gb.tabs.length, 2, "Background close can reduce three tabs to two");
      is(gb.selectedTab, tabs[2], "The active tab is unchanged");
    } finally {
      verifyUnloaded();
    }
  });
});

add_task(async function loaded_owner_keeps_precedence_over_adjacency() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    tabs[2].owner = tabs[0];
    await BrowserTestUtils.removeTab(tabs[2]);
    is(
      win.gBrowser.selectedTab,
      tabs[0],
      "A loaded owner still wins over adjacent tabs"
    );
  });
});

add_task(
  async function loaded_tree_child_is_preferred_to_unloaded_first_child() {
    await withCloseUnloadWindow("tree", async (win, tabs) => {
      const gb = win.gBrowser;
      gb.TreeTabsService.attachTab(tabs[3], tabs[2]);
      gb.TreeTabsService.attachTab(tabs[4], tabs[2]);
      const verifyUnloaded = await discardCloseTestTabs(win, [tabs[3]]);
      try {
        await BrowserTestUtils.removeTab(tabs[2]);
        is(
          gb.selectedTab,
          tabs[4],
          "Tree succession searches past its unloaded first child"
        );
      } finally {
        verifyUnloaded();
      }
    });
  }
);

for (const closeWindow of [false, true]) {
  add_task(async function closing_the_whole_tree_keeps_window_policy() {
    await withCloseUnloadWindow("tree", async (win, tabs) => {
      const gb = win.gBrowser;
      const root = tabs[2];
      const descendants = tabs.filter(tab => tab != root);
      for (const tab of descendants) {
        gb.TreeTabsService.attachTab(tab, root);
      }
      Services.prefs.setIntPref(
        "browser.tabs.verticalTabs.tree.closeParentBehavior",
        2
      );
      Services.prefs.setBoolPref(
        "browser.tabs.closeWindowWithLastTab",
        closeWindow
      );
      const verifyUnloaded = await discardCloseTestTabs(win, descendants);
      try {
        gb.removeTab(root, { animate: false, isUserTriggered: true });
        if (closeWindow) {
          await TestUtils.waitForCondition(
            () => win.closed,
            "Closing the entire tree closes its window"
          );
          ok(
            win.closed,
            "A fallback does not keep an otherwise empty window alive"
          );
        } else {
          await BrowserTestUtils.waitForMutationCondition(
            gb.tabContainer,
            { childList: true, subtree: true },
            () => tabs.every(tab => !tab.isConnected)
          );
          is(
            gb.tabs.length,
            1,
            "Keeping an empty window open creates only its ordinary replacement tab"
          );
          ok(
            !tabs.includes(gb.selectedTab),
            "The replacement is not a restored member of the closed tree"
          );
        }
      } finally {
        verifyUnloaded();
      }
    });
  });
}

add_task(async function unload_excludes_its_entire_operation_set() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    const gb = win.gBrowser;
    const verifyUnloaded = await discardCloseTestTabs(win, [tabs[1], tabs[3]]);
    try {
      gb.setSuccessor(tabs[2], tabs[4]);
      await gb.explicitUnloadTabs([tabs[2], tabs[4]]);
      is(
        gb.selectedTab,
        tabs[0],
        "The loaded successor being unloaded is excluded"
      );
      ok(
        !tabs[2].linkedPanel && !tabs[4].linkedPanel,
        "Both requested tabs are unloaded"
      );
    } finally {
      verifyUnloaded();
    }
  });
});

add_task(async function unload_keeps_its_existing_new_tab_fallback() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    const gb = win.gBrowser;
    const verifyUnloaded = await discardCloseTestTabs(
      win,
      tabs.filter(tab => tab != tabs[2])
    );
    try {
      ok(
        !win.FirefoxViewHandler.tab,
        "The new window has no open Firefox View"
      );
      await gb.explicitUnloadTabs([tabs[2]]);
      is(
        gb.tabs.length,
        6,
        "Unloading retains the original tab and adds its fallback"
      );
      is(
        gb.selectedBrowser.currentURI.spec,
        win.BROWSER_NEW_TAB_URL,
        "Unload retains its configured new-tab destination"
      );
      ok(!tabs[2].linkedPanel, "The previous active tab stays unloaded");
    } finally {
      verifyUnloaded();
    }
  });
});

add_task(async function unload_does_not_select_the_other_split_pane() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    const gb = win.gBrowser;
    gb.addTabSplitView([tabs[2], tabs[4]]);
    await BrowserTestUtils.switchTab(gb, tabs[2]);
    const verifyUnloaded = await discardCloseTestTabs(win, [tabs[1], tabs[3]]);
    try {
      await gb.explicitUnloadTabs([tabs[2]]);
      is(
        gb.selectedTab,
        tabs[0],
        "Unloading leaves both panes of the affected split"
      );
      ok(tabs[4].linkedPanel, "The untargeted pane remains loaded");
      ok(!tabs[2].linkedPanel, "The requested pane is unloaded");
    } finally {
      verifyUnloaded();
    }
  });
});
