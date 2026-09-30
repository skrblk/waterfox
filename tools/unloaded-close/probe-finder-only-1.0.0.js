for (const filtering of [false, true]) {
  for (const otherLoaded of [false, true]) {
    add_task(async function close_successor_boundary() {
      await SpecialPowers.pushPrefEnv({set: [
        ["sidebar.verticalTabs", true],
        ["browser.tabs.verticalTabs.tree.enabled", true],
        ["browser.tabs.verticalTabs.tree.autoAttach", 0],
        ["browser.tabs.closeWindowWithLastTab", false],
        ["browser.tabs.warnOnClose", false],
      ]});
      const win = await BrowserTestUtils.openNewBrowserWindow();
      try {
        const gb = win.gBrowser;
        const tabs = [];
        for (let i = 0; i < 3; i++) {
          const tab = gb.addTrustedTab(`data:text/html,<title>probe-${i}</title>test`, {skipAnimation: true, inBackground: true});
          await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
          tabs.push(tab);
        }
        await BrowserTestUtils.switchTab(gb, tabs[1]);
        await BrowserTestUtils.removeTab(gb.tabs[0]);
        const sleeping = otherLoaded ? [tabs[2]] : [tabs[0], tabs[2]];
        for (const tab of sleeping) {
          await gb.prepareDiscardBrowser(tab);
          ok(gb.discardBrowser(tab, true), "Fixture discarded a background tab");
        }
        if (filtering) {
          const find = gb._findTabToBlurTo;
          gb._findTabToBlurTo = function(tab, excluded = []) {
            return find.call(this, tab, excluded.concat(this.tabContainer.allTabs.filter(t => !t.linkedPanel)));
          };
        }
        let inserted = 0;
        const count = event => { if (sleeping.includes(event.target)) inserted++; };
        gb.tabContainer.addEventListener("TabBrowserInserted", count);
        await BrowserTestUtils.removeTab(tabs[1]);
        await new Promise(resolve => win.setTimeout(resolve, 200));
        info(JSON.stringify({filtering, otherLoaded, selectedIsOld: tabs.includes(gb.selectedTab), selectedConnected: gb.selectedTab?.isConnected, selectedURI: gb.selectedBrowser?.currentURI?.spec, tabCount: gb.tabs.length, inserted, sleepingPanels: sleeping.map(t => !!t.linkedPanel)}));
        is(inserted, 0, "Closing did not restore an unloaded tab");
        ok(gb.selectedTab?.isConnected, "A surviving tab is selected");
        ok(gb.selectedBrowser?.isConnected, "The selected browser is connected");
        if (otherLoaded) is(gb.selectedTab, tabs[0], "Existing loaded tab is selected");
        else ok(!tabs.includes(gb.selectedTab), "The existing unload fallback supplies a new tab");
        gb.tabContainer.removeEventListener("TabBrowserInserted", count);
      } finally {
        if (!win.closed) await BrowserTestUtils.closeWindow(win);
        await SpecialPowers.popPrefEnv();
      }
    });
  }
}
