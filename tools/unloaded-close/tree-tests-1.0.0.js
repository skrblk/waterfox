
add_task(async function test_close_skips_unloaded_tree_successor() {
  await enableTreeTabs();
  Services.prefs.setIntPref(PREF_TREE_CLOSE_PARENT_BEHAVIOR, 1);
  let parent = BrowserTestUtils.addTab(gBrowser, "about:blank");
  let unloaded = await openTabWithTree(parent);
  let loaded = await openTabWithTree(parent);
  try {
    await gBrowser.explicitUnloadTabs([unloaded]);
    await BrowserTestUtils.removeTab(parent);
    is(gBrowser.selectedTab, loaded, "Closing skips the unloaded first child");
    ok(!unloaded.linkedPanel, "The first child stays unloaded");
  } finally {
    for (let tab of [parent, unloaded, loaded]) {
      if (tab.isConnected) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
  }
});

add_task(async function test_close_whole_tree_preserves_window_policy() {
  for (let closeWindow of [false, true]) {
    await SpecialPowers.pushPrefEnv({
      set: [
        [PREF_VERTICAL_TABS, true],
        [PREF_TREE_ENABLED, true],
        [PREF_TREE_CLOSE_PARENT_BEHAVIOR, 2],
        ["browser.tabs.closeWindowWithLastTab", closeWindow],
        ["browser.tabs.warnOnClose", false],
      ],
    });
    let win = await BrowserTestUtils.openNewBrowserWindow();
    try {
      let gb = win.gBrowser;
      let parent = gb.selectedTab;
      let child = BrowserTestUtils.addTab(gb, "about:blank");
      gb.TreeTabsService.attachTab(child, parent);
      await gb.explicitUnloadTabs([child]);
      gb.removeTab(parent, { animate: false, isUserTriggered: true });
      if (closeWindow) {
        await TestUtils.waitForCondition(() => win.closed, "Waiting for the empty window to close");
      } else {
        is(gb.tabs.length, 1, "Closing the tree leaves only the normal last-tab replacement");
        ok(gb.selectedTab != parent && gb.selectedTab != child, "Neither closed tab was selected");
        ok(gb.selectedTab.isConnected, "The replacement tab is connected");
      }
      ok(!child.linkedPanel, "The closing child was not restored");
    } finally {
      if (!win.closed) {
        await BrowserTestUtils.closeWindow(win);
      }
      await SpecialPowers.popPrefEnv();
    }
  }
});
