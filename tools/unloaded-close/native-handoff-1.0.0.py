"""Run browser-chrome test bodies in an isolated release browser.

Only test-framework helpers are adapted; browser behavior is not simulated.
"""
import json
from pathlib import Path
import sys
import traceback
from marionette_driver.marionette import Marionette

name = sys.argv[1]
test_files = sys.argv[2:]
artifacts = Path('artifacts')
client = Marionette(bin=str(Path('work/waterfox/waterfox').resolve()),
                    app_args=['--headless', '--remote-allow-system-access', '-purgecaches'],
                    gecko_log=str(artifacts / f'{name}-gecko.log'))
shim = r'''
const finished = arguments[arguments.length - 1];
const tasks = [];
const cleanups = [];
const registerCleanupFunction = fn => cleanups.push(fn);
const gBrowser = window.gBrowser;
const assertions = [];
const errors = [];
const prefStack = [];
let testName = "setup";
const record = (condition, message) => assertions.push({test: testName, pass: !!condition, message});
const ok = record;
const is = (actual, expected, message) => record(actual === expected, message);
const info = message => assertions.push({test:testName, info:message});
const add_task = fn => tasks.push(fn);
const requestLongerTimeout = () => {};
const pause = ms => new Promise(resolve => window.setTimeout(resolve, ms));
const waitForCondition = async (predicate, message = "condition") => {
  const limit = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > limit) throw new Error("Timeout: " + message);
    await pause(25);
  }
};
const TestUtils = {waitForCondition};
const PrivateBrowsingUtils = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs").PrivateBrowsingUtils;
const SpecialPowers = {
  async pushPrefEnv({set}) {
    const old = set.map(([name]) => [name, Services.prefs.prefHasUserValue(name), Services.prefs.getPrefType(name)]);
    for (const entry of old) {
      const [name, user, type] = entry;
      entry.push(!user ? null : type === 128 ? Services.prefs.getBoolPref(name) : type === 64 ? Services.prefs.getIntPref(name) : Services.prefs.getStringPref(name));
    }
    prefStack.push(old);
    for(const [name, value] of set) {
      if(typeof value === "boolean") Services.prefs.setBoolPref(name,value);
      else if(typeof value === "number") Services.prefs.setIntPref(name,value);
      else Services.prefs.setStringPref(name,value);
    }
    await pause(30);
  },
  async popPrefEnv() {
    for(const [name,user,type,value] of prefStack.pop()) {
      if(!user) Services.prefs.clearUserPref(name);
      else if(type === 128) Services.prefs.setBoolPref(name,value);
      else if(type === 64) Services.prefs.setIntPref(name,value);
      else Services.prefs.setStringPref(name,value);
    }
    await pause(30);
  }
};
const BrowserTestUtils = {
  addTab(gb, url = "about:blank", options = {}) { return gb.addTrustedTab(url, { ...options, skipAnimation:true }); },
  waitForCondition,
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
  },
  async openNewBrowserWindow(options) {
    const win = window.OpenBrowserWindow(options);
    await waitForCondition(() => win.gBrowserInit?.delayedStartupFinished, "window startup");
    await pause(150);
    return win;
  },
  async closeWindow(win) { win.close(); await waitForCondition(() => win.closed, "window closing"); },
  async browserLoaded(browser) {
    await waitForCondition(() => browser.currentURI.spec.startsWith("data:") && !browser.webProgress.isLoadingDocument, "test document load");
    await pause(50);
  },
  async switchTab(gb,tab) { gb.selectedTab=tab; await waitForCondition(() => gb.selectedTab===tab); await pause(100); },
  async removeTab(tab) { tab.documentGlobal.gBrowser.removeTab(tab,{animate:false}); await waitForCondition(() => !tab.isConnected,"tab removal"); await pause(50); }
};
'''
try:
    client.start_session()
    client.set_context('chrome')
    client.timeout.script = 600
    client.execute_script('Services.prefs.setBoolPref("browser.tabs.closeWindowWithLastTab",false); Services.prefs.setBoolPref("browser.tabs.warnOnClose",false);')
    metadata = client.execute_script('return {version:Services.appinfo.version,buildID:Services.appinfo.appBuildID,method:window.gBrowser._findTabToBlurTo.toString(),platform:Services.appinfo.OS};')
    (artifacts / f'{name}-runtime.json').write_text(json.dumps(metadata, indent=2))
    body = '\n'.join(Path(p).read_text().replace('"use strict";', '', 1) for p in test_files)
    suffix = r'''
(async () => {
  for (let i=0; i<tasks.length; i++) {
    testName = `${i+1}: ${tasks[i].name}`;
    try { await tasks[i](); }
    catch(e) { errors.push({test:testName,message:String(e),stack:e.stack}); }
  }
  for (const cleanup of cleanups.reverse()) { await cleanup(); }
  finished({tasks:tasks.length, assertions, errors});
})().catch(e => finished({fatal:String(e),stack:e.stack,assertions,errors}));
'''
    result = client.execute_async_script(shim + body + suffix, sandbox='system', new_sandbox=True)
    (artifacts / f'{name}-native.json').write_text(json.dumps(result, indent=2))
    failures = [a for a in result.get('assertions', []) if a.get('pass') is False]
    print(json.dumps({'run':name,'tasks':result.get('tasks'),'failures':failures,'errors':result.get('errors'),'fatal':result.get('fatal')},indent=2))
    failed = bool(failures or result.get('errors') or result.get('fatal'))
except Exception:
    traceback.print_exc()
    failed = True
finally:
    try:
        client.quit()
    except Exception:
        pass
sys.exit(1 if failed else 0)
