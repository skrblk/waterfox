from pathlib import Path

s = Path('work/previous-test.js').read_text()
a = s.index('  for (const priority of ["adjacent", "owner", "successor"])')
b = s.index('  add_task(async function close_with_only_unloaded_survivors()', a)
s = s[:a] + '''  for (const operation of ["close", "unload"]) {
    for (const priority of ["adjacent", "owner", "successor"]) {
      add_task(async function automatic_selection_skips_unloaded_tabs() {
        info(`${mode}: ${operation}, ${priority}`);
        await withCloseUnloadWindow(mode, async (win, tabs) => {
          const gb = win.gBrowser;
          const [left, lazyLeft, current, lazyRight, right] = tabs;
          const verifyUnloaded = await discardCloseTestTabs(win, [lazyLeft, lazyRight]);
          try {
            if (priority == "owner") {
              current.owner = lazyLeft;
            } else if (priority == "successor") {
              gb.setSuccessor(current, lazyRight);
            }
            if (operation == "close") {
              await BrowserTestUtils.removeTab(current);
            } else {
              await gb.explicitUnloadTabs([current]);
              ok(!current.linkedPanel, "The requested tab is unloaded");
            }
            is(gb.selectedTab, right, "Selection skips the unloaded candidates");
            ok(left.linkedPanel, "The other loaded candidate stays loaded");
            is(gb.tabs.length, operation == "close" ? 4 : 5, "A loaded successor needs no fallback");
          } finally {
            verifyUnloaded();
          }
        });
      });
    }
  }

''' + s[b:]
a = s.index('        const predicted = gb._findTabToBlurTo(')
b = s.index('        await BrowserTestUtils.removeTab(current);', a)
s = s[:a] + s[b:]
a = s.index('add_task(async function explicit_unload_retains_its_existing_policy()')
b = s.index('add_task(async function three_to_two_tabs_', a)
s = s[:a] + s[b:]
s = s.replace('Closing never materialized even a transient browser for an unloaded tab', 'Automatic selection never restored an unloaded tab')
extra = Path('work/shared-native-tests.js').read_text()
extra = extra[extra.index('add_task(async function unload_excludes_its_entire_operation_set()'):]
s += '\n' + extra
Path('work/browser_close_unloaded_tabs.js').write_text(s)
