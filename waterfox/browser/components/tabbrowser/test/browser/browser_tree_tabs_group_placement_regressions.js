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

add_task(async function test_pinning_root_parent_preserves_group_root_slot() {
  await enableTreeTabs();
  const originalTabs = new Set(gBrowser.tabs);
  Services.prefs.setBoolPref(
    "browser.tabs.verticalTabs.tree.autoGroup.pinnedOpener",
    true
  );
  try {
    const parent = BrowserTestUtils.addTab(gBrowser, "about:blank");
    gBrowser.moveTabTo(parent, { tabIndex: gBrowser.pinnedTabCount });
    const first = gBrowser.addTrustedTab("about:blank?pin-placement-first", {
      openerBrowser: parent.linkedBrowser,
      skipAnimation: true,
    });
    const second = gBrowser.addTrustedTab("about:blank?pin-placement-second", {
      openerBrowser: parent.linkedBrowser,
      skipAnimation: true,
    });
    const following = BrowserTestUtils.addTab(gBrowser, "about:blank");
    const last = BrowserTestUtils.addTab(gBrowser, "about:blank");
    await BrowserTestUtils.switchTab(
      gBrowser,
      originalTabs.values().next().value
    );

    is(
      Array.from(gBrowser.tabs).find(tab => !tab.pinned),
      parent,
      "The parent is the first unpinned tab before pinning"
    );
    is(first._tPos, parent._tPos + 1, "The first child follows its parent");
    is(second._tPos, first._tPos + 1, "The second child follows the first");
    gBrowser.pinTab(parent);
    const group = getTreeParent(first);
    await waitForTreeCondition(
      () => group && PlacementGroups.isGroupTab(group),
      "Waiting for the pinned parent's replacement group"
    );
    is(getTreeParent(second), group, "Both children stay in their group");

    const roots = gBrowser.TreeTabsService
      .getRootTabs(window)
      .filter(tab => !tab.pinned);
    const stripRoots = Array.from(gBrowser.tabs).filter(
      tab => !tab.pinned && !getTreeParent(tab)
    );
    is(roots[0], group, "The replacement retains the first unpinned root slot");
    assertPlacementOrder(roots, stripRoots, "Root model and strip order agree");
    ok(group._tPos < first._tPos, "The replacement precedes its children");
    ok(second._tPos < following._tPos, "The following roots stay after the tree");

    await BrowserTestUtils.switchTab(gBrowser, last);
    last.owner = null;
    gBrowser.setSuccessor(last, null);
    await BrowserTestUtils.removeTab(last, { isUserTriggered: true });
    is(
      gBrowser.selectedTab,
      following,
      "Closing the last root selects its previous neighbor"
    );
  } finally {
    await cleanupPlacementTabs(originalTabs);
  }
});

add_task(async function test_group_under_parent_uses_first_members_slot() {
  await enableTreeTabs();
  const originalTabs = new Set(gBrowser.tabs);
  try {
    const parent = BrowserTestUtils.addTab(gBrowser, "about:blank");
    const first = await openTabWithTree(parent);
    const middle = await openTabWithTree(parent);
    const last = await openTabWithTree(parent);
    const selected = gBrowser.selectedTab;

    const group = PlacementGroups.groupTabs(window, [middle], {
      temporary: false,
    });

    assertPlacementOrder(
      gBrowser.TreeTabsService.getChildren(parent),
      [first, group, last],
      "The group takes its first member's position under the parent"
    );
    assertPlacementOrder(
      Array.from(gBrowser.tabs).filter(tab =>
        [parent, first, group, middle, last].includes(tab)
      ),
      [parent, first, group, middle, last],
      "The grouped subtree keeps its strip position"
    );
    is(getTreeParent(middle), group, "The grouped member becomes a child");
    is(gBrowser.selectedTab, selected, "Grouping preserves the selected tab");
  } finally {
    await cleanupPlacementTabs(originalTabs);
  }
});

add_task(async function test_explicit_subgroup_position_preserves_native_group() {
  await enableTreeTabs();
  const originalTabs = new Set(gBrowser.tabs);
  await SpecialPowers.pushPrefEnv({
    set: [["browser.tabs.groups.enabled", true]],
  });
  try {
    const parent = BrowserTestUtils.addTab(gBrowser, "about:blank");
    const first = await openTabWithTree(parent);
    const middle = await openTabWithTree(parent);
    const last = await openTabWithTree(parent);
    const nativeGroup = gBrowser.addTabGroup([parent, first, middle, last], {
      label: "Placement regression",
    });
    const selected = gBrowser.selectedTab;

    const group = PlacementGroups.groupTabs(window, [middle], {
      temporary: false,
      parent,
      insertBefore: middle,
    });

    assertPlacementOrder(
      gBrowser.TreeTabsService.getChildren(parent),
      [first, group, last],
      "An explicit position under the parent remains authoritative"
    );
    for (const tab of [parent, first, group, middle, last]) {
      is(tab.group, nativeGroup, "Grouping preserves native group membership");
    }
    is(getTreeParent(middle), group, "The subgroup owns its member");
    is(gBrowser.selectedTab, selected, "Grouping preserves selection");
  } finally {
    await cleanupPlacementTabs(originalTabs);
    await SpecialPowers.popPrefEnv();
  }
});
