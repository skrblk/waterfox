"""Prepare the focused handoff change from the pinned, unmodified source."""
from pathlib import Path
import hashlib
import sys

def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f'Expected exactly one occurrence: {old[:100]!r}')
    return text.replace(old, new, 1)

def refactor(source):
    source = replace_once(source,
        '        let tabsToExclude = tabs.concat(\n          this.tabContainer.allTabs.filter(tab => !tab.linkedPanel)\n        );',
        '        let tabsToExclude = [...tabs];')
    source = replace_once(source,
        '      let excludeTabs = new Set(aExcludeTabs);\n\n      // If this tab has a successor',
        '      let excludeTabs = new Set(aExcludeTabs);\n      for (let tab of this.tabContainer.allTabs) {\n        if (!tab.linkedPanel || tab.closing || tab._closedInMultiselection) {\n          excludeTabs.add(tab);\n        }\n      }\n\n      // If this tab has a successor')
    start = source.index('        if (newTab) {', source.index('    async explicitUnloadTabs('))
    end = source.index('\n      }\n      let memoryUsageBeforeUnload', start)
    branch = source[start:end]
    fallback_start = branch.index('          // all tabs are unloaded')
    fallback = branch[fallback_start:branch.rfind('\n        }')]
    fallback = '\n'.join(line[4:] for line in fallback.splitlines())
    source = source[:start] + '        allTabsUnloaded = !newTab;\n        this._selectTabOrFallback(newTab);' + source[end:]
    new_selector = '''    _selectTabOrFallback(aTab) {
      if (aTab) {
        this.selectedTab = aTab;
        return;
      }
''' + fallback + '\n    }\n\n'
    source = replace_once(source, '    _blurTab(aTab) {\n      this.selectedTab = this._findTabToBlurTo(aTab);\n    }',
        new_selector + '''    _blurTab(aTab, aExcludeTabs = []) {
      if (!aTab.selected) {
        return;
      }
      let nextTab = this._findTabToBlurTo(aTab, aExcludeTabs);
      if (
        nextTab ||
        (!this.#windowIsClosing &&
          this.nonHiddenTabs.some(
            tab => tab != aTab && !aExcludeTabs.includes(tab)
          ))
      ) {
        this._selectTabOrFallback(nextTab);
      }
    }''')
    source = replace_once(source,
        '      let startedClosedTreeSet = false;\n      if (treeTabs.enabled) {\n        const hasSurvivingSplitPane',
        '      let startedClosedTreeSet = false;\n      let closeSet = [aTab];\n      if (treeTabs.enabled) {\n        const hasSurvivingSplitPane')
    source = replace_once(source, '        const closeSet = hasSurvivingSplitPane', '        closeSet = hasSurvivingSplitPane')
    source = replace_once(source,
        '        !this._beginRemoveTab(aTab, {\n          closeWindowFastpath: true,',
        '        !this._beginRemoveTab(aTab, {\n          closingTabs: closeSet,\n          closeWindowFastpath: true,')
    source = replace_once(source,
        '    _beginRemoveTab(\n      aTab,\n      {\n        adoptedByTab,',
        '    _beginRemoveTab(\n      aTab,\n      {\n        adoptedByTab,\n        closingTabs = [],')
    source = replace_once(source, '          let blurTab = this._findTabToBlurTo(aTab);', '          let blurTab = this._findTabToBlurTo(aTab, closingTabs);')
    source = replace_once(source,
        '      if (!screenShareInActiveTab) {\n        this._blurTab(aTab);',
        '      if (!screenShareInActiveTab) {\n        this._blurTab(aTab, closingTabs);')
    return source

if __name__ == '__main__':
    source = Path(sys.argv[1]).read_bytes()
    sha = hashlib.sha1(b'blob '+str(len(source)).encode()+b'\0'+source).hexdigest()
    assert sha == '4f3a778c7dba451f4a5332f26ebebf28ac6a1883', sha
    Path(sys.argv[2]).write_text(refactor(source.decode()))
