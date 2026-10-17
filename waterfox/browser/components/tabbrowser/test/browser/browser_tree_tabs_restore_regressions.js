/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { SessionStore: GuardSessionStore } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/SessionStore.sys.mjs"
);
const { TreeTabsStore: GuardTreeStore } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsStore.sys.mjs"
);
const { TreeTabsService: GuardTreeService } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsService.sys.mjs"
);

async function withGuardTreeFixture(task) {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.verticalTabs.tree.enabled", true],
      ["browser.tabs.verticalTabs.tree.autoAttach", 0],
    ],
  });
  let win;
  try {
    win = await BrowserTestUtils.openNewBrowserWindow();
    const parent = win.gBrowser.addTrustedTab("about:blank", {
      skipAnimation: true,
    });
    const child = win.gBrowser.addTrustedTab("about:blank", {
      skipAnimation: true,
    });
    GuardTreeStore.init();
    GuardTreeService.init(win);
    GuardTreeStore.completeExternalRestore(win);
    await task({ win, parent, child });
  } finally {
    if (win && !win.closed) {
      await BrowserTestUtils.closeWindow(win);
    }
    await SpecialPowers.popPrefEnv();
  }
}

async function waitForGuardSave(win) {
  await new Promise(resolve => win.setTimeout(resolve, 0));
  await TestUtils.waitForCondition(
    () => !GuardTreeStore._pendingSaves.has(win),
    "The catch-up save finishes without another tree event"
  );
}

add_task(async function test_tree_changes_are_saved_after_restore_guard_clears() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.verticalTabs.tree.enabled", true],
      ["browser.tabs.verticalTabs.tree.autoAttach", 0],
    ],
  });
  let win;
  try {
    win = await BrowserTestUtils.openNewBrowserWindow();
    const parent = win.gBrowser.addTrustedTab("about:blank", {
      skipAnimation: true,
    });
    const child = win.gBrowser.addTrustedTab("about:blank", {
      skipAnimation: true,
    });
    GuardTreeStore.init();
    GuardTreeService.init(win);
    GuardTreeStore.completeExternalRestore(win);
    ok(!GuardTreeStore.isRestorePending(win), "The initial restore has finished");

    const windowBefore = GuardSessionStore.getCustomWindowValue(
      win,
      "treeTabs:tree-structure"
    );
    const ancestorsBefore = GuardSessionStore.getCustomTabValue(
      child,
      "treeTabs:ancestors"
    );
    const parentGuid = GuardTreeStore.getTabGuid(parent);
    const childGuid = GuardTreeStore.getTabGuid(child);

    GuardTreeStore.ensureRestoreGuard(win);
    ok(GuardTreeService.attachTab(child, parent), "The user changes the live tree");
    is(
      GuardSessionStore.getCustomWindowValue(win, "treeTabs:tree-structure"),
      windowBefore,
      "The guard protects the saved window structure while it is raised"
    );
    is(
      GuardSessionStore.getCustomTabValue(child, "treeTabs:ancestors"),
      ancestorsBefore,
      "The guard protects the saved per-tab structure while it is raised"
    );

    GuardTreeStore.clearRestoreGuard(win);
    await new Promise(resolve => win.setTimeout(resolve, 0));
    await TestUtils.waitForCondition(
      () => !GuardTreeStore._pendingSaves.has(win),
      "The catch-up save finishes without another tree event"
    );
    const structure = JSON.parse(
      GuardSessionStore.getCustomWindowValue(win, "treeTabs:tree-structure")
    );
    const parentIndex = structure.findIndex(entry => entry.id === parentGuid);
    const childEntry = structure.find(entry => entry.id === childGuid);
    is(childEntry.parent, parentIndex, "The saved window catches up with the edit");
    const ancestors = JSON.parse(
      GuardSessionStore.getCustomTabValue(child, "treeTabs:ancestors")
    );
    is(
      ancestors[0]?.uniqueId,
      parentGuid,
      "The saved tab metadata also catches up with the edit"
    );
  } finally {
    if (win && !win.closed) {
      await BrowserTestUtils.closeWindow(win);
    }
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_pending_snapshot_survives_timer_guard_release() {
  await withGuardTreeFixture(async ({ win, parent, child }) => {
    const before = GuardSessionStore.getCustomWindowValue(
      win,
      "treeTabs:tree-structure"
    );
    GuardTreeStore._pendingWindowRestores.add(win);
    GuardTreeStore.ensureRestoreGuard(win);
    GuardTreeService.attachTab(child, parent);
    GuardTreeStore.clearRestoreGuard(win);
    await waitForGuardSave(win);
    ok(GuardTreeStore.isRestorePending(win), "The snapshot still needs restore");
    is(
      GuardSessionStore.getCustomWindowValue(win, "treeTabs:tree-structure"),
      before,
      "Expiring the timer does not overwrite an unresolved saved snapshot"
    );
    is(
      GuardSessionStore.getCustomTabValue(child, "treeTabs:ancestors"),
      "[]",
      "The unresolved snapshot also protects the per-tab metadata"
    );

    GuardTreeStore.completeExternalRestore(win);
    is(
      JSON.parse(
        GuardSessionStore.getCustomTabValue(child, "treeTabs:ancestors")
      )[0]?.uniqueId,
      GuardTreeStore.getTabGuid(parent),
      "Explicitly completing the restore persists the live tree"
    );
  });
});

add_task(async function test_prequeued_save_survives_a_restore_guard() {
  await withGuardTreeFixture(async ({ win, parent, child }) => {
    GuardTreeService.attachTab(child, parent);
    ok(GuardTreeStore._pendingSaves.has(win), "The live edit queues a save");
    GuardTreeStore.ensureRestoreGuard(win);
    await TestUtils.waitForCondition(
      () => !GuardTreeStore._pendingSaves.has(win),
      "The queued save encounters the raised guard"
    );
    GuardTreeStore.clearRestoreGuard(win);
    await waitForGuardSave(win);
    is(
      JSON.parse(
        GuardSessionStore.getCustomTabValue(child, "treeTabs:ancestors")
      )[0]?.uniqueId,
      GuardTreeStore.getTabGuid(parent),
      "A save blocked after queuing also catches up when the guard clears"
    );
  });
});

add_task(async function test_manual_restore_flushes_after_timer_already_cleared() {
  await withGuardTreeFixture(async ({ win, parent, child }) => {
    const structure = JSON.parse(
      GuardSessionStore.getCustomWindowValue(win, "treeTabs:tree-structure")
    );
    const parentGuid = GuardTreeStore.getTabGuid(parent);
    const parentIndex = structure.findIndex(entry => entry.id === parentGuid);
    structure.find(entry => entry.id === GuardTreeStore.getTabGuid(child)).parent =
      parentIndex;
    GuardSessionStore.setCustomWindowValue(
      win,
      "treeTabs:tree-structure",
      JSON.stringify(structure)
    );
    GuardTreeStore._pendingWindowRestores.add(win);
    GuardTreeStore._manualRestoreCompleted.delete(win);
    GuardTreeStore.ensureRestoreGuard(win);
    GuardTreeService.attachTab(child, parent);
    GuardTreeStore.clearRestoreGuard(win);
    ok(
      GuardTreeStore.tryManualRestore(win),
      "The saved snapshot now restores successfully"
    );
    await waitForGuardSave(win);
    is(
      JSON.parse(
        GuardSessionStore.getCustomTabValue(child, "treeTabs:ancestors")
      )[0]?.uniqueId,
      parentGuid,
      "Successful restore refreshes metadata even after the old timer expired"
    );
  });
});

add_task(async function test_window_teardown_discards_guard_catchup() {
  await withGuardTreeFixture(async ({ win, parent, child }) => {
    const before = GuardSessionStore.getCustomWindowValue(
      win,
      "treeTabs:tree-structure"
    );
    GuardTreeStore.ensureRestoreGuard(win);
    GuardTreeService.attachTab(child, parent);
    GuardTreeStore.uninitWindow(win);
    GuardTreeStore.clearRestoreGuard(win);
    ok(!GuardTreeStore._pendingSaves.has(win), "Teardown queues no stale save");
    is(
      GuardSessionStore.getCustomWindowValue(win, "treeTabs:tree-structure"),
      before,
      "Unwiring the window leaves its protected snapshot untouched"
    );
  });
});
