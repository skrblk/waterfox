/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { SessionStore: GroupUndoSessionStore } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/SessionStore.sys.mjs"
);
const { TabStateFlusher: GroupUndoFlusher } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/TabStateFlusher.sys.mjs"
);
const { TreeTabsGroups: GroupUndoGroups } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsGroups.sys.mjs"
);
const { TreeTabsStore: GroupUndoStore } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsStore.sys.mjs"
);

add_task(async function test_automatic_group_cleanup_preserves_undo_history() {
  await enableTreeTabs();
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.sessionstore.max_tabs_undo", 500],
      [PREF_TREE_AUTO_ATTACH, 0],
      [PREF_TREE_CLOSE_PARENT_BEHAVIOR, 1],
    ],
  });
  const originalTabs = new Set(gBrowser.tabs);
  const initialCount = GroupUndoSessionStore.getClosedTabCountForWindow(window);
  const openGroup = async temporary => {
    GroupUndoStore.ensureRestoreGuard(window);
    const uri = GroupUndoGroups.makeGroupTabURI({
      title: temporary ? "Automatic cleanup" : "Deliberate removal",
      temporary,
    });
    const tab = BrowserTestUtils.addTab(gBrowser, uri);
    await waitForTreeCondition(
      () =>
        tab.linkedBrowser.currentURI.spec == uri && !tab.hasAttribute("busy"),
      "Waiting for the group document"
    );
    await GroupUndoFlusher.flush(tab.linkedBrowser);
    GroupUndoStore.clearRestoreGuard(window);
    return tab;
  };
  try {
    const automatic = await openGroup(true);
    const beforeAutomatic =
      GroupUndoSessionStore.getClosedTabCountForWindow(window);
    GroupUndoGroups.cleanupNeedlessGroupTabs(window, [automatic]);
    await waitForTreeCondition(
      () => !automatic.isConnected,
      "Waiting for automatic removal"
    );
    is(
      GroupUndoSessionStore.getClosedTabCountForWindow(window),
      beforeAutomatic,
      "Automatic cleanup does not add an undo entry"
    );

    const deliberate = await openGroup(false);
    const beforeDeliberate =
      GroupUndoSessionStore.getClosedTabCountForWindow(window);
    ok(
      gBrowser.TreeTabsService.removeGroupTab(deliberate),
      "The deliberate removal succeeds"
    );
    await waitForTreeCondition(
      () => !deliberate.isConnected,
      "Waiting for deliberate removal"
    );
    is(
      GroupUndoSessionStore.getClosedTabCountForWindow(window),
      beforeDeliberate + 1,
      "A deliberate group removal keeps its undo entry"
    );
  } finally {
    GroupUndoStore.clearRestoreGuard(window);
    await disableTreeTabs({ strict: false });
    for (const tab of Array.from(gBrowser.tabs).toReversed()) {
      if (!originalTabs.has(tab)) {
        gBrowser.removeTab(tab, { animate: false, skipSessionStore: true });
      }
    }
    while (
      GroupUndoSessionStore.getClosedTabCountForWindow(window) > initialCount
    ) {
      GroupUndoSessionStore.forgetClosedTab(window, 0);
    }
    await SpecialPowers.popPrefEnv();
  }
});
