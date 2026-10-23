import assert from "node:assert/strict";
import { test } from "node:test";

import { HistoryTree } from "../../toolkit/modules/sessionstore/HistoryTree.sys.mjs";
const ids = Array.from(
  { length: 5 },
  (_, n) => `{00000000-0000-4000-8000-${String(n).padStart(12, "0")}}`
);
const tree = () => ({
  version: 1,
  revision: 1,
  ids: [...ids],
  parents: [-1, 0, 1, 1, 3],
  selectedChildren: [1, 3, -1, 4, -1],
});

test("selected paths exclude a sibling and retain its own continuation", () => {
  assert.ok(HistoryTree, "HistoryTree is not implemented");
  assert.deepEqual(HistoryTree.path(tree(), 4), [0, 1, 3, 4]);
  assert.deepEqual(HistoryTree.path(tree(), 2), [0, 1, 2]);
  assert.deepEqual(
    HistoryTree.select(tree(), 2).selectedChildren,
    [1, 2, -1, 4, -1]
  );
});

test("invalid edges, cycles, duplicate identities and stale entry sets are rejected", () => {
  assert.ok(HistoryTree, "HistoryTree is not implemented");
  const entries = ids.map(historyNodeId => ({ historyNodeId }));
  assert.ok(HistoryTree.valid(tree(), entries));
  for (const mutate of [
    graph => (graph.parents[0] = 4),
    graph => (graph.selectedChildren[1] = 4),
    graph => (graph.ids[2] = graph.ids[1]),
    graph => graph.ids.pop(),
    graph => (graph.version = 99),
  ]) {
    const graph = tree();
    mutate(graph);
    assert.equal(HistoryTree.valid(graph, entries), false);
  }
  entries[2].historyNodeId = ids[4];
  assert.equal(HistoryTree.valid(tree(), entries), false);
  entries[2] = null;
  assert.equal(HistoryTree.valid(tree(), entries), false);
});

test("bounded retention remaps edges without attaching a node to its sibling", () => {
  assert.ok(HistoryTree, "HistoryTree is not implemented");
  const graph = HistoryTree.remap(tree(), [2, 3, 4]);
  assert.deepEqual(graph.parents, [-1, -1, 1]);
  assert.deepEqual(graph.selectedChildren, [-1, 2, -1]);
  assert.deepEqual(graph.ids, ids.slice(2));
  assert.deepEqual(HistoryTree.path(graph, 2), [1, 2]);
});

test("removing a middle node preserves surviving ancestry", () => {
  assert.ok(HistoryTree, "HistoryTree is not implemented");
  const graph = HistoryTree.remap(tree(), [0, 1, 2, 4]);
  assert.deepEqual(graph.parents, [-1, 0, 1, 1]);
  assert.deepEqual(graph.selectedChildren, [1, 3, -1, -1]);
});

test("remapping many sibling roots visits their removed shared prefix once", () => {
  const prefix = 400;
  const count = prefix * 2;
  let reads = 0;
  const graph = {
    version: 1,
    ids: Array.from(
      { length: count },
      (_, index) =>
        `{00000000-0000-4000-8000-${String(index).padStart(12, "0")}}`
    ),
    parents: new Proxy(
      Array.from({ length: count }, (_, index) =>
        index < prefix ? index - 1 : prefix - 1
      ),
      {
        get(target, key) {
          if (/^\d+$/.test(String(key))) ++reads;
          return Reflect.get(target, key);
        },
      }
    ),
    selectedChildren: Array.from({ length: count }, (_, index) =>
      index < prefix ? index + 1 : -1
    ),
  };
  const kept = Array.from({ length: prefix }, (_, index) => prefix + index);
  assert.deepEqual(
    HistoryTree.remap(graph, kept).parents,
    kept.map(() => -1)
  );
  assert.ok(reads < count * 20, `Repeated ancestor reads: ${reads}`);
});

test("serialization limits count graph steps and preserve the selected Forward child", () => {
  assert.ok(HistoryTree, "HistoryTree is not implemented");
  assert.deepEqual(HistoryTree.retained(tree(), 1, -1, 1), [0, 1, 2, 3]);
  assert.deepEqual(HistoryTree.retained(tree(), 3, 1, 0), [1, 3]);
  assert.deepEqual(HistoryTree.retained(tree(), 3, 1, 1), [1, 2, 3, 4]);
  assert.deepEqual(HistoryTree.retained(tree(), 4, 1, -1), [3, 4]);
});

test("final session write keeps populated tabs when another tab has no entries", async () => {
  let written;
  globalThis.ChromeUtils = {
    defineESModuleGetters(target) {
      target.HistoryTree = HistoryTree;
      target.sessionStoreLogger = { debug() {}, warn() {} };
    },
  };
  globalThis.IOUtils = {
    async makeDirectory() {},
    async writeJSON(path, state) {
      written = structuredClone(state);
    },
    async stat() {
      return { size: 1 };
    },
  };
  const { SessionWriter } =
    await import("../../browser/components/sessionstore/SessionWriter.sys.mjs");
  SessionWriter.init(
    "empty",
    false,
    { clean: "clean", backups: "backups" },
    {
      maxUpgradeBackups: 0,
      maxSerializeBack: -1,
      maxSerializeForward: 1,
    }
  );
  const state = {
    windows: [
      {
        tabs: [
          {
            entries: [],
            historyTree: {
              version: 1,
              ids: [],
              parents: [],
              selectedChildren: [],
            },
          },
          {
            index: 2,
            entries: ids.map(historyNodeId => ({ historyNodeId })),
            historyTree: tree(),
          },
        ],
      },
    ],
  };
  await SessionWriter.write(state, { isFinalWrite: true });
  assert.equal(written.windows[0].tabs[0].entries.length, 0);
  const tab = written.windows[0].tabs[1];
  assert.deepEqual(tab.historyTree.parents, [-1, 0, 1, 1]);
  assert.equal(tab.entries.length, 4);
  assert.equal(tab.index, 2);
  delete globalThis.ChromeUtils;
  delete globalThis.IOUtils;
});

test("restart-page filtering preserves branch identities and remaps both cursors", async () => {
  let data;
  globalThis.ChromeUtils = {
    defineESModuleGetters(target) {
      target.HistoryTree = HistoryTree;
      target.TabStateCache = {
        get() {
          return data;
        },
      };
      target.sessionStoreLogger = { error() {} };
    },
  };
  const { TabState } =
    await import("../../browser/components/sessionstore/TabState.sys.mjs");
  const graph = {
    ...tree(),
    ids: ids.slice(0, 4),
    parents: [-1, 0, 1, 1],
    selectedChildren: [1, 3, -1, -1],
  };
  for (const removed of [[2], [3], [2, 3]]) {
    const entries = graph.ids.map((historyNodeId, index) => ({
      historyNodeId,
      url: removed.includes(index)
        ? "about:restartrequired"
        : `https://example.com/${index}`,
    }));
    data = {
      history: { historyTree: graph, entries, index: 4, requestedIndex: 3 },
    };
    const tab = {};
    TabState.copyFromCache({}, tab, { includePrivateData: true });
    assert.ok(HistoryTree.valid(tab.historyTree, tab.entries));
    assert.deepEqual(
      tab.historyTree.ids,
      graph.ids.filter((id, index) => !removed.includes(index))
    );
    const currentId = removed.includes(3) ? ids[1] : ids[3];
    assert.equal(tab.historyTree.ids[tab.index - 1], currentId);
    assert.equal(tab.requestedIndex, removed.includes(2) ? 0 : 3);
    assert.equal(
      data.history.entries.length,
      4,
      "Cached source must stay intact"
    );
  }
  delete globalThis.ChromeUtils;
});
