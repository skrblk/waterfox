from pathlib import Path


def replace_once(text, old, new):
    assert text.count(old) == 1, (old[:80], text.count(old))
    return text.replace(old, new, 1)


def update_tests():
    path = Path('work/browser_close_unloaded_tabs.js')
    text = path.read_text()
    text = replace_once(text, '''await TestUtils.waitForCondition(
          () => !tabs[2].isConnected && !tabs[4].isConnected
        );''', '''await BrowserTestUtils.waitForMutationCondition(
          gb.tabContainer,
          { childList: true, subtree: true },
          () => !tabs[2].isConnected && !tabs[4].isConnected
        );''')
    text = replace_once(text, '''await TestUtils.waitForCondition(() =>
            tabs.every(tab => !tab.isConnected)
          );''', '''await BrowserTestUtils.waitForMutationCondition(
            gb.tabContainer,
            { childList: true, subtree: true },
            () => tabs.every(tab => !tab.isConnected)
          );''')
    text = replace_once(text, '    await TestUtils.waitForCondition(() => tabs[1].linkedPanel);\n', '')
    path.write_text(text)


def setup():
    path = Path('work/prepare-shared-1.0.0.py')
    text = path.read_text()
    marker = "    runpy.run_path(str(WORK/'prepare-tests-1.0.0.py'))"
    text = replace_once(text, marker, marker + "\n    runpy.run_path(str(WORK/'pr-checks-1.0.0.py'))['update_tests']()")
    path.write_text(text)
    path = Path('work/native-run.py')
    text = path.read_text()
    text = replace_once(text, 'const BrowserTestUtils = {', '''const BrowserTestUtils = {
  waitForMutationCondition(node, options, predicate) {
    return new Promise((resolve, reject) => {
      if (predicate()) { resolve(); return; }
      const observer = new window.MutationObserver(() => {
        try {
          if (predicate()) {
            observer.disconnect();
            window.clearTimeout(timer);
            resolve();
          }
        } catch (error) {
          observer.disconnect();
          window.clearTimeout(timer);
          reject(error);
        }
      });
      observer.observe(node, options);
      const timer = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error("Mutation condition timed out"));
      }, 15000);
    });
  },''')
    path.write_text(text)
    path = Path('work/lint-candidate-1.0.0.py')
    text = path.read_text()
    text = replace_once(text, "'testing/modules'], 'lint-sparse-set.log'", "'testing/modules', 'toolkit/content', 'toolkit/components/printing', 'toolkit/components/viewsource', 'browser/components/downloads', 'browser/components/places', 'browser/components/customizableui', 'browser/components/sidebar', 'browser/components/search', 'browser/components/screenshots', 'testing/mochitest/tests/SimpleTest'], 'lint-sparse-set.log'")
    text = replace_once(text, "run(['node', 'node_modules/eslint/bin/eslint.js', '--format', 'json', *files], 'eslint.json', source)", '''for attempt in range(30):
    result = subprocess.run(['node', 'node_modules/eslint/bin/eslint.js', '--format', 'json', *files], cwd=source, capture_output=True, text=True)
    output = result.stdout + result.stderr
    (logs/'eslint.json').write_text(output)
    if result.returncode == 0:
        break
    missing = re.search(r"open '([^']+)'", output)
    if result.returncode != 2 or not missing:
        raise RuntimeError(output)
    target = Path(missing[1]).resolve()
    if not target.is_relative_to(source.resolve()):
        raise RuntimeError(output)
    relative = str(target.relative_to(source.resolve()))
    if relative not in paths or target.exists():
        raise RuntimeError(output)
    (logs/f'lint-missing-{attempt}.log').write_text(output)
    run(['git', 'checkout', '--ignore-skip-worktree-bits', 'HEAD', '--', relative], f'lint-dependency-{attempt}.log', source)
else:
    raise RuntimeError('ESLint dependency resolution limit exceeded')''')
    path.write_text(text)


if __name__ == '__main__':
    setup()
