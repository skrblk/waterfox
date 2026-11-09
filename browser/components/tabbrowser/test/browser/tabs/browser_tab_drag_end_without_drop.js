/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// A tab drag that ends without a drop moves the tab to a new window, unless
// it ended close to the tab strip. Where it ended is taken from what the
// window saw of the drag, because the position that comes with dragend is a
// guess in that case: stale once the pointer left the window on Wayland, and
// scaled by the wrong factor with fractional scaling.

const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";

function screenCenter(element) {
  let rect = element.getBoundingClientRect();
  return {
    screenX: window.mozInnerScreenX + rect.left + rect.width / 2,
    screenY: window.mozInnerScreenY + rect.top + rect.height / 2,
  };
}

// A point no part of the window covers.
function outsideWindow() {
  return {
    screenX: window.screenX + window.outerWidth + 500,
    screenY: window.screenY + window.outerHeight + 500,
  };
}

function makeDataTransfer() {
  let items = [];
  return {
    dropEffect: "none",
    effectAllowed: "all",
    mozUserCancelled: false,
    mozCursor: "auto",
    get mozItemCount() {
      return items.length;
    },
    mozSetDataAt(type, data, index) {
      (items[index] ||= new Map()).set(type, data);
    },
    mozGetDataAt(type, index) {
      return items[index]?.get(type) ?? null;
    },
    mozTypesAt(index) {
      return [...(items[index]?.keys() ?? [])];
    },
    addElement() {},
    setDragImage() {},
    updateDragImage() {},
  };
}

// What the window sees of a drag in progress.
function seeDrag(type, point = {}) {
  document.documentElement.dispatchEvent(
    new DragEvent(type, { bubbles: true, cancelable: true, ...point })
  );
}

/**
 * Runs one tab drag that ends without a drop.
 *
 * @param {object} options
 * @param {Function} [options.during]
 *   Called between the start and the end of the drag with the dragged tab.
 * @param {object} options.reported
 *   The position that comes with dragend.
 * @param {boolean} [options.userCancelled]
 * @param {boolean} [options.started]
 *   False to end a drag this window never saw start.
 * @returns {Promise<boolean>} Whether the tab was moved to a new window.
 */
async function dragEndsWithoutDrop({
  during,
  reported,
  userCancelled = false,
  started = true,
}) {
  let dnd = gBrowser.tabContainer.tabDragAndDrop;
  let tab = BrowserTestUtils.addTab(gBrowser, "about:blank", {
    skipAnimation: true,
  });
  await TestUtils.waitForCondition(
    () => tab.getBoundingClientRect().height > 0,
    "the new tab is laid out"
  );

  let detached = false;
  let replaceTabsWithWindow = gBrowser.replaceTabsWithWindow;
  gBrowser.replaceTabsWithWindow = () => {
    detached = true;
    return null;
  };

  let dataTransfer = makeDataTransfer();
  try {
    if (started) {
      dnd.startTabDrag(
        {
          dataTransfer,
          target: tab,
          ...screenCenter(tab),
          stopPropagation() {},
        },
        tab
      );
    } else {
      dataTransfer.mozSetDataAt(TAB_DROP_TYPE, tab, 0);
      tab._dragData = { offsetX: 0, offsetY: 0, movingTabs: [tab] };
    }
    during?.(tab);
    dataTransfer.mozUserCancelled = userCancelled;
    dnd.handle_dragend({
      dataTransfer,
      target: tab,
      ...reported,
      screen: Cc["@mozilla.org/gfx/screenmanager;1"].getService(
        Ci.nsIScreenManager
      ).primaryScreen,
      stopPropagation() {},
    });
  } finally {
    gBrowser.replaceTabsWithWindow = replaceTabsWithWindow;
    delete tab._dragData;
    await BrowserTestUtils.removeTab(tab);
  }
  return detached;
}

add_task(async function test_points_used_by_these_tests() {
  ok(
    !(await dragEndsWithoutDrop({
      started: false,
      reported: screenCenter(gBrowser.selectedTab),
    })),
    "A tab's own position counts as close to the tab strip"
  );
  ok(
    await dragEndsWithoutDrop({
      started: false,
      reported: screenCenter(gBrowser.selectedBrowser),
    }),
    "The middle of the page does not count as close to the tab strip"
  );
  ok(
    await dragEndsWithoutDrop({ started: false, reported: outsideWindow() }),
    "A point outside the window does not count as close to the tab strip"
  );
});

add_task(async function test_release_right_after_drag_start_keeps_the_tab() {
  ok(
    !(await dragEndsWithoutDrop({ reported: outsideWindow() })),
    "A drag released where it started keeps its tab, whatever position dragend reports"
  );
});

add_task(async function test_release_over_the_strip_keeps_the_tab() {
  ok(
    !(await dragEndsWithoutDrop({
      during: tab => seeDrag("dragover", screenCenter(tab)),
      reported: outsideWindow(),
    })),
    "A drag last seen over the tab strip keeps its tab"
  );
});

add_task(async function test_release_over_the_page_detaches() {
  ok(
    await dragEndsWithoutDrop({
      during: () => seeDrag("dragover", screenCenter(gBrowser.selectedBrowser)),
      reported: screenCenter(gBrowser.selectedTab),
    }),
    "A drag last seen over the page moves its tab to a new window"
  );
});

add_task(async function test_release_after_leaving_the_window_detaches() {
  ok(
    await dragEndsWithoutDrop({
      during: tab => {
        seeDrag("dragover", screenCenter(tab));
        seeDrag("dragleave");
      },
      reported: screenCenter(gBrowser.selectedTab),
    }),
    "A drag that left the window moves its tab to a new window, even when dragend reports the place it left from"
  );
});

add_task(async function test_moving_between_elements_is_not_an_exit() {
  ok(
    !(await dragEndsWithoutDrop({
      during: tab => {
        seeDrag("dragover", screenCenter(gBrowser.selectedBrowser));
        seeDrag("dragenter", screenCenter(tab));
        seeDrag("dragleave");
        seeDrag("dragover", screenCenter(tab));
      },
      reported: outsideWindow(),
    })),
    "A leave followed by more of the drag inside the window keeps the tab"
  );
});

add_task(async function test_return_to_the_strip_keeps_the_tab() {
  ok(
    !(await dragEndsWithoutDrop({
      during: tab => {
        seeDrag("dragleave");
        seeDrag("dragenter", screenCenter(tab));
        seeDrag("dragover", screenCenter(tab));
      },
      reported: outsideWindow(),
    })),
    "A drag that came back to the tab strip keeps its tab"
  );
});

add_task(async function test_cancelled_and_disabled_drags_keep_the_tab() {
  ok(
    !(await dragEndsWithoutDrop({
      during: () => seeDrag("dragover", screenCenter(gBrowser.selectedBrowser)),
      reported: outsideWindow(),
      userCancelled: true,
    })),
    "A drag cancelled by the user keeps its tab"
  );

  await SpecialPowers.pushPrefEnv({
    set: [["browser.tabs.allowTabDetach", false]],
  });
  try {
    ok(
      !(await dragEndsWithoutDrop({
        during: () =>
          seeDrag("dragover", screenCenter(gBrowser.selectedBrowser)),
        reported: outsideWindow(),
      })),
      "With detaching turned off a drag keeps its tab"
    );
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_a_finished_drag_leaves_nothing_behind() {
  ok(
    !(await dragEndsWithoutDrop({ reported: outsideWindow() })),
    "The first drag keeps its tab"
  );
  seeDrag("dragover", screenCenter(gBrowser.selectedBrowser));
  ok(
    !(await dragEndsWithoutDrop({
      started: false,
      reported: screenCenter(gBrowser.selectedTab),
    })),
    "What the window sees after a drag ended does not affect a later drag"
  );
});
