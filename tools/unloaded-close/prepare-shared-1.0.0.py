from pathlib import Path
import base64
import difflib
import hashlib
import io
import json
import os
import runpy
import struct
import subprocess
import sys
import urllib.request
import zipfile

WORK = Path('work')
OUT = Path('artifacts')
OUT.mkdir(exist_ok=True)
SOURCE_PATH = 'browser/components/tabbrowser/content/tabbrowser.js'
TEST_DIR = 'browser/components/tabbrowser/test/browser/tabs/'

def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()

def open_omni(path):
    data = path.read_bytes()
    try:
        return zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        end = data.rfind(b'PK\x05\x06')
        if end < 0:
            raise
        footer = list(struct.unpack_from('<4s4H2LH', data, end))
        size, offset = footer[5:7]
        directory = data[offset:offset + size]
        assert directory.startswith(b'PK\x01\x02')
        footer[6] = len(data)
        normalized = data + directory + struct.pack('<4s4H2LH', *footer) + data[end+22:end+22+footer[7]]
        return zipfile.ZipFile(io.BytesIO(normalized))

def sources():
    original = (WORK/'tabbrowser-original.js').read_bytes()
    previous = (WORK/'previous-tabbrowser.js').read_bytes()
    assert blob(original) == '4f3a778c7dba451f4a5332f26ebebf28ac6a1883'
    assert blob(previous) == '26b05683bdb828e4235e02f23da46622b021b256'
    change = runpy.run_path(str(WORK/'refactor-policy-1.0.0.py'))['refactor']
    revised = change(previous.decode())
    (WORK/'tabbrowser.js').write_text(revised)
    runpy.run_path(str(WORK/'prepare-tests-1.0.0.py'))
    formatter = ['node', 'work/style/node_modules/prettier/bin/prettier.cjs', '--config', 'work/.prettierrc.js']
    subprocess.run(formatter + ['--range-start', str(revised.index('    _startRemoveTabs(\n')), '--range-end', str(revised.index('    swapBrowsersAndCloseOther(')), '--write', 'work/tabbrowser.js'], check=True)
    subprocess.run(formatter + ['--write', 'work/browser_close_unloaded_tabs.js'], check=True)
    manifest = (WORK/'browser.toml').read_bytes()
    assert blob(manifest) == '9f16c7d9d9a70fb7dd2651ad9dcea7d019b4b804'
    marker = '["browser_contextmenu_openlink_after_tabnavigated.js"]'
    text = manifest.decode()
    assert text.count(marker) == 1
    text = text.replace(marker, '["browser_close_unloaded_tabs.js"]\ntags = "vertical-tabs"\n\n' + marker)
    (OUT/'browser.toml').write_text(text)
    (OUT/'tabbrowser.js').write_bytes((WORK/'tabbrowser.js').read_bytes())
    (OUT/'browser_close_unloaded_tabs.js').write_bytes((WORK/'browser_close_unloaded_tabs.js').read_bytes())
    changes = [(SOURCE_PATH, original.decode(), (OUT/'tabbrowser.js').read_text()), (TEST_DIR+'browser.toml', manifest.decode(), text), (TEST_DIR+'browser_close_unloaded_tabs.js', '', (OUT/'browser_close_unloaded_tabs.js').read_text())]
    (OUT/'candidate.patch').write_text(''.join(''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile='a/'+path if before else '/dev/null', tofile='b/'+path)) for path,before,after in changes))
    (OUT/'source-hashes.json').write_text(json.dumps({p.name: {'git':blob(p.read_bytes()), 'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in [OUT/'tabbrowser.js', OUT/'browser.toml', OUT/'browser_close_unloaded_tabs.js']}, indent=2))

def patch_browser():
    baseline = (WORK/'tabbrowser-original.js').read_bytes()
    candidate = (OUT/'tabbrowser.js').read_bytes()
    receipts = []
    for archive in (WORK/'waterfox').rglob('omni.ja'):
        with open_omni(archive) as old:
            matches = [name for name in old.namelist() if name.endswith('/tabbrowser.js')]
            if not matches:
                continue
            assert len(matches) == 1
            target = matches[0]
            assert old.read(target) == baseline
            temp = archive.with_suffix('.patched')
            with zipfile.ZipFile(temp, 'w') as new:
                for entry in old.infolist():
                    new.writestr(entry, candidate if entry.filename == target else old.read(entry.filename))
        temp.replace(archive)
        receipts.append({'archive':str(archive), 'entry':target, 'baseline_blob':blob(baseline), 'candidate_blob':blob(candidate), 'source_equals_packaged_baseline':True})
    assert len(receipts) == 1
    (OUT/'package-comparison.json').write_text(json.dumps(receipts, indent=2))

def check_result(name, fails):
    result = json.loads((OUT/f'{name}-native.json').read_text())
    assert not result.get('fatal') and not result.get('errors'), result.get('errors')
    assert result['tasks'] == 52, result['tasks']
    failures = [item for item in result['assertions'] if item.get('pass') is False]
    assert bool(failures) == fails, (name, len(failures))
    print(json.dumps({'run':name, 'tasks':result['tasks'], 'assertions':sum('pass' in a for a in result['assertions']), 'failed':len(failures)}))

def publish():
    check_result('fixed', False)
    files = [(SOURCE_PATH,'tabbrowser.js'), (TEST_DIR+'browser.toml','browser.toml'), (TEST_DIR+'browser_close_unloaded_tabs.js','browser_close_unloaded_tabs.js')]
    result = {}
    for destination, filename in files:
        content = (OUT/filename).read_bytes()
        request = urllib.request.Request(f'https://api.github.com/repos/{os.environ["REPOSITORY"]}/git/blobs', data=json.dumps({'content':base64.b64encode(content).decode(), 'encoding':'base64'}).encode(), headers={'Authorization': 'Bearer '+os.environ['GH_TOKEN'], 'Accept':'application/vnd.github+json', 'Content-Type':'application/json'}, method='POST')
        with urllib.request.urlopen(request, timeout=60) as response:
            uploaded = json.load(response)
        assert uploaded['sha'] == blob(content)
        result[destination] = uploaded['sha']
    (OUT/'verified-blobs.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))

if __name__ == '__main__':
    if sys.argv[1] == 'sources': sources()
    elif sys.argv[1] == 'patch': patch_browser()
    elif sys.argv[1] == 'check-baseline': check_result('baseline', True)
    elif sys.argv[1] == 'check-fixed': check_result('fixed', False)
    elif sys.argv[1] == 'publish': publish()
    else: raise ValueError(sys.argv[1])
