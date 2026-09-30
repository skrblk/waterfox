
for (const autoAttach of [0, 1, 2]) {
  for (const operation of ["close", "unload"]) {
    add_task(async function fallback_reuses_normal_tab_creation() {
      await withCloseUnloadWindow("tree", async (win, tabs) => {
        const gb = win.gBrowser;
        gb.TreeTabsService.attachTab(tabs[2], tabs[0]);
        gb.addTabGroup([tabs[2], tabs[3]], { label: "Existing group" });
        Services.prefs.setIntPref("browser.tabs.verticalTabs.tree.autoAttach", autoAttach);
        Services.prefs.setBoolPref("browser.tabs.autoGroupNewTabs", true);
        const verify = await discardCloseTestTabs(win, tabs.filter(t => t != tabs[2]));
        try {
          if (operation == "close") {
            await BrowserTestUtils.removeTab(tabs[2]);
          } else {
            await gb.explicitUnloadTabs([tabs[2]]);
          }
          ok(gb.selectedTab.isConnected && gb.selectedBrowser.isConnected, "A real replacement is active");
          is(gb.selectedBrowser.currentURI.spec, win.BROWSER_NEW_TAB_URL, "Both operations use the existing new-tab destination");
          ok(!tabs.includes(gb.selectedTab), "Fallback is not an unloaded original");
          is(gb.tabs.length, operation == "close" ? 5 : 6, "Only the needed replacement was created");
        } finally {
          verify();
        }
      });
    });
  }
}

add_task(async function cancelled_tree_descendant_can_survive_the_close() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    const gb = win.gBrowser;
    const parent = tabs[2];
    const survivor = tabs[4];
    gb.removeTabs([tabs[0], tabs[1], tabs[3]], { animate: false });
    gb.TreeTabsService.attachTab(survivor, parent);
    Services.prefs.setIntPref("browser.tabs.verticalTabs.tree.closeParentBehavior", 2);
    const before = gb._hasBeforeUnload;
    const browser = survivor.linkedBrowser;
    const sync = browser.permitUnload;
    const async = browser.asyncPermitUnload;
    try {
      gb._hasBeforeUnload = tab => tab == survivor;
      browser.permitUnload = () => ({ permitUnload: false });
      browser.asyncPermitUnload = () => Promise.resolve({ permitUnload: false });
      gb.removeTab(parent, { animate: false, isUserTriggered: true });
      ok(!parent.isConnected, "The permitted parent close completes");
      ok(survivor.isConnected && !survivor.closing, "The child which refused closing survives");
      is(gb.selectedTab, survivor, "The actual survivor can become selected");
      ok(gb.selectedBrowser.isConnected, "The active browser was not removed");
      is(gb.tabs.length, 1, "No unnecessary replacement is created");
    } finally {
      gb._hasBeforeUnload = before;
      browser.permitUnload = sync;
      browser.asyncPermitUnload = async;
    }
  });
});

add_task(async function background_close_with_two_tabs_stays_nonactivating() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    const gb = win.gBrowser;
    gb.removeTabs([tabs[0], tabs[3], tabs[4]], { animate: false });
    const verify = await discardCloseTestTabs(win, [tabs[1]]);
    try {
      await BrowserTestUtils.removeTab(tabs[1]);
      is(gb.selectedTab, tabs[2], "Closing the unloaded background tab retains selection");
      is(gb.tabs.length, 1, "No fallback is necessary");
      ok(gb.selectedBrowser.isConnected, "The selected browser survives");
    } finally { verify(); }
  });
});

add_task(async function finder_is_pure_with_every_alternative_unloaded() {
  await withCloseUnloadWindow("tree", async (win, tabs) => {
    const gb = win.gBrowser;
    const verify = await discardCloseTestTabs(win, tabs.filter(t => t != tabs[2]));
    try {
      is(gb._findTabToBlurTo(tabs[2]), null, "No loaded candidate exists");
      is(gb.tabs.length, 5, "Prediction does not create a replacement");
      is(gb.selectedTab, tabs[2], "Prediction does not change selection");
    } finally { verify(); }
  });
});
