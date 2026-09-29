add_task(async function unload_excludes_its_entire_operation_set() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    const gb = win.gBrowser;
    const verifyUnloaded = await discardCloseTestTabs(win, [tabs[1], tabs[3]]);
    try {
      gb.setSuccessor(tabs[2], tabs[4]);
      await gb.explicitUnloadTabs([tabs[2], tabs[4]]);
      is(gb.selectedTab, tabs[0], "The loaded successor being unloaded is excluded");
      ok(!tabs[2].linkedPanel && !tabs[4].linkedPanel, "Both requested tabs are unloaded");
    } finally {
      verifyUnloaded();
    }
  });
});

add_task(async function unload_keeps_its_existing_new_tab_fallback() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    const gb = win.gBrowser;
    const verifyUnloaded = await discardCloseTestTabs(win, tabs.filter(tab => tab != tabs[2]));
    try {
      ok(!win.FirefoxViewHandler.tab, "The new window has no open Firefox View");
      await gb.explicitUnloadTabs([tabs[2]]);
      is(gb.tabs.length, 6, "Unloading retains the original tab and adds its fallback");
      is(gb.selectedBrowser.currentURI.spec, win.BROWSER_NEW_TAB_URL, "Unload retains its configured new-tab destination");
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
      is(gb.selectedTab, tabs[0], "Unloading leaves both panes of the affected split");
      ok(tabs[4].linkedPanel, "The untargeted pane remains loaded");
      ok(!tabs[2].linkedPanel, "The requested pane is unloaded");
    } finally {
      verifyUnloaded();
    }
  });
});
