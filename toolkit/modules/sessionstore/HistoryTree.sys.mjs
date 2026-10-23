/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const HistoryTree = Object.freeze({
  valid(tree, entries = null) {
    if (
      !tree ||
      tree.version !== 1 ||
      !Array.isArray(tree.ids) ||
      !Array.isArray(tree.parents) ||
      !Array.isArray(tree.selectedChildren) ||
      tree.parents.length !== tree.ids.length ||
      tree.selectedChildren.length !== tree.ids.length ||
      (entries && entries.length !== tree.ids.length)
    ) {
      return false;
    }
    const ids = new Set();
    for (let index = 0; index < tree.ids.length; ++index) {
      const id = tree.ids[index];
      const parent = tree.parents[index];
      const child = tree.selectedChildren[index];
      if (
        typeof id !== "string" ||
        !/^\{[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\}$/i.test(
          id
        ) ||
        ids.has(id) ||
        (entries && entries[index]?.historyNodeId !== id) ||
        !Number.isInteger(parent) ||
        parent < -1 ||
        parent >= index ||
        !Number.isInteger(child) ||
        child < -1 ||
        child >= tree.ids.length ||
        (child >= 0 && (child <= index || tree.parents[child] !== index))
      ) {
        return false;
      }
      ids.add(id);
    }
    return true;
  },

  path(tree, index) {
    if (
      !this.valid(tree) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= tree.ids.length
    ) {
      return [];
    }
    const path = [];
    for (let parent = index; parent >= 0; parent = tree.parents[parent]) {
      path.push(parent);
    }
    path.reverse();
    for (
      let child = tree.selectedChildren[index];
      child >= 0;
      child = tree.selectedChildren[child]
    ) {
      path.push(child);
    }
    return path;
  },

  select(tree, index) {
    if (
      !this.valid(tree) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= tree.ids.length
    ) {
      return null;
    }
    const selectedChildren = [...tree.selectedChildren];
    for (
      let child = index, parent = tree.parents[child];
      parent >= 0;
      child = parent, parent = tree.parents[child]
    ) {
      selectedChildren[parent] = child;
    }
    return { ...tree, selectedChildren, revision: (tree.revision || 0) + 1 };
  },

  retained(tree, current, maxBack, maxForward) {
    if (
      !this.valid(tree) ||
      !Number.isInteger(current) ||
      current < 0 ||
      current >= tree.ids.length
    ) {
      return null;
    }
    const ancestors = new Map();
    for (
      let index = current, distance = 0;
      index >= 0;
      index = tree.parents[index], ++distance
    ) {
      ancestors.set(index, distance);
    }
    const back = new Int32Array(tree.ids.length).fill(-1);
    const forward = new Int32Array(tree.ids.length);
    const retained = [];
    for (let index = 0; index < tree.ids.length; ++index) {
      if (ancestors.has(index)) {
        back[index] = ancestors.get(index);
      } else if (tree.parents[index] >= 0) {
        const parent = tree.parents[index];
        back[index] = back[parent];
        forward[index] = forward[parent] + 1;
      }
      if (
        back[index] >= 0 &&
        (maxBack < 0 || back[index] <= maxBack) &&
        (maxForward < 0 || forward[index] <= maxForward)
      ) {
        retained.push(index);
      }
    }
    return retained;
  },

  remap(tree, kept) {
    if (
      !this.valid(tree) ||
      !Array.isArray(kept) ||
      kept.some(
        (index, position) =>
          !Number.isInteger(index) ||
          index < 0 ||
          index >= tree.ids.length ||
          (position && index <= kept[position - 1])
      )
    ) {
      return null;
    }
    const positions = new Map(kept.map((index, position) => [index, position]));
    const ancestors = new Int32Array(tree.ids.length).fill(-1);
    const descendants = new Int32Array(tree.ids.length).fill(-1);
    for (let index = 0; index < tree.ids.length; ++index) {
      const parent = tree.parents[index];
      ancestors[index] =
        positions.get(index) ?? (parent >= 0 ? ancestors[parent] : -1);
    }
    for (let index = tree.ids.length - 1; index >= 0; --index) {
      const child = tree.selectedChildren[index];
      descendants[index] =
        positions.get(index) ?? (child >= 0 ? descendants[child] : -1);
    }
    const parents = kept.map(index =>
      tree.parents[index] >= 0 ? ancestors[tree.parents[index]] : -1
    );
    const selectedChildren = kept.map(index =>
      tree.selectedChildren[index] >= 0
        ? descendants[tree.selectedChildren[index]]
        : -1
    );
    return {
      ...tree,
      ids: kept.map(index => tree.ids[index]),
      parents,
      selectedChildren,
      revision: (tree.revision || 0) + 1,
    };
  },
});
