/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const {
  GROUP_TAB_URL: LIFECYCLE_GROUP_URL,
  TreeTabsGroups: LifecycleGroups,
} = ChromeUtils.importESModule("resource:///modules/TreeTabsGroups.sys.mjs");
const { TreeTabsStore: LifecycleStore } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsStore.sys.mjs"
);

async function waitForLifecycleGroupPages(groups) {
  await waitForTreeCondition(
    () =>
      groups.every(
        tab =>
          tab.linkedBrowser.currentURI.spec.startsWith(LIFECYCLE_GROUP_URL) &&
          !tab.hasAttribute("busy")
      ),
    "Waiting for the group pages to finish loading"
  );
}

async function cleanupLifecycleTestTabs(originalTabs) {
  LifecycleStore.clearRestoreGuard(window);
  await disableTreeTabs({ strict: false });
  for (const tab of Array.from(gBrowser.tabs).reverse()) {
    if (!originalTabs.has(tab)) {
      await BrowserTestUtils.removeTab(tab);
    }
  }
  clearTreeTestPrefs();
}

add_task(async function test_group_uri_is_available_before_document_load() {
  await enableTreeTabs();
  const originalTabs = new Set(gBrowser.tabs);
  try {
    const first = BrowserTestUtils.addTab(gBrowser, "about:blank");
    const second = BrowserTestUtils.addTab(gBrowser, "about:blank");
    const group = LifecycleGroups.groupTabs(window, [first, second], {
      temporaryAggressive: true,
      title: "Pending group",
    });
    info(JSON.stringify({
      current: group.linkedBrowser.currentURI.spec,
      typed: group.linkedBrowser.userTypedValue,
    }));
    ok(LifecycleGroups.isGroupTab(group), "A new group is recognized immediately");
    is(
      LifecycleGroups.getTemporaryState(group),
      2,
      "Cleanup recognizes the temporary state before the document loads"
    );
  } finally {
    await disableTreeTabs({ strict: false });
    for (const tab of Array.from(gBrowser.tabs).reverse()) {
      if (!originalTabs.has(tab)) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
    clearTreeTestPrefs();
  }
});

add_task(async function test_cleanup_counts_promoted_children() {
  await enableTreeTabs();
  const originalTabs = new Set(gBrowser.tabs);
  try {
    const first = BrowserTestUtils.addTab(gBrowser, "about:blank");
    const second = BrowserTestUtils.addTab(gBrowser, "about:blank");
    const inner = LifecycleGroups.groupTabs(window, [first], {
      temporaryAggressive: true,
    });
    const outer = LifecycleGroups.groupTabs(window, [inner, second], {
      temporaryAggressive: true,
    });
    await waitForTreeCondition(
      () =>
        LifecycleGroups.isGroupTab(inner) &&
        LifecycleGroups.isGroupTab(outer),
      "Waiting for the group documents to be recognized"
    );

    LifecycleGroups.cleanupNeedlessGroupTabs(window, [outer, inner]);

    ok(!gBrowser.tabs.includes(inner), "The one-child inner group is removed");
    ok(gBrowser.tabs.includes(outer), "The outer group keeps its two children");
    is(getTreeParent(first), outer, "The first tab is promoted into the outer group");
    is(getTreeParent(second), outer, "The second tab keeps its parent");
  } finally {
    await disableTreeTabs({ strict: false });
    for (const tab of Array.from(gBrowser.tabs).reverse()) {
      if (!originalTabs.has(tab)) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
    clearTreeTestPrefs();
  }
});

add_task(async function test_cleanup_expands_empty_temporary_children() {
  await enableTreeTabs();
  const originalTabs = new Set(gBrowser.tabs);
  LifecycleStore.ensureRestoreGuard(window);
  try {
    const first = gBrowser.addTrustedTab(
      LifecycleGroups.makeGroupTabURI({ temporary: true }),
      { skipAnimation: true }
    );
    const second = gBrowser.addTrustedTab(
      LifecycleGroups.makeGroupTabURI({ temporaryAggressive: true }),
      { skipAnimation: true }
    );
    const outer = LifecycleGroups.groupTabs(window, [first, second], {
      temporaryAggressive: true,
    });
    await waitForLifecycleGroupPages([first, second, outer]);
    LifecycleStore.clearRestoreGuard(window);

    LifecycleGroups.cleanupNeedlessGroupTabs(window, [outer]);

    for (const tab of [first, second, outer]) {
      ok(
        !gBrowser.tabs.includes(tab),
        "An outer-only request removes the connected empty temporary groups"
      );
    }
    ok(
      Array.from(originalTabs).every(tab => gBrowser.tabs.includes(tab)),
      "Unrelated tabs stay open"
    );
  } finally {
    await cleanupLifecycleTestTabs(originalTabs);
  }
});

add_task(async function test_passive_group_keeps_promoted_real_child() {
  await enableTreeTabs();
  const originalTabs = new Set(gBrowser.tabs);
  LifecycleStore.ensureRestoreGuard(window);
  try {
    const real = BrowserTestUtils.addTab(gBrowser, "about:blank");
    const firstGrandchild = BrowserTestUtils.addTab(gBrowser, "about:blank");
    const secondGrandchild = BrowserTestUtils.addTab(gBrowser, "about:blank");
    gBrowser.TreeTabsService.attachTab(firstGrandchild, real);
    gBrowser.TreeTabsService.attachTab(secondGrandchild, real);
    const inner = LifecycleGroups.groupTabs(window, [real], {
      temporaryAggressive: true,
    });
    const outer = LifecycleGroups.groupTabs(window, [inner], {
      temporary: true,
    });
    await waitForLifecycleGroupPages([inner, outer]);
    LifecycleStore.clearRestoreGuard(window);

    LifecycleGroups.cleanupNeedlessGroupTabs(window, [outer, inner, outer]);

    ok(!gBrowser.tabs.includes(inner), "The aggressive inner group is removed");
    ok(gBrowser.tabs.includes(outer), "The passive outer group remains");
    is(
      getTreeParent(real),
      outer,
      "The real child is promoted into the passive group"
    );
    is(
      gBrowser.TreeTabsService.getChildren(outer).length,
      1,
      "The promoted real tab counts as one direct child"
    );
    for (const tab of [firstGrandchild, secondGrandchild]) {
      ok(gBrowser.tabs.includes(tab), "The real tab's descendant remains open");
      is(getTreeParent(tab), real, "The descendant keeps its original parent");
    }
  } finally {
    await cleanupLifecycleTestTabs(originalTabs);
  }
});

add_task(async function test_cleanup_stops_at_permanent_group_boundary() {
  await enableTreeTabs();
  const originalTabs = new Set(gBrowser.tabs);
  LifecycleStore.ensureRestoreGuard(window);
  try {
    const empty = gBrowser.addTrustedTab(
      LifecycleGroups.makeGroupTabURI({ temporaryAggressive: true }),
      { skipAnimation: true }
    );
    const permanent = LifecycleGroups.groupTabs(window, [empty], {
      temporary: false,
    });
    const real = BrowserTestUtils.addTab(gBrowser, "about:blank");
    const outer = LifecycleGroups.groupTabs(window, [permanent, real], {
      temporaryAggressive: true,
    });
    await waitForLifecycleGroupPages([empty, permanent, outer]);
    LifecycleStore.clearRestoreGuard(window);

    LifecycleGroups.cleanupNeedlessGroupTabs(window, [outer]);

    for (const tab of [outer, permanent, empty, real]) {
      ok(
        gBrowser.tabs.includes(tab),
        "The permanent boundary preserves its subtree"
      );
    }
    is(getTreeParent(permanent), outer, "The permanent group keeps its parent");
    is(
      getTreeParent(empty),
      permanent,
      "Cleanup does not enter the permanent group"
    );
    is(
      getTreeParent(real),
      outer,
      "The outer group's other child remains attached"
    );
  } finally {
    await cleanupLifecycleTestTabs(originalTabs);
  }
});

add_task(async function test_passive_wrapper_of_temporary_group_is_removed() {
  await enableTreeTabs();
  const originalTabs = new Set(gBrowser.tabs);
  LifecycleStore.ensureRestoreGuard(window);
  try {
    const first = BrowserTestUtils.addTab(gBrowser, "about:blank");
    const second = BrowserTestUtils.addTab(gBrowser, "about:blank");
    const inner = LifecycleGroups.groupTabs(window, [first, second], {
      temporaryAggressive: true,
    });
    const outer = LifecycleGroups.groupTabs(window, [inner], {
      temporary: true,
    });
    await waitForLifecycleGroupPages([inner, outer]);
    LifecycleStore.clearRestoreGuard(window);

    LifecycleGroups.cleanupNeedlessGroupTabs(window, [outer]);

    ok(!gBrowser.tabs.includes(outer), "The redundant passive wrapper is removed");
    ok(
      gBrowser.tabs.includes(inner),
      "The temporary group with two children remains"
    );
    is(getTreeParent(inner), null, "The retained group is promoted to a root");
    is(getTreeParent(first), inner, "The first child stays in the retained group");
    is(getTreeParent(second), inner, "The second child stays in the retained group");
  } finally {
    await cleanupLifecycleTestTabs(originalTabs);
  }
});
