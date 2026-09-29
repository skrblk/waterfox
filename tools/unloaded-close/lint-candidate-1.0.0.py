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
run(['git', 'sparse-checkout', 'set', 'tools/lint/eslint', 'tools/@types', 'tools/rewriting', 'browser/base/content', 'browser/components/tabbrowser', 'browser/modules', 'testing/modules'], 'lint-sparse-set.log', source)
run(['git', 'checkout', '--detach', 'FETCH_HEAD'], 'lint-checkout.log', source)
paths = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', 'HEAD'], cwd=source, text=True).splitlines()
configs = [p for p in paths if ('eslint' in Path(p).name and p.endswith(('.js', '.mjs', '.json'))) or p == 'devtools/client/debugger/src/.eslintignore']
run(['git', 'checkout', '--ignore-skip-worktree-bits', 'HEAD', '--', *configs], 'lint-config-checkout.log', source)
run(['npm', 'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund'], 'lint-install.log', source)
files = ['browser/components/tabbrowser/content/tabbrowser.js', 'browser/components/tabbrowser/test/browser/tabs/browser_close_unloaded_tabs.js']
for dest, name in zip(files, ['tabbrowser.js', 'browser_close_unloaded_tabs.js']):
    shutil.copyfile(logs/name, source/dest)
shutil.copyfile(logs/'browser.toml', source/'browser/components/tabbrowser/test/browser/tabs/browser.toml')
run(['node', 'node_modules/eslint/bin/eslint.js', '--format', 'json', *files], 'eslint.json', source)
