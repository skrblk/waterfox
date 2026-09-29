const fs = require('node:fs');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const source = fs.readFileSync(__dirname + '/tabbrowser.js', 'utf8');
const start = source.indexOf('    _findTabToBlurTo(aTab,');
assert.ok(start > 0, 'Find the exact production method');
const end = source.indexOf('\n    }', start) + 6;
const method = source.slice(start, end);
function fixture(order, overrides = {}) {
  const tabs = order.map(([id, loaded]) => ({id, linkedPanel: loaded ? id : null, visible: true}));
  const current = tabs.find(t => t.id === 'current');
  current.selected = true;
  const prefs = {'browser.tabs.selectOwnerOnClose': true};
  const browser = {
    tabs, visibleTabs: tabs, tabsInCollapsedTabGroups: [],
    tabContainer: {allTabs: tabs, findNextTab(tab, {direction, filter}) {
      for(let i=tabs.indexOf(tab)+direction;i>=0 && i<tabs.length;i+=direction) {
        if(tabs[i] !== tab && !tabs[i].closing && !tabs[i]._closedInMultiselection && filter(tabs[i])) return tabs[i];
      }
      return null;
    }},
    TreeTabsService: {enabled: false},
    ...overrides,
  };
  Object.assign(browser, new Function('Services', 'FirefoxViewHandler', `return ({${method}});`)({prefs:{getBoolPref:n=>prefs[n]}}, {}));
  return {browser,current,tabs};
}
for (const side of ['right','left']) test(`closing skips unloaded ${side} neighbor`, () => {
  const f=fixture(side === 'right' ? [['left',true],['current',true],['lazy',false],['right',true]] : [['left',true],['lazy',false],['current',true]]);
  assert.equal(f.browser._findTabToBlurTo(f.current, [], {excludeUnloaded:true}).id, side);
});
test('unloaded explicit successor does not bypass close exclusions', () => {
  const f=fixture([['loaded',true],['current',true],['lazy',false]]);
  f.current.successor=f.tabs[2];
  assert.equal(f.browser._findTabToBlurTo(f.current, [], {excludeUnloaded:true}).id,'loaded');
});
test('unloaded owner does not bypass close exclusions', () => {
  const f=fixture([['loaded',true],['current',true],['lazy',false]]);
  f.current.owner=f.tabs[2];
  assert.equal(f.browser._findTabToBlurTo(f.current, [], {excludeUnloaded:true}).id,'loaded');
});
test('all-unloaded prediction returns no candidate without creating one', () => {
  const f=fixture([['left',false],['current',true],['right',false]]);
  assert.equal(f.browser._findTabToBlurTo(f.current, [], {excludeUnloaded:true}),null);
});
test('loaded explicit successor keeps its precedence', () => {
  const f=fixture([['owner',true],['current',true],['next',true],['successor',true]]);
  f.current.owner=f.tabs[0]; f.current.successor=f.tabs[3];
  assert.equal(f.browser._findTabToBlurTo(f.current, [], {excludeUnloaded:true}),f.tabs[3]);
});
test('non-close callers retain existing policy', () => {
  const f=fixture([['left',true],['current',true],['right',false]]);
  assert.equal(f.browser._findTabToBlurTo(f.current).id,'right');
});
test('background close predicts no selection change', () => {
  const f=fixture([['left',true],['current',true],['right',false]]);
  assert.equal(f.browser._findTabToBlurTo(f.tabs[2], [], {excludeUnloaded:true}),null);
});
