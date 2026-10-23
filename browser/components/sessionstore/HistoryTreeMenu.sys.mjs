/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  HistoryTree: "resource://gre/modules/sessionstore/HistoryTree.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
});

const HTML = "http://www.w3.org/1999/xhtml";
const ROW_HEIGHT = 28;
const MAX_SCROLL_HEIGHT = 8_000_000;

export const HistoryTreeMenu = {
  show(win, anchor) {
    const browser = win.gBrowser.selectedBrowser;
    const history = browser.browsingContext.sessionHistory;
    if (!history?.treeEnabled || !history.count) {
      return null;
    }
    const graph = {
      version: 1,
      ids: history.treeNodeIds,
      parents: history.treeParents,
      selectedChildren: history.treeSelectedChildren,
      revision: history.treeRevision,
    };
    if (!lazy.HistoryTree.valid(graph)) {
      return null;
    }
    const doc = win.document;
    doc.getElementById("history-tree-popup")?.hidePopup();
    const panel = doc.createXULElement("panel");
    panel.id = "history-tree-popup";
    panel.setAttribute("type", "arrow");
    const sheet = doc.createElementNS(HTML, "link");
    sheet.rel = "stylesheet";
    sheet.href = "chrome://browser/content/browser-history-tree.css";
    panel.append(sheet);
    const tree = doc.createElementNS(HTML, "div");
    tree.className = "history-tree-viewport";
    tree.setAttribute("role", "tree");
    tree.tabIndex = 0;
    doc.l10n.setAttributes(tree, "history-tree-navigation");
    const space = doc.createElementNS(HTML, "div");
    space.className = "history-tree-space";
    tree.append(space);
    panel.append(tree);

    const count = graph.ids.length;
    const firstChild = new Int32Array(count).fill(-1);
    const nextSibling = new Int32Array(count).fill(-1);
    const childCounts = new Int32Array(count);
    const siblingFromEnd = new Int32Array(count);
    let firstRoot = -1;
    let rootCount = 0;
    for (let index = count - 1; index >= 0; --index) {
      const parent = graph.parents[index];
      if (parent < 0) {
        siblingFromEnd[index] = rootCount++;
        nextSibling[index] = firstRoot;
        firstRoot = index;
      } else {
        siblingFromEnd[index] = childCounts[parent];
        nextSibling[index] = firstChild[parent];
        firstChild[parent] = index;
        ++childCounts[parent];
      }
    }
    const expanded = new Set(history.activePath);
    const labels = new Map();
    let rows = [];
    let focused = 0;
    const current = history.index;

    function unchanged() {
      if (
        !history.treeEnabled ||
        win.gBrowser.selectedBrowser !== browser ||
        browser.browsingContext.sessionHistory !== history ||
        history.treeRevision !== graph.revision
      ) {
        panel.hidePopup();
        return false;
      }
      return true;
    }

    function describe(index) {
      if (!labels.has(index)) {
        const entry = history.getEntryAtIndex(index);
        labels.set(index, {
          url: entry.URI.spec,
          title: entry.title || entry.URI.spec,
        });
        if (labels.size > 512) {
          labels.delete(labels.keys().next().value);
        }
      }
      return labels.get(index);
    }

    function flatten(keepIndex = current) {
      rows = [];
      const stack = firstRoot < 0 ? [] : [{ index: firstRoot, depth: 0 }];
      while (stack.length) {
        const row = stack.pop();
        rows.push(row);
        if (nextSibling[row.index] >= 0) {
          stack.push({ index: nextSibling[row.index], depth: row.depth });
        }
        if (expanded.has(row.index) && firstChild[row.index] >= 0) {
          stack.push({ index: firstChild[row.index], depth: row.depth + 1 });
        }
      }
      focused = Math.max(
        0,
        rows.findIndex(row => row.index === keepIndex)
      );
      space.style.height = `${Math.min(MAX_SCROLL_HEIGHT, rows.length * ROW_HEIGHT)}px`;
      tree.style.setProperty(
        "--history-tree-height",
        `${rows.length * ROW_HEIGHT}px`
      );
    }

    function activate(index, event = {}) {
      if (!unchanged()) {
        return;
      }
      const nodeId = graph.ids[index];
      if (event.button === 1 || event.ctrlKey || event.metaKey) {
        lazy.SessionStore.duplicateTab(win, win.gBrowser.selectedTab, 0, true, {
          historyNodeId: nodeId,
          inBackground: !event.shiftKey,
        });
      } else if (index !== current) {
        try {
          browser.browsingContext.sessionHistory.gotoTreeNode(nodeId, true);
        } catch (error) {
          console.warn(
            "The selected history entry is no longer available",
            error
          );
        }
      }
      panel.hidePopup();
    }

    function toggle(index) {
      if (!childCounts[index]) {
        return;
      }
      if (expanded.has(index)) {
        expanded.delete(index);
      } else {
        expanded.add(index);
      }
      flatten(index);
      scrollToFocus();
    }

    function render() {
      if (!unchanged()) {
        return;
      }
      const height = tree.clientHeight || 360;
      const compressed = rows.length * ROW_HEIGHT > MAX_SCROLL_HEIGHT;
      const visibleCount = Math.ceil(height / ROW_HEIGHT);
      const scrollRange = Math.max(1, MAX_SCROLL_HEIGHT - height);
      const base = compressed
        ? Math.floor(
            (tree.scrollTop / scrollRange) *
              Math.max(0, rows.length - visibleCount)
          )
        : Math.floor(tree.scrollTop / ROW_HEIGHT);
      const first = Math.max(0, base - 2);
      const end = Math.min(rows.length, first + visibleCount + 5);
      const fragment = doc.createDocumentFragment();
      for (let position = first; position < end; ++position) {
        const { index, depth } = rows[position];
        const { url, title } = describe(index);
        const row = doc.createElementNS(HTML, "div");
        row.className = "history-tree-row";
        row.id = `history-tree-row-${index}`;
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-level", depth + 1);
        const parent = graph.parents[index];
        const siblings = parent < 0 ? rootCount : childCounts[parent];
        row.setAttribute("aria-posinset", siblings - siblingFromEnd[index]);
        row.setAttribute("aria-setsize", siblings);
        row.setAttribute("aria-selected", position === focused);
        row.setAttribute("aria-label", title);
        row.dataset.nodeId = graph.ids[index];
        row.dataset.url = url;
        row.style.top = `${compressed ? tree.scrollTop + (position - base) * ROW_HEIGHT : position * ROW_HEIGHT}px`;
        row.style.setProperty("--history-depth", Math.min(depth, 12));
        row.title = `${title}\n${url}`;
        if (index === current) {
          row.setAttribute("aria-current", "page");
        }
        const disclosure = doc.createElementNS(HTML, "button");
        disclosure.type = "button";
        disclosure.tabIndex = -1;
        disclosure.className = "history-tree-disclosure";
        if (childCounts[index]) {
          const open = expanded.has(index);
          row.setAttribute("aria-expanded", open);
          disclosure.textContent = open ? "▾" : "▸";
          doc.l10n.setAttributes(
            disclosure,
            open ? "history-tree-collapse" : "history-tree-expand"
          );
          disclosure.addEventListener("click", event => {
            event.stopPropagation();
            toggle(index);
          });
        } else {
          disclosure.setAttribute("aria-hidden", "true");
          disclosure.disabled = true;
        }
        const marker = doc.createElementNS(HTML, "span");
        marker.className = "history-tree-current";
        marker.setAttribute("aria-hidden", "true");
        marker.textContent = index === current ? "●" : "";
        const text = doc.createElementNS(HTML, "span");
        text.className = "history-tree-title";
        text.textContent = title;
        row.append(disclosure, marker);
        if (depth > 12) {
          const level = doc.createElementNS(HTML, "span");
          level.className = "history-tree-depth";
          level.textContent = `${depth + 1}`;
          doc.l10n.setAttributes(level, "history-tree-depth", {
            level: depth + 1,
          });
          row.append(level);
        }
        row.append(text);
        row.addEventListener("click", event => activate(index, event));
        row.addEventListener("auxclick", event => {
          if (event.button === 1) {
            event.preventDefault();
            activate(index, event);
          }
        });
        fragment.append(row);
      }
      space.replaceChildren(fragment);
      const focusedId = `history-tree-row-${rows[focused]?.index}`;
      if (doc.getElementById(focusedId)) {
        tree.setAttribute("aria-activedescendant", focusedId);
      } else {
        tree.removeAttribute("aria-activedescendant");
      }
    }

    function scrollToFocus() {
      const height = tree.clientHeight || 360;
      if (rows.length * ROW_HEIGHT > MAX_SCROLL_HEIGHT) {
        const visible = Math.ceil(height / ROW_HEIGHT);
        tree.scrollTop =
          (Math.max(0, focused - Math.floor(visible / 2)) /
            Math.max(1, rows.length - visible)) *
          (MAX_SCROLL_HEIGHT - height);
      } else {
        const top = focused * ROW_HEIGHT;
        if (
          top < tree.scrollTop ||
          top + ROW_HEIGHT > tree.scrollTop + height
        ) {
          tree.scrollTop = Math.max(0, top - Math.floor(height / 2));
        }
      }
      render();
    }

    tree.addEventListener("scroll", render);
    tree.addEventListener("keydown", event => {
      const row = rows[focused];
      if (!row) {
        return;
      }
      switch (event.key) {
        case "ArrowDown":
          focused = Math.min(rows.length - 1, focused + 1);
          break;
        case "ArrowUp":
          focused = Math.max(0, focused - 1);
          break;
        case "Home":
          focused = 0;
          break;
        case "End":
          focused = rows.length - 1;
          break;
        case "ArrowRight":
          if (childCounts[row.index] && !expanded.has(row.index)) {
            toggle(row.index);
          } else if (firstChild[row.index] >= 0) {
            focused = rows.findIndex(
              item => item.index === firstChild[row.index]
            );
          }
          break;
        case "ArrowLeft":
          if (expanded.has(row.index) && childCounts[row.index]) {
            toggle(row.index);
          } else if (graph.parents[row.index] >= 0) {
            focused = rows.findIndex(
              item => item.index === graph.parents[row.index]
            );
          }
          break;
        case "Enter":
        case " ":
          activate(row.index, event);
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
      scrollToFocus();
    });
    const close = () => panel.hidePopup();
    win.gBrowser.tabContainer.addEventListener("TabSelect", close);
    panel.addEventListener(
      "popuphidden",
      () => {
        win.gBrowser.tabContainer.removeEventListener("TabSelect", close);
        panel.remove();
      },
      { once: true }
    );
    panel.addEventListener(
      "popupshown",
      () => {
        scrollToFocus();
        tree.focus({ preventScroll: true });
      },
      { once: true }
    );
    doc.getElementById("mainPopupSet").append(panel);
    flatten();
    render();
    panel.openPopup(anchor, "after_start");
    return panel;
  },
};
