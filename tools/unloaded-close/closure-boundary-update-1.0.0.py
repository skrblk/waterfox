from pathlib import Path

def replace_once(s, a, b):
    assert s.count(a) == 1, (a, s.count(a))
    return s.replace(a,b,1)

def finish_patch(s):
    s=replace_once(s,'      let startedClosedTreeSet = false;\n      if (treeTabs.enabled) {\n        const hasSurvivingSplitPane', '      let startedClosedTreeSet = false;\n      let closeSet = [aTab];\n      if (treeTabs.enabled) {\n        const hasSurvivingSplitPane')
    s=replace_once(s,'        const closeSet = hasSurvivingSplitPane','        closeSet = hasSurvivingSplitPane')
    s=replace_once(s,'        !this._beginRemoveTab(aTab, {\n          closeWindowFastpath: true,','        !this._beginRemoveTab(aTab, {\n          closingTabs: closeSet,\n          closeWindowFastpath: true,')
    s=replace_once(s,'    _beginRemoveTab(\n      aTab,\n      {\n        adoptedByTab,','    _beginRemoveTab(\n      aTab,\n      {\n        adoptedByTab,\n        closingTabs = [],')
    s=replace_once(s,'let blurTab = this._findTabToBlurTo(aTab, [], {','let blurTab = this._findTabToBlurTo(aTab, closingTabs, {')
    s=replace_once(s,'      if (!screenShareInActiveTab) {\n        this._blurTab(aTab);','      if (!screenShareInActiveTab) {\n        this._blurTab(aTab, closingTabs);')
    s=replace_once(s,'    _blurTab(aTab) {','    _blurTab(aTab, aExcludeTabs = []) {')
    s=replace_once(s,'let nextTab = this._findTabToBlurTo(aTab, [], {','let nextTab = this._findTabToBlurTo(aTab, aExcludeTabs, {')
    s=replace_once(s,'        !this.#isLastTabInWindow(aTab)\n      ) {','''        this.tabs.some(
          tab =>
            tab != aTab &&
            tab.isOpen &&
            !tab.hidden &&
            !tab._closedInMultiselection &&
            !aExcludeTabs.includes(tab)
        )
      ) {''')
    return s

if __name__ == "__main__":
    p = Path("work/prepare.py")
    data = p.read_text()
    data = replace_once(data, "import zipfile\n", "import zipfile\nfrom closure_boundary import finish_patch\n")
    data = replace_once(data, "    changed = patch(source)", "    changed = finish_patch(patch(source))")
    p.write_text(data)
    p = Path("work/browser_close_unloaded_tabs.js")
    data = p.read_text()
    data = replace_once(data, '  win.gBrowser.tabContainer.addEventListener("TabBrowserInserted", onInserted);', '  const tabContainer = win.gBrowser.tabContainer;\n  tabContainer.addEventListener("TabBrowserInserted", onInserted);')
    data = replace_once(data, '    win.gBrowser.tabContainer.removeEventListener("TabBrowserInserted", onInserted);', '    tabContainer.removeEventListener("TabBrowserInserted", onInserted);')
    data += '\nfor (const closeWindow of [false, true]) {\n  add_task(async function closing_the_whole_tree_keeps_window_policy() {\n    await withCloseUnloadWindow("tree", async (win, tabs) => {\n      const gb = win.gBrowser;\n      const root = tabs[2];\n      const descendants = tabs.filter(tab => tab != root);\n      for (const tab of descendants) {\n        gb.TreeTabsService.attachTab(tab, root);\n      }\n      Services.prefs.setIntPref("browser.tabs.verticalTabs.tree.closeParentBehavior", 2);\n      Services.prefs.setBoolPref("browser.tabs.closeWindowWithLastTab", closeWindow);\n      const verifyUnloaded = await discardCloseTestTabs(win, descendants);\n      try {\n        gb.removeTab(root, { animate: false, isUserTriggered: true });\n        if (closeWindow) {\n          await TestUtils.waitForCondition(() => win.closed, "Closing the entire tree closes its window");\n          ok(win.closed, "A fallback does not keep an otherwise empty window alive");\n        } else {\n          await TestUtils.waitForCondition(() => tabs.every(tab => !tab.isConnected));\n          is(gb.tabs.length, 1, "Keeping an empty window open creates only its ordinary replacement tab");\n          ok(!tabs.includes(gb.selectedTab), "The replacement is not a restored member of the closed tree");\n        }\n      } finally {\n        verifyUnloaded();\n      }\n    });\n  });\n}\n'
    p.write_text(data)
