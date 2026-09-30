from pathlib import Path
import base64
import difflib
import hashlib
import io
import json
import os
import re
import runpy
import struct
import subprocess
import sys
import urllib.request
import zipfile

W=Path('work'); O=Path('artifacts'); O.mkdir(exist_ok=True)
FILES={
 'browser/components/tabbrowser/content/tabbrowser.js':'tabbrowser.js',
 'browser/components/tabbrowser/test/browser/tabs/browser_tabSuccessors.js':'browser_tabSuccessors.js',
 'waterfox/browser/components/tabbrowser/test/browser/browser_tree_tabs_basic.js':'browser_tree_tabs_basic.js',
}
def blob(b): return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()

def open_omni(path):
    data=path.read_bytes()
    try: return zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        end=data.rfind(b'PK\x05\x06'); assert end>=0
        footer=list(struct.unpack_from('<4s4H2LH',data,end))
        size,offset=footer[5:7]; directory=data[offset:offset+size]
        assert directory.startswith(b'PK\x01\x02')
        footer[6]=len(data)
        return zipfile.ZipFile(io.BytesIO(data+directory+struct.pack('<4s4H2LH',*footer)+data[end+22:end+22+footer[7]]))

def prepare():
    original=(W/'tabbrowser-original.js').read_bytes()
    assert blob(original)=='4f3a778c7dba451f4a5332f26ebebf28ac6a1883'
    revised=runpy.run_path(str(W/'refactor-handoff-1.0.0.py'))['refactor'](original.decode())
    (O/'tabbrowser.js').write_text(revised)
    for name,append in [('browser_tabSuccessors.js','successor-tests-1.0.0.js'),('browser_tree_tabs_basic.js','tree-tests-1.0.0.js')]:
        original=(W/('original-'+name)).read_text()
        (O/name).write_text(original+(W/append).read_text())
    fmt=['node','work/style/node_modules/prettier/bin/prettier.cjs','--config','work/.prettierrc.js']
    subprocess.run(fmt+['--range-start',str(revised.index('    removeTab(\n')),'--range-end',str(revised.index('    swapBrowsersAndCloseOther(')),'--write','artifacts/tabbrowser.js'],check=True)
    for name,append in [('browser_tabSuccessors.js','successor-tests-1.0.0.js'),('browser_tree_tabs_basic.js','tree-tests-1.0.0.js')]:
        old=(W/('original-'+name)).read_text()
        subprocess.run(fmt+['--range-start',str(len(old)),'--range-end',str(len((O/name).read_text())),'--write',str(O/name)],check=True)
        new=(O/name).read_text(); assert new.startswith(old), f'Formatting changed existing tests: {name}'
        (W/('formatted-'+append)).write_text(new[len(old):])
    originals={'tabbrowser.js':W/'tabbrowser-original.js', **{n:W/('original-'+n) for n in ['browser_tabSuccessors.js','browser_tree_tabs_basic.js']}}
    (O/'candidate.patch').write_text(''.join(''.join(difflib.unified_diff(originals[name].read_text().splitlines(True),(O/name).read_text().splitlines(True),fromfile='a/'+path,tofile='b/'+path)) for path,name in FILES.items()))
    (O/'hashes.json').write_text(json.dumps({path:{'before':blob(originals[name].read_bytes()),'after':blob((O/name).read_bytes()),'sha256':hashlib.sha256((O/name).read_bytes()).hexdigest()} for path,name in FILES.items()},indent=2))
    old=(W/'previous-test.js').read_text()
    old=old.replace('"about:blank"', 'win.BROWSER_NEW_TAB_URL')
    old,n=re.subn(r'        is\(\n          fallback.userContextId,.*?        \);\n', '', old, flags=re.S); assert n==1
    old,n=re.subn(r'        ok\(!fallback.group,.*?\n        \);\n', '',old,flags=re.S); assert n==1
    old,n=re.subn(r'        is\(\n          tree.getParent\(gb.selectedTab\),.*?        \);\n', '',old,flags=re.S); assert n==1
    start=old.index('add_task(async function fallback_respects_auto_attach_and_grouping()')
    end=old.index('\nadd_task(async function private_window',start)
    old=old[:start]+old[end:]
    (W/'legacy-boundaries.js').write_text(old+(W/'extra-boundaries-1.0.0.js').read_text())

def patch_browser():
    count=0
    for archive in (W/'waterfox').rglob('omni.ja'):
        with open_omni(archive) as old:
            targets=[n for n in old.namelist() if n.endswith('/tabbrowser.js')]
            if not targets: continue
            assert len(targets)==1
            target=targets[0]; assert old.read(target)==(W/'tabbrowser-original.js').read_bytes()
            tmp=archive.with_suffix('.patched')
            with zipfile.ZipFile(tmp,'w') as new:
                for entry in old.infolist(): new.writestr(entry,(O/'tabbrowser.js').read_bytes() if entry.filename==target else old.read(entry.filename))
        tmp.replace(archive); count+=1
    assert count==1
    (O/'packaged-source-check.json').write_text(json.dumps({'baseline_blob':blob((W/'tabbrowser-original.js').read_bytes()),'tested_blob':blob((O/'tabbrowser.js').read_bytes()),'byte_identical_baseline':True}))

def results(label,expected_failure=False):
    data=json.loads((O/f'{label}-native.json').read_text())
    assert not data.get('fatal') and not data.get('errors'), data
    failed=[a for a in data['assertions'] if a.get('pass') is False]
    summary={'suite':label,'tasks':data['tasks'],'failures':len(failed),'failed_scenarios':sorted(set(a['test'] for a in failed))}
    print(json.dumps(summary))
    if expected_failure: assert failed, 'Baseline should expose the reported bug'
    else: assert not failed, failed
    return summary

def publish():
    for label in ['fixed-generic','fixed-tree','fixed-boundaries']: results(label)
    out={}
    for path,name in FILES.items():
        data=(O/name).read_bytes()
        req=urllib.request.Request(f'https://api.github.com/repos/{os.environ["REPOSITORY"]}/git/blobs',data=json.dumps({'content':base64.b64encode(data).decode(),'encoding':'base64'}).encode(),headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json','Content-Type':'application/json'},method='POST')
        with urllib.request.urlopen(req,timeout=60) as r: result=json.load(r)
        assert result['sha']==blob(data); out[path]=result['sha']
    (O/'verified-blobs.json').write_text(json.dumps(out,indent=2)); print(json.dumps(out))

if __name__=='__main__':
    if sys.argv[1]=='prepare': prepare()
    elif sys.argv[1]=='patch': patch_browser()
    elif sys.argv[1]=='check': results(sys.argv[2], len(sys.argv)>3 and sys.argv[3]=='fail')
    elif sys.argv[1]=='publish': publish()
