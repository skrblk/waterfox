
add_task(async function test_close_skips_unloaded_successors() {
  for (let priority of ["adjacent", "owner", "successor"]) {
    let current = BrowserTestUtils.addTab(gBrowser, "about:blank");
    let unloaded = BrowserTestUtils.addTab(gBrowser, "about:blank");
    let loaded = BrowserTestUtils.addTab(gBrowser, "about:blank");
    let restored = false;
    let onInserted = () => (restored = true);
    try {
      await BrowserTestUtils.switchTab(gBrowser, current);
      await gBrowser.explicitUnloadTabs([unloaded]);
      unloaded.addEventListener("TabBrowserInserted", onInserted);
      if (priority == "owner") {
        current.owner = unloaded;
      } else if (priority == "successor") {
        gBrowser.setSuccessor(current, unloaded);
      }
      is(gBrowser._findTabToBlurTo(current), loaded, `${priority}: predict the loaded successor`);
      await BrowserTestUtils.removeTab(current);
      is(gBrowser.selectedTab, loaded, `${priority}: select the loaded successor`);
      ok(!restored && !unloaded.linkedPanel, "The unloaded tab was not restored");
    } finally {
      unloaded.removeEventListener("TabBrowserInserted", onInserted);
      for (let tab of [current, unloaded, loaded]) {
        if (tab.isConnected) {
          await BrowserTestUtils.removeTab(tab);
        }
      }
    }
  }
});

add_task(async function test_close_with_only_unloaded_tabs() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.tabs.warnOnClose", false]],
  });
  try {
    for (let multiselect of [false, true]) {
      let win = await BrowserTestUtils.openNewBrowserWindow();
      try {
        let gb = win.gBrowser;
        let current = gb.selectedTab;
        let unloaded = BrowserTestUtils.addTab(gb, "about:blank");
        await gb.explicitUnloadTabs([unloaded]);
        if (multiselect) {
          let other = BrowserTestUtils.addTab(gb, "about:blank");
          gb.addToMultiSelectedTabs(current);
          gb.addToMultiSelectedTabs(other);
        }
        is(gb._findTabToBlurTo(current, gb.selectedTabs), null, "There is no loaded successor outside the selection");
        is(gb.tabs.length, multiselect ? 3 : 2, "Finding a successor does not create a tab");
        let removed = BrowserTestUtils.waitForMutationCondition(
          gb.tabContainer,
          { childList: true, subtree: true },
          () => !current.isConnected
        );
        if (multiselect) {
          gb.removeMultiSelectedTabs();
        } else {
          gb.removeTab(current);
        }
        await removed;
        ok(gb.selectedTab.isConnected, "The replacement tab is connected");
        is(gb.selectedBrowser.currentURI.spec, win.BROWSER_NEW_TAB_URL, "Closing uses the unload command's new-tab fallback");
        is(gb.tabs.length, 2, "Exactly one replacement tab was opened");
        ok(!unloaded.linkedPanel, "The remaining tab stays unloaded");
      } finally {
        await BrowserTestUtils.closeWindow(win);
      }
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_close_with_firefox_view_fallback() {
  let win = await BrowserTestUtils.openNewBrowserWindow();
  try {
    let gb = win.gBrowser;
    let current = gb.selectedTab;
    win.FirefoxViewHandler.openTab("opentabs");
    await BrowserTestUtils.switchTab(gb, current);
    let unloaded = BrowserTestUtils.addTab(gb, "about:blank");
    await gb.explicitUnloadTabs([unloaded]);
    await BrowserTestUtils.removeTab(current);
    is(gb.selectedTab, win.FirefoxViewHandler.tab, "Closing uses the unload command's Firefox View fallback");
    ok(!unloaded.linkedPanel, "Firefox View does not restore the other tab");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});
