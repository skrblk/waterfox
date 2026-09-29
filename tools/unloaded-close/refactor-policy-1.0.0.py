from pathlib import Path
import hashlib


def replace_once(source, old, new):
    assert source.count(old) == 1, (old[:80], source.count(old))
    return source.replace(old, new, 1)


def refactor(source):
    source = replace_once(source, '''let tabsToExclude = tabs.concat(
          this.tabContainer.allTabs.filter(tab => !tab.linkedPanel)
        );''', 'let tabsToExclude = [...tabs];')
    source = replace_once(source, 'let newTab = this._findTabToBlurTo(this.selectedTab, tabsToExclude);', '''let newTab = this._findTabToBlurToWithoutRestoring(
          this.selectedTab,
          tabsToExclude
        );''')
    source = replace_once(source, '''let toBlurTo = this._findTabToBlurTo(lastToClose, tabs, {
            excludeUnloaded: true,
          });''', '''let toBlurTo = this._findTabToBlurToWithoutRestoring(lastToClose, tabs);''')
    source = replace_once(source, '''let blurTab = this._findTabToBlurTo(aTab, closingTabs, {
            excludeUnloaded: true,
          });''', '''let blurTab = this._findTabToBlurToWithoutRestoring(aTab, closingTabs);''')
    source = replace_once(source, '''     * @param   {object} [options]
     * @param   {boolean} [options.excludeUnloaded=false]
     *          Avoid restoring unloaded tabs when choosing a close successor.
''', '')
    source = replace_once(source, '''    _findTabToBlurTo(
      aTab,
      aExcludeTabs = [],
      { excludeUnloaded = false } = {}
    ) {''', '''    _findTabToBlurTo(aTab, aExcludeTabs = []) {''')
    source = replace_once(source, '''      if (excludeUnloaded) {
        for (const tab of this.tabs) {
          if (!tab.linkedPanel || tab.closing || tab._closedInMultiselection) {
            excludeTabs.add(tab);
          }
        }
      }
''', '')
    source = replace_once(source, '''    _blurTab(aTab, aExcludeTabs = []) {''', '''    _findTabToBlurToWithoutRestoring(aTab, aExcludeTabs = []) {
      if (!aTab.selected) {
        return null;
      }
      const excludeTabs = aExcludeTabs.concat(
        this.tabContainer.allTabs.filter(
          tab => !tab.linkedPanel || tab.closing || tab._closedInMultiselection
        )
      );
      return this._findTabToBlurTo(aTab, excludeTabs);
    }

    _blurTab(aTab, aExcludeTabs = []) {''')
    source = replace_once(source, '''let nextTab = this._findTabToBlurTo(aTab, aExcludeTabs, {
        excludeUnloaded: true,
      });''', '''let nextTab = this._findTabToBlurToWithoutRestoring(aTab, aExcludeTabs);''')
    assert 'excludeUnloaded' not in source
    return source


if __name__ == '__main__':
    source = Path('work/previous-tabbrowser.js').read_bytes()
    assert hashlib.sha1(b'blob ' + str(len(source)).encode() + b'\0' + source).hexdigest() == '26b05683bdb828e4235e02f23da46622b021b256'
    Path('work/tabbrowser.js').write_text(refactor(source.decode()))
