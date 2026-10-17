/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_disclosure_mouse_buttons() {
  await enableTreeTabs();
  await SpecialPowers.pushPrefEnv({
    set: [
      ["sidebar.visibility", "always-show"],
      ["sidebar.animation.enabled", false],
      [PREF_TREE_AUTO_ATTACH, 0],
      [PREF_TREE_CLOSE_PARENT_BEHAVIOR, 1],
    ],
  });
  SidebarController._state.launcherExpanded = true;
  await waitForTreeCondition(
    () => gBrowser.tabContainer.hasAttribute("expanded"),
    "Waiting for expanded rows"
  );
  const tabs = [];
  const addTab = () => {
    const tab = BrowserTestUtils.addTab(gBrowser, "about:blank", {
      tabIndex: gBrowser.tabs.length,
      relatedToCurrent: false,
    });
    tabs.push(tab);
    return tab;
  };
  const service = gBrowser.TreeTabsService;
  const addParent = () => {
    const parent = addTab();
    service.attachTab(addTab(), parent);
    return parent;
  };
  const top = addParent();
  for (let i = 0; i < 30; i++) {
    addTab();
  }
  const bottom = addParent();
  const menu = document.getElementById("tabContextMenu");
  const targetCenter = async (node, position) => {
    node.closest(".tabbrowser-tab").scrollIntoView({
      block: position,
      behavior: "instant",
    });
    await window.promiseDocumentFlushed(() => {});
    const rect = node.getBoundingClientRect();
    ok(rect.width > 0 && rect.height > 0, "The target has a hit area");
    ok(
      node.contains(
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      ),
      "Native input hits the intended control after scrolling"
    );
  };
  try {
    for (const [parent, position] of [[top, "start"], [bottom, "end"]]) {
      const disclosure = parent.querySelector(".tab-tree-disclosure");
      await targetCenter(disclosure, position);
      EventUtils.synthesizeMouseAtCenter(disclosure, { button: 1 });
      ok(
        parent.isConnected && !parent.closing,
        "Middle disclosure input does not close the parent"
      );
      ok(
        !service.isCollapsed(parent),
        "Middle disclosure input does not toggle the tree"
      );

      EventUtils.synthesizeMouseAtCenter(disclosure, {});
      ok(
        service.isCollapsed(parent),
        "Primary disclosure input collapses the tree"
      );
      await targetCenter(disclosure, position);
      EventUtils.synthesizeMouseAtCenter(disclosure, {});
      ok(
        !service.isCollapsed(parent),
        "Primary disclosure input expands the tree"
      );

    }

    const row = addTab();
    const label = row.querySelector(".tab-label-container");
    await targetCenter(label, "end");
    const closed = BrowserTestUtils.waitForEvent(row, "TabClose");
    EventUtils.synthesizeMouseAtCenter(label, { button: 1 });
    await closed;
    ok(
      row.closing || !row.isConnected,
      "Middle input on an ordinary row still closes the tab"
    );
  } finally {
    if (menu.state != "closed") {
      menu.hidePopup();
    }
    for (const tab of tabs.toReversed()) {
      if (tab.isConnected && !tab.closing) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
    await SpecialPowers.popPrefEnv();
  }
});
