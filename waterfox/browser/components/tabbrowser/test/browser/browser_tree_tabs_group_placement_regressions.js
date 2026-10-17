/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { TreeTabsGroups: PlacementGroups } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsGroups.sys.mjs"
);

function assertPlacementOrder(actual, expected, message) {
  is(actual.length, expected.length, `${message}: same number of tabs`);
  for (let i = 0; i < expected.length; i++) {
    is(actual[i], expected[i], `${message}: tab ${i}`);
  }
}

async function cleanupPlacementTabs(originalTabs) {
  await disableTreeTabs({ strict: false });
  for (const tab of Array.from(gBrowser.tabs).reverse()) {
    if (!originalTabs.has(tab)) {
      if (tab.pinned) {
        gBrowser.unpinTab(tab);
      }
      await BrowserTestUtils.removeTab(tab);
    }
  }
  clearTreeTestPrefs();
}

add_task(async function test_pinned_opener_placement_survives_tab_switches() {
  await enableTreeTabs();
  const originalTabs = new Set(gBrowser.tabs);
  Services.prefs.setIntPref(PREF_TREE_AUTO_ATTACH, 1);
  Services.prefs.setBoolPref(
    "browser.tabs.verticalTabs.tree.autoGroup.pinnedOpener",
    true
  );
  try {
    const opener = BrowserTestUtils.addTab(gBrowser, "about:blank");
    gBrowser.pinTab(opener);
    await BrowserTestUtils.switchTab(gBrowser, opener);
    const first = gBrowser.addTrustedTab("about:blank?placement-first", {
      relatedToCurrent: true,
      skipAnimation: true,
    });

    await BrowserTestUtils.switchTab(gBrowser, first);
    await BrowserTestUtils.switchTab(gBrowser, opener);
    const second = gBrowser.addTrustedTab("about:blank?placement-second", {
      relatedToCurrent: true,
      skipAnimation: true,
    });
    const group = getTreeParent(second);
    await waitForTreeCondition(
      () => group && PlacementGroups.isGroupTab(group),
      "Waiting for the pinned opener's group page"
    );
    is(getTreeParent(first), group, "The first tab belongs to the same group");
    ok(group._tPos < first._tPos, "The group precedes its first child");
    ok(first._tPos < second._tPos, "The second related tab follows the first");

    const descendant = gBrowser.addTrustedTab(
      "about:blank?placement-descendant",
      { openerBrowser: second.linkedBrowser, skipAnimation: true }
    );
    is(getTreeParent(descendant), second, "The second tab has a descendant");
    await BrowserTestUtils.switchTab(gBrowser, second);
    await BrowserTestUtils.switchTab(gBrowser, opener);
    const third = gBrowser.addTrustedTab("about:blank?placement-third", {
      relatedToCurrent: true,
      skipAnimation: true,
    });

    is(getTreeParent(third), group, "A later tab reuses the existing group");
    ok(
      descendant._tPos < third._tPos,
      "A later related tab follows the group's complete existing subtree"
    );
    assertPlacementOrder(
      gBrowser.TreeTabsService.getChildren(group),
      [first, second, third],
      "Tree sibling order follows the order the tabs opened"
    );
    assertPlacementOrder(
      Array.from(gBrowser.tabs).filter(tab =>
        [group, first, second, descendant, third].includes(tab)
      ),
      [group, first, second, descendant, third],
      "Strip order follows the grouped tree"
    );
    is(gBrowser.selectedTab, opener, "Background openings preserve selection");
  } finally {
    await cleanupPlacementTabs(originalTabs);
  }
});
