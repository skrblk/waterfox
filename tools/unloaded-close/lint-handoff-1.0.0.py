from pathlib import Path
import os
import re
import shutil
import subprocess

root = Path.cwd()
source = root / 'lint-tree'
logs = root / 'artifacts'

def run(args, name, cwd=None):
    with (logs/name).open('w') as log:
        subprocess.run(args, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, check=True)

run(['git', 'init', str(source)], 'lint-init.log')
run(['git', 'fetch', '--depth=1', '--filter=blob:none', 'https://github.com/BrowserWorks/waterfox.git', os.environ['BASE']], 'lint-fetch.log', source)
run(['git', 'sparse-checkout', 'init', '--cone'], 'lint-sparse-init.log', source)
run(['git', 'sparse-checkout', 'set', 'waterfox/browser/components/tabbrowser/test', 'tools/lint/eslint', 'tools/@types', 'tools/rewriting', 'browser/base/content', 'browser/components/tabbrowser', 'browser/modules', 'testing/modules', 'toolkit/content', 'toolkit/components/printing', 'toolkit/components/viewsource', 'browser/components/downloads', 'browser/components/places', 'browser/components/customizableui', 'browser/components/sidebar', 'browser/components/search', 'browser/components/screenshots', 'testing/mochitest/tests/SimpleTest'], 'lint-sparse-set.log', source)
run(['git', 'checkout', '--detach', 'FETCH_HEAD'], 'lint-checkout.log', source)
paths = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', 'HEAD'], cwd=source, text=True).splitlines()
configs = [p for p in paths if ('eslint' in Path(p).name and p.endswith(('.js', '.mjs', '.json'))) or p == 'devtools/client/debugger/src/.eslintignore']
run(['git', 'checkout', '--ignore-skip-worktree-bits', 'HEAD', '--', *configs], 'lint-config-checkout.log', source)
run(['npm', 'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund'], 'lint-install.log', source)
files = ['browser/components/tabbrowser/content/tabbrowser.js', 'browser/components/tabbrowser/test/browser/tabs/browser_tabSuccessors.js', 'waterfox/browser/components/tabbrowser/test/browser/browser_tree_tabs_basic.js']
for dest, name in zip(files, ['tabbrowser.js', 'browser_tabSuccessors.js', 'browser_tree_tabs_basic.js']):
    shutil.copyfile(logs/name, source/dest)
for attempt in range(30):
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
    raise RuntimeError('ESLint dependency resolution limit exceeded')
run(['git', 'diff', '--check'], 'diff-check.log', source)
run(['git', 'diff', '--stat'], 'diff-stat.log', source)
