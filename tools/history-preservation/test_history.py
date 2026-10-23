#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Exercise navigation-history preservation in an isolated native browser.

Requires marionette_driver. Run with a browser binary and an output directory:
python test_history.py --binary /path/to/waterfox --out /path/to/results
"""

import argparse
import json
import socket
import ssl
import subprocess
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from marionette_driver.marionette import Marionette


class LocalServer(ThreadingHTTPServer):
    def finish_request(self, request, client_address):
        request.settimeout(15)
        if request.recv(1, socket.MSG_PEEK) == b"\x16":
            connection = self.tls_context.wrap_socket(request, server_side=True)
            try:
                super().finish_request(connection, client_address)
            finally:
                connection.close()
        else:
            super().finish_request(request, client_address)


class Pages(BaseHTTPRequestHandler):
    redirects_enabled = True
    post_requests = []
    hold_next_frame = False
    held_frame_entered = threading.Event()
    held_frame_release = threading.Event()
    held_frame_requests = 0

    def log_message(self, *_args):
        pass

    def do_GET(self):
        path = urlsplit(self.path).path
        frame_request = 0
        if path == "/frame/held":
            type(self).held_frame_requests += 1
            frame_request = self.held_frame_requests
        if path in ("/frame/held", "/redirect/held-hop") and type(self).hold_next_frame:
            type(self).hold_next_frame = False
            self.held_frame_entered.set()
            self.held_frame_release.wait(20)
        redirects = {"/redirect/one": "/redirect/two", "/redirect/two": "/target"}
        redirects.update({
            "/cross/start": f"http://localhost:{self.server.server_port}/cross/hop",
            "/cross/hop": f"http://127.0.0.1:{self.server.server_port}/target",
            "/redirect/held-start": "/redirect/held-hop",
            "/redirect/held-hop": "/target",
        })
        if self.redirects_enabled and path in redirects:
            self.send_response(302 if path.endswith("one") else 301)
            self.send_header("Location", redirects[path])
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        body = {
            "/client/replace": '<script>location.replace("/target")</script>',
            "/client/assign": '<script>location.assign("/target")</script>',
            "/client/meta": '<meta http-equiv="refresh" content="0;url=/target">',
            "/frames/static": '<iframe src="/frame/one"></iframe>',
            "/frames/branch": '<iframe src="/frame/one"></iframe>',
            "/frames/two": '<iframe src="/frame/held"></iframe>'
            '<iframe src="/frame/last"></iframe>',
            "/frames/pair": '<iframe id="first" src="/frame/one"></iframe>'
            '<iframe id="last" src="/frame/last"></iframe>',
            "/frame/held": f'<html data-request="{frame_request}"><title>held</title>',
            "/frames/redirect": '<iframe src="/redirect/one"></iframe>',
            "/frames/mixed": '<iframe id="first" src="/frame/one"></iframe>'
            '<script>const frame = document.createElement("iframe");'
            'frame.src = "/frame/dynamic";document.body.append(frame);</script>'
            '<iframe id="last" src="/frame/last"></iframe>',
            "/frames/reordered": "<body><script>"
            "function dynamic() {"
            'const frame = document.createElement("iframe");'
            'frame.src = "/frame/dynamic";document.body.append(frame);}'
            "if (sessionStorage.earlyDynamic) dynamic();"
            'else addEventListener("load", dynamic, {once:true});'
            '</script><iframe id="first" src="/frame/one"></iframe>'
            '<iframe id="last" src="/frame/last"></iframe>',
            "/form": '<form method="post" action="/post/redirect">'
            '<input name="value" value="retained"></form>',
        }.get(path, f"<title>{path}</title><p>{path}</p>")
        payload = ("<!doctype html>" + body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        type(self).post_requests.append((urlsplit(self.path).path, body.decode()))
        if self.redirects_enabled and self.path == "/post/redirect":
            self.send_response(307)
            self.send_header("Location", "/post/target")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
        else:
            self.do_GET()


class HistoryTests(unittest.TestCase):
    browser = None
    origin = None
    binary = None
    output = None
    observations = []

    def chrome(self, script, args=(), asynchronous=False):
        with self.browser.using_context("chrome"):
            method = (
                self.browser.execute_async_script
                if asynchronous
                else self.browser.execute_script
            )
            return method(script, script_args=list(args))

    def set_pref(self, name, value):
        self.chrome(
            """
            const [name, value] = arguments;
            const prefs = Services.prefs;
            if (typeof value == "boolean") prefs.setBoolPref(name, value);
            else if (typeof value == "string") prefs.setStringPref(name, value);
            else prefs.setIntPref(name, value);
        """,
            (name, value),
        )

    def setUp(self):
        Pages.redirects_enabled = True
        Pages.post_requests = []
        Pages.hold_next_frame = False
        Pages.held_frame_entered.clear()
        Pages.held_frame_release.clear()
        self.chrome("""
            for (const name of ["browser.sessionhistory.max_entries",
                                "browser.sessionhistory.max_total_viewers",
                                "browser.sessionstore.max_serialize_back",
                                "browser.sessionstore.max_serialize_forward"])
                Services.prefs.clearUserPref(name);
            Services.prefs.setBoolPref("dom.security.https_only_mode", false);
            Services.prefs.setBoolPref("dom.security.https_only_mode.upgrade_local", false);
            Services.prefs.setBoolPref("browser.sessionhistory.preserve_entries", true);
            Services.prefs.setBoolPref("dom.navigation.webidl.enabled", true);
        """)
        self.original_handle = self.browser.current_window_handle
        tab = self.browser.open(type="tab", focus=True)
        self.browser.switch_to_window(tab["handle"])
        self.browser.set_context("content")

    def tearDown(self):
        Pages.held_frame_release.set()
        handles = self.browser.close()
        self.browser.switch_to_window(handles[0])

    def load(self, path):
        self.browser.navigate(self.origin + path)

    def back(self):
        self.chrome("gBrowser.selectedBrowser.goBack(false);")

    def wait_url(self, path):
        expected = self.origin + path
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.browser.get_url() == expected:
                return
            time.sleep(0.05)
        self.fail(f"Navigation did not reach {expected}; at {self.browser.get_url()}")

    def entries(self):
        return self.chrome("""
            const history = gBrowser.selectedBrowser.browsingContext.sessionHistory;
            return Array.from({length: history.count}, (_, index) =>
                history.getEntryAtIndex(index).URI.spec);
        """)

    def paths(self):
        return [
            urlsplit(url).path for url in self.entries() if url.startswith(self.origin)
        ]

    def wait_for(self, predicate):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.05)
        self.fail("Timed out waiting for history change")

    def navigation_paths(self):
        return self.browser.execute_script("""
            return navigation.entries().map(entry => new URL(entry.url).pathname);
        """)

    def loaded_navigation_snapshot(self, expected_url):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            receipt = self.browser.execute_script("""
                return {href: location.href, readyState: document.readyState,
                    current: navigation.currentEntry ? {
                        url: navigation.currentEntry.url,
                        index: navigation.currentEntry.index} : null,
                    entries: navigation.entries().map(entry => new URL(entry.url).pathname)};
            """)
            if (
                receipt is not None
                and receipt["href"] == expected_url
                and receipt["readyState"] == "complete"
            ):
                return receipt
            time.sleep(0.05)
        self.fail(f"No complete navigation snapshot for {expected_url}")

    def entry_trees(self):
        return self.chrome("""
            const history = gBrowser.selectedBrowser.browsingContext.sessionHistory;
            function tree(entry) {
                return {url: entry.URI.spec,
                        children: Array.from({length: entry.childCount}, (_, i) => {
                            const child = entry.GetChildAt(i);
                            return child ? tree(child) : null;
                        })};
            }
            return Array.from({length: history.count}, (_, i) =>
                tree(history.getEntryAtIndex(i)));
        """)

    def tab_state(self):
        return self.chrome(
            """
            const done = arguments[arguments.length - 1];
            const {TabStateFlusher} = ChromeUtils.importESModule(
                "resource:///modules/sessionstore/TabStateFlusher.sys.mjs");
            const {SessionStore} = ChromeUtils.importESModule(
                "resource:///modules/sessionstore/SessionStore.sys.mjs");
            TabStateFlusher.flush(gBrowser.selectedBrowser).then(() =>
                done(JSON.parse(SessionStore.getTabState(gBrowser.selectedTab))));
        """,
            asynchronous=True,
        )

    def test_server_redirect_chain_remains_revisitable(self):
        self.load("/page/start")
        self.load("/redirect/one")
        self.wait_url("/target")
        self.assertEqual(
            self.paths(), ["/page/start", "/redirect/one", "/redirect/two", "/target"]
        )
        Pages.redirects_enabled = False
        self.back()
        self.wait_url("/redirect/two")
        self.back()
        self.wait_url("/redirect/one")

    def test_first_navigation_redirect_chain_uses_initial_slot(self):
        self.load("/redirect/one")
        self.wait_url("/target")
        self.assertEqual(
            self.entries(),
            [
                self.origin + path
                for path in ("/redirect/one", "/redirect/two", "/target")
            ],
        )
        self.assertEqual(self.browser.execute_script("return history.length"), 3)
        self.assertEqual(self.navigation_paths(), self.paths())

    def test_initial_navigation_keeps_state_inserted_while_loading(self):
        Pages.hold_next_frame = True
        self.browser.execute_script(
            'location.href = arguments[0] + "/frame/held";', script_args=[self.origin]
        )
        self.assertTrue(Pages.held_frame_entered.wait(10))
        self.browser.execute_script('history.pushState({kept: true}, "", "#kept");')
        Pages.held_frame_release.set()
        self.wait_url("/frame/held")
        self.assertEqual(
            self.entries(),
            ["about:blank", "about:blank#kept", self.origin + "/frame/held"],
        )

    def test_revisiting_a_redirect_does_not_overwrite_its_entry(self):
        self.load("/page/start")
        self.load("/redirect/one")
        self.wait_url("/target")
        before = self.entries()
        self.back()
        self.wait_for(lambda: len(self.entries()) > len(before))
        self.wait_url("/target")
        after = self.entries()
        self.assertEqual(after[: len(before)], before)
        self.assertGreater(len(after), len(before))

    def test_redirect_navigation_entries_match_native_order(self):
        self.load("/page/start")
        self.load("/redirect/one")
        self.wait_url("/target")
        self.assertEqual(self.navigation_paths(), self.paths())
        self.assertEqual(
            self.browser.execute_script("return navigation.currentEntry.index"),
            len(self.paths()) - 1,
        )

    def test_cross_origin_redirects_are_not_exposed_to_destination(self):
        self.load("/page/start")
        self.load("/cross/start")
        self.wait_url("/target")
        self.assertEqual(
            [urlsplit(url).path for url in self.entries()],
            ["/page/start", "/cross/start", "/cross/hop", "/target"],
        )
        self.assertEqual(self.navigation_paths(), ["/target"])

    def test_new_origin_navigation_keeps_matching_forward_entry(self):
        other = self.origin.replace("127.0.0.1", "localhost")
        self.load("/page/start")
        self.browser.navigate(other + "/page/old")
        self.back()
        self.wait_url("/page/start")
        self.browser.navigate(other + "/page/new")
        snapshot = self.loaded_navigation_snapshot(other + "/page/new")
        self.assertEqual(snapshot["entries"], ["/page/new", "/page/old"])
        self.assertEqual(snapshot["current"]["index"], 0)
        self.assertTrue(self.browser.execute_script("return navigation.canGoForward"))

    def test_post_redirect_retains_method_and_body(self):
        self.set_pref("dom.confirm_repost.testing.always_accept", True)
        self.load("/form")
        self.browser.execute_script("document.forms[0].submit();")
        self.wait_url("/post/target")
        self.assertEqual(self.paths(), ["/form", "/post/redirect", "/post/target"])
        Pages.redirects_enabled = False
        before = len(Pages.post_requests)
        self.back()
        self.wait_url("/post/redirect")
        self.assertEqual(
            Pages.post_requests[before:], [("/post/redirect", "value=retained")]
        )

    def test_internal_https_upgrade_retains_both_addresses(self):
        self.set_pref("network.dns.localDomains", "history.example.com")
        self.set_pref("dom.security.https_only_mode", True)
        self.set_pref("dom.security.https_only_mode.upgrade_local", True)
        plain = (
            self.origin.replace("127.0.0.1", "history.example.com") + "/page/upgraded"
        )
        self.browser.navigate(plain)
        expected = plain.replace("http:", "https:")
        self.wait_for(lambda: self.browser.get_url() == expected)
        self.assertEqual(self.entries(), [plain, expected])

    def test_client_location_replace_keeps_source(self):
        self.load("/page/start")
        self.load("/client/replace")
        self.wait_url("/target")
        self.assertEqual(self.paths(), ["/page/start", "/client/replace", "/target"])

    def test_early_location_assign_keeps_source(self):
        self.load("/page/start")
        self.load("/client/assign")
        self.wait_url("/target")
        self.assertEqual(self.paths(), ["/page/start", "/client/assign", "/target"])

    def test_meta_refresh_keeps_source(self):
        self.load("/page/start")
        self.load("/client/meta")
        self.wait_url("/target")
        self.assertEqual(self.paths(), ["/page/start", "/client/meta", "/target"])

    def test_same_address_refresh_creates_new_entry(self):
        self.load("/page/refresh")
        self.browser.execute_script("""
            const meta = document.createElement("meta");
            meta.httpEquiv = "refresh";
            meta.content = "0";
            document.head.append(meta);
        """)
        self.wait_for(lambda: len(self.paths()) >= 2)
        self.assertEqual(self.paths(), ["/page/refresh"] * 2)

    def test_same_address_iframe_refresh_creates_new_entry(self):
        self.load("/frames/static")
        self.browser.execute_script("""
            const doc = frames[0].document;
            const meta = doc.createElement("meta");
            meta.httpEquiv = "refresh";
            meta.content = "0";
            doc.head.append(meta);
        """)
        self.wait_for(lambda: len(self.paths()) >= 2)
        self.assertEqual(self.paths(), ["/frames/static"] * 2)
        self.assertEqual(
            [
                urlsplit(entry["children"][0]["url"]).path
                for entry in self.entry_trees()
            ],
            ["/frame/one"] * 2,
        )

    def test_initial_iframe_redirect_chain_preserves_nested_entries(self):
        self.load("/frames/redirect")
        self.wait_for(
            lambda: self.browser.execute_script(
                'return frames.length && frames[0].location.pathname == "/target"'
            )
        )
        trees = self.entry_trees()
        self.assertEqual(
            [urlsplit(entry["children"][0]["url"]).path for entry in trees],
            ["/redirect/one", "/redirect/two", "/target"],
        )
        self.assertEqual(self.browser.execute_script("return history.length"), 3)

    def test_dynamic_frame_entries_survive_document_eviction(self):
        self.set_pref("browser.sessionhistory.max_total_viewers", 0)
        self.set_pref("browser.startup.page", 3)
        self.load("/frames/dynamic")
        self.browser.execute_async_script("""
            const done = arguments[arguments.length - 1];
            const frame = document.createElement("iframe");
            frame.onload = () => done();
            frame.src = "/frame/one";
            document.body.append(frame);
        """)
        self.browser.execute_script('frames[0].location.href = "/frame/two";')
        self.wait_for(
            lambda: self.browser.execute_script(
                'return frames[0].location.pathname == "/frame/two"'
            )
        )
        before = self.entry_trees()
        self.assertEqual(len(before), 2)
        self.load("/page/after")
        self.assertEqual(self.entry_trees()[:2], before)
        serialized = self.tab_state()["entries"]
        self.assertEqual(
            [urlsplit(entry["children"][0]["url"]).path for entry in serialized[:2]],
            ["/frame/one", "/frame/two"],
        )
        self.assertTrue(
            all(entry["children"][0]["dynamicallyAdded"] for entry in serialized[:2])
        )
        self.browser.restart(in_app=True)
        self.browser.set_context("content")
        self.wait_url("/page/after")
        self.assertEqual(self.entry_trees()[:2], before)
        self.set_pref("browser.sessionhistory.max_total_viewers", -1)

    def test_static_frame_history_remains_traversable_after_eviction(self):
        self.set_pref("browser.sessionhistory.max_total_viewers", 0)
        self.load("/frames/static")
        self.browser.execute_script('frames[0].location.href = "/frame/two";')
        self.wait_for(
            lambda: self.browser.execute_script(
                'return frames[0].location.pathname == "/frame/two"'
            )
        )
        self.load("/page/after")
        self.back()
        self.wait_url("/frames/static")
        self.wait_for(
            lambda: self.browser.execute_script(
                'return frames.length && frames[0].location.pathname == "/frame/two"'
            )
        )
        self.back()
        self.wait_for(
            lambda: self.browser.execute_script(
                'return frames[0].location.pathname == "/frame/one"'
            )
        )

    def test_mixed_frame_serialization_preserves_child_positions(self):
        self.load("/frames/mixed")
        trees = self.entry_trees()
        state = self.tab_state()
        native = trees[-1]["children"]
        self.assertTrue(
            any(child is None for child in native),
            "The interleaved frame fixture did not create an empty slot",
        )
        self.assertIn("children", state["entries"][-1])
        serialized = state["entries"][-1]["children"]
        self.assertEqual(
            [child["url"] if child else None for child in native],
            [child.get("url") for child in serialized],
        )

    def test_static_frames_restore_beside_retained_dynamic_frames(self):
        self.set_pref("browser.sessionhistory.max_total_viewers", 0)
        self.load("/frames/mixed")
        self.browser.execute_script("""
            document.getElementById("last").contentWindow.location.href = "/frame/last-next";
        """)
        self.wait_for(
            lambda: self.browser.execute_script("""
            return document.getElementById("last").contentWindow.location.pathname == "/frame/last-next";
        """)
        )
        self.load("/page/after")
        self.back()
        self.wait_url("/frames/mixed")
        self.wait_for(
            lambda: self.browser.execute_script("""
            return document.getElementById("last").contentWindow.location.pathname == "/frame/last-next";
        """)
        )

    def test_static_frames_match_when_dynamic_creation_order_changes(self):
        self.set_pref("browser.sessionhistory.max_total_viewers", 0)
        self.load("/frames/reordered")
        self.wait_for(lambda: self.browser.execute_script("return frames.length == 3"))
        self.browser.execute_script("""
            document.getElementById("first").contentWindow.location.href = "/frame/first-next";
        """)
        self.wait_for(
            lambda: self.browser.execute_script("""
            return document.getElementById("first").contentWindow.location.pathname == "/frame/first-next";
        """)
        )
        self.browser.execute_script("""
            document.getElementById("last").contentWindow.location.href = "/frame/last-next";
            sessionStorage.earlyDynamic = "yes";
        """)
        self.wait_for(
            lambda: self.browser.execute_script("""
            return document.getElementById("last").contentWindow.location.pathname == "/frame/last-next";
        """)
        )
        self.load("/page/after")
        self.back()
        self.wait_url("/frames/reordered")
        self.wait_for(
            lambda: self.browser.execute_script("""
            return frames.length == 3 &&
                document.getElementById("first").contentWindow.location.pathname == "/frame/first-next" &&
                document.getElementById("last").contentWindow.location.pathname == "/frame/last-next";
        """)
        )
        self.assertEqual(
            self.browser.execute_script("return frames[0].location.pathname"),
            "/frame/dynamic",
        )

    def test_trailing_empty_frame_slot_survives_session_round_trip(self):
        self.load("/frames/static")
        result = self.chrome("""
            const {SessionHistory} = ChromeUtils.importESModule(
                "resource://gre/modules/sessionstore/SessionHistory.sys.mjs");
            const history = gBrowser.selectedBrowser.browsingContext.sessionHistory;
            const entry = history.getEntryAtIndex(history.index);
            entry.AddChild(null, entry.childCount);
            const before = entry.childCount;
            const serialized = SessionHistory.collectFromParent(entry.URI, true, history);
            SessionHistory.restoreFromParent(history, serialized);
            const restored = history.getEntryAtIndex(history.index);
            return {before, after: restored.childCount,
                    lastIsNull: restored.GetChildAt(restored.childCount - 1) === null};
        """)
        self.assertEqual(result["before"], 2)
        self.assertEqual(result["after"], 2)
        self.assertTrue(result["lastIsNull"])

    def test_removed_static_sibling_does_not_renumber_retained_frames(self):
        self.set_pref("browser.sessionhistory.max_total_viewers", 0)
        self.load("/frames/pair")
        self.browser.execute_script("""
            document.getElementById("first").remove();
            document.getElementById("last").contentWindow.location.href = "/frame/last-next";
        """)
        self.wait_for(
            lambda: self.browser.execute_script(
                'return frames[0].location.pathname == "/frame/last-next"'
            )
        )
        self.load("/page/after")
        self.back()
        self.wait_url("/frames/pair")
        self.wait_for(
            lambda: self.browser.execute_script("""
            return frames.length == 2 &&
                document.getElementById("last").contentWindow.location.pathname == "/frame/last-next";
        """)
        )

    def test_mixed_frame_slot_round_trip_keeps_null_provenance(self):
        self.load("/frames/static")
        result = self.chrome("""
            const {SessionHistory} = ChromeUtils.importESModule(
                "resource://gre/modules/sessionstore/SessionHistory.sys.mjs");
            const history = gBrowser.selectedBrowser.browsingContext.sessionHistory;
            const entry = history.getEntryAtIndex(history.index);
            const state = SessionHistory.collectFromParent(entry.URI, true, history);
            const saved = state.entries[state.index - 1];
            const last = {...saved.children[0], staticChildOrdinal: 1};
            const dynamic = {...saved.children[0], dynamicallyAdded: true};
            delete dynamic.staticChildOrdinal;
            delete dynamic.docIdentifier;
            saved.children = [{}, last, dynamic, {}];
            SessionHistory.restoreFromParent(history, state);
            const serialized = SessionHistory.collectFromParent(entry.URI, true, history);
            return serialized.entries[serialized.index - 1].children.map(child => child.url ?
                {ordinal: child.staticChildOrdinal ?? -1, dynamic: !!child.dynamicallyAdded} : null);
        """)
        self.assertEqual(
            result,
            [
                None,
                {"ordinal": 1, "dynamic": False},
                {"ordinal": -1, "dynamic": True},
                None,
            ],
        )

    def branch_from_joint_frame_history(self, same_document):
        trace = {"test": self._testMethodName, "sameDocument": same_document}
        self.observations.append(trace)
        branch_path = "/frames/branch" if same_document else "/page/branch"
        self.set_pref("browser.startup.page", 3)
        self.load("/frames/static")
        self.browser.execute_script('frames[0].location.href = "/frame/two";')
        self.wait_for(
            lambda: self.browser.execute_script(
                'return frames[0].location.pathname == "/frame/two"'
            )
        )
        self.back()
        self.wait_for(
            lambda: self.browser.execute_script(
                'return frames[0].location.pathname == "/frame/one"'
            )
        )
        if same_document:
            self.assertEqual(
                self.browser.execute_script(
                    """
                    history.pushState({}, "", arguments[0]);
                    return history.length;
                """,
                    script_args=[branch_path],
                ),
                3,
            )
        else:
            self.load(branch_path)
        self.assertEqual(
            self.paths(), ["/frames/static", branch_path, "/frames/static"]
        )
        self.wait_for(
            lambda: (
                self.navigation_paths()
                == ["/frames/static", branch_path, "/frames/static"]
            )
        )
        keys = self.browser.execute_script(
            "return navigation.entries().map(entry => entry.key)"
        )
        self.assertEqual(len(set(keys)), 3)
        self.assertEqual(
            self.browser.execute_script("return navigation.currentEntry.index"), 1
        )
        trace["beforeRestart"] = self.entry_trees()
        trace["savedEntries"] = self.tab_state()["entries"]
        self.browser.restart(in_app=True)
        self.browser.set_context("content")
        self.wait_url(branch_path)
        trace["afterRestart"] = self.entry_trees()
        trace["framesAfterRestart"] = self.browser.execute_script(
            "return frames.length"
        )
        self.assertEqual(trace["framesAfterRestart"], 1 if same_document else 0)
        self.assertEqual(
            self.paths(), ["/frames/static", branch_path, "/frames/static"]
        )
        self.assertEqual(
            self.browser.execute_script(
                "return navigation.entries().map(entry => entry.key)"
            ),
            keys,
        )
        self.browser.execute_script("""
            const key = navigation.entries()[2].key;
            setTimeout(() => navigation.traverseTo(key), 0);
        """)
        self.wait_url("/frames/static")
        try:
            self.wait_for(
                lambda: self.browser.execute_script(
                    'return frames.length && frames[0].location.pathname == "/frame/two"'
                )
            )
        finally:
            trace["afterTraversal"] = self.entry_trees()
            trace["visibleFrame"] = self.browser.execute_script(
                "return frames.length ? frames[0].location.href : null"
            )
        self.assertEqual(
            self.browser.execute_script("return navigation.currentEntry.index"), 2
        )

    def test_cross_document_branch_splits_joint_entry_identity(self):
        self.branch_from_joint_frame_history(same_document=False)

    def test_same_document_branch_splits_joint_entry_identity(self):
        self.branch_from_joint_frame_history(same_document=True)

    def test_pending_frame_traversal_keeps_its_native_target(self):
        self.set_pref("browser.sessionhistory.max_total_viewers", 0)
        self.load("/frames/static")
        self.browser.execute_script('frames[0].location.href = "/frame/held";')
        self.wait_for(
            lambda: self.browser.execute_script(
                'return frames[0].location.pathname == "/frame/held"'
            )
        )
        self.back()
        self.wait_for(
            lambda: self.browser.execute_script(
                'return frames[0].location.pathname == "/frame/one"'
            )
        )
        Pages.hold_next_frame = True
        self.chrome("gBrowser.selectedBrowser.goForward(false);")
        self.assertTrue(
            Pages.held_frame_entered.wait(10),
            "Forward traversal did not request the held frame",
        )
        self.browser.execute_script('history.pushState({}, "", "/page/branch");')
        Pages.held_frame_release.set()
        self.wait_for(
            lambda: self.browser.execute_script(
                'return frames[0].location.pathname == "/frame/held"'
            )
        )
        snapshot = self.chrome("""
            const history = gBrowser.selectedBrowser.browsingContext.sessionHistory;
            return {index: history.index, current: history.getEntryAtIndex(history.index).URI.spec};
        """)
        self.assertEqual(self.browser.get_url(), snapshot["current"])
        self.assertEqual(snapshot["index"], 2)
        self.assertEqual(
            self.paths(),
            ["/frames/static", "/page/branch", "/page/branch", "/frames/static"],
        )
        self.wait_for(
            lambda: (
                self.navigation_paths()
                == ["/frames/static", "/page/branch", "/frames/static"]
            )
        )
        keys = self.browser.execute_script(
            "return navigation.entries().map(entry => entry.key)"
        )
        self.assertEqual(len(set(keys)), 3)
        self.assertEqual(
            self.browser.execute_script("return navigation.currentEntry.index"), 1
        )

    def test_pending_frame_reload_keeps_sibling_traversal_index(self):
        self.set_pref("browser.sessionhistory.max_total_viewers", 0)
        self.load("/frames/two")
        self.browser.execute_script('frames[1].location.href = "/frame/last-next";')
        self.wait_for(
            lambda: self.browser.execute_script(
                'return frames[1].location.pathname == "/frame/last-next"'
            )
        )
        self.back()
        self.wait_for(
            lambda: self.browser.execute_script(
                'return frames[1].location.pathname == "/frame/last"'
            )
        )
        before = self.browser.execute_script(
            "return Number(frames[0].document.documentElement.dataset.request)"
        )
        self.chrome(
            """
            const expected = arguments[0];
            window.__historyReloadReceipt = null;
            window.__historyReloadObserver = subject => {
                const channel = subject.QueryInterface(Ci.nsIChannel);
                if (channel.URI.spec != expected) return;
                window.__historyReloadReceipt = {
                    status: channel.status,
                    succeeded: Components.isSuccessCode(channel.status),
                    cancelled: channel.status == Cr.NS_BINDING_ABORTED,
                };
                Services.obs.removeObserver(window.__historyReloadObserver, "http-on-stop-request");
                delete window.__historyReloadObserver;
            };
            Services.obs.addObserver(window.__historyReloadObserver, "http-on-stop-request");
        """,
            [self.origin + "/frame/held"],
        )
        try:
            Pages.hold_next_frame = True
            self.browser.execute_script("frames[0].location.reload();")
            self.assertTrue(Pages.held_frame_entered.wait(10))
            self.chrome("gBrowser.selectedBrowser.goForward(false);")
            self.wait_for(
                lambda: self.browser.execute_script(
                    'return frames[1].location.pathname == "/frame/last-next"'
                )
            )
            Pages.held_frame_release.set()
            self.wait_for(
                lambda: self.chrome("return window.__historyReloadReceipt !== null;")
            )
            receipt = self.chrome("return window.__historyReloadReceipt;")
            self.observations.append({"test": self._testMethodName, "reload": receipt})
            if receipt["succeeded"]:
                self.wait_for(
                    lambda: self.browser.execute_script(
                        "return Number(frames[0].document.documentElement.dataset.request) > arguments[0]",
                        script_args=[before],
                    )
                )
            else:
                self.assertTrue(receipt["cancelled"], receipt)
            self.assertEqual(self.paths(), ["/frames/two", "/frames/two"])
            self.assertEqual(
                self.chrome(
                    "return gBrowser.selectedBrowser.browsingContext.sessionHistory.index;"
                ),
                1,
            )
        finally:
            if (
                self.observations
                and self.observations[-1]["test"] == self._testMethodName
            ):
                self.observations[-1]["frameAfterStop"] = (
                    self.browser.execute_script("""
                    return {request: Number(frames[0].document.documentElement.dataset.request),
                        url: frames[0].location.href,
                        readyState: frames[0].document.readyState,
                        body: frames[0].document.body.innerHTML};
                """)
                )
            self.chrome("""
                if (window.__historyReloadObserver)
                    Services.obs.removeObserver(window.__historyReloadObserver, "http-on-stop-request");
                delete window.__historyReloadObserver;
                delete window.__historyReloadReceipt;
            """)

    def test_replace_state_keeps_previous_addresses_and_states(self):
        self.load("/page/start")
        self.browser.execute_script("""
            history.replaceState({step: 1}, "", "/page/state");
            history.replaceState({step: 2}, "", "/page/state");
        """)
        self.assertEqual(self.paths(), ["/page/start", "/page/state", "/page/state"])
        self.back()
        self.wait_url("/page/state")
        self.wait_for(
            lambda: self.browser.execute_script(
                "return history.state && history.state.step == 1"
            )
        )
        self.assertEqual(
            self.browser.execute_script("return history.state"), {"step": 1}
        )
        self.back()
        self.wait_url("/page/start")

    def test_navigation_replace_keeps_previous_entry(self):
        self.load("/page/start")
        self.browser.execute_script("""
            setTimeout(() => navigation.navigate("/target", {history: "replace"}), 0);
        """)
        self.wait_url("/target")
        self.assertEqual(self.paths(), ["/page/start", "/target"])

    def test_navigation_state_updates_keep_previous_state(self):
        self.load("/page/start")
        self.browser.execute_script("""
            navigation.updateCurrentEntry({state: {step: 1}});
            navigation.updateCurrentEntry({state: {step: 2}});
        """)
        self.assertEqual(self.paths(), ["/page/start"] * 3)
        self.back()
        self.wait_for(
            lambda: self.browser.execute_script(
                "return navigation.currentEntry.getState().step == 1"
            )
        )
        self.assertEqual(
            self.browser.execute_script("return navigation.currentEntry.getState()"),
            {"step": 1},
        )

    def test_branching_does_not_delete_forward_entries(self):
        self.load("/page/start")
        self.browser.execute_script("""
            history.pushState({}, "", "/page/one");
            history.pushState({}, "", "/page/two");
        """)
        self.back()
        self.wait_url("/page/one")
        length = self.browser.execute_script("""
            history.pushState({}, "", "/page/branch");
            const length = history.length;
            history.forward();
            return length;
        """)
        self.assertEqual(length, 4)
        self.wait_url("/page/two")
        self.assertEqual(
            self.paths(), ["/page/start", "/page/one", "/page/branch", "/page/two"]
        )
        self.assertEqual(self.navigation_paths(), self.paths())

    def test_more_than_fifty_entries_remain_available(self):
        self.load("/page/start")
        self.browser.execute_script("""
            for (let step = 1; step <= 80; step++)
                history.pushState({step}, "", "/page/" + step);
        """)
        paths = self.paths()
        self.assertEqual(len(paths), 81)
        self.assertEqual(paths[0], "/page/start")

    def test_explicit_smaller_cap_remains_effective_after_branching(self):
        self.set_pref("browser.startup.page", 3)
        self.load("/page/start")
        self.set_pref("browser.sessionhistory.max_entries", 3)
        self.browser.execute_script("""
            for (let step = 1; step <= 5; step++)
                history.pushState({step}, "", "/page/" + step);
        """)
        self.assertEqual(self.paths(), ["/page/3", "/page/4", "/page/5"])
        self.back()
        self.wait_url("/page/4")
        self.browser.execute_script('history.pushState({}, "", "/page/branch");')
        self.assertEqual(self.paths(), ["/page/4", "/page/branch", "/page/5"])
        self.assertEqual(self.browser.execute_script("return history.length"), 3)
        self.wait_for(lambda: self.navigation_paths() == self.paths())
        self.browser.restart(in_app=True)
        self.browser.set_context("content")
        self.wait_url("/page/branch")
        self.browser.execute_script('history.pushState({}, "", "/page/after-restart");')
        self.assertEqual(
            self.paths(), ["/page/branch", "/page/after-restart", "/page/5"]
        )
        self.assertEqual(self.browser.execute_script("return history.length"), 3)

    def test_waterfox_defaults_enable_full_history_retention(self):
        defaults = self.chrome("""
            const expected = {
                "browser.sessionhistory.preserve_entries": true,
                "browser.sessionhistory.max_entries": 1000000000,
                "browser.sessionstore.max_serialize_back": -1,
                "browser.sessionstore.max_serialize_forward": -1,
                "browser.navigation.requireUserInteraction": false,
            };
            return Object.fromEntries(Object.entries(expected).map(([name, value]) => {
                Services.prefs.clearUserPref(name);
                return [name, typeof value == "boolean" ? Services.prefs.getBoolPref(name) :
                    Services.prefs.getIntPref(name)];
            }));
        """)
        self.assertEqual(
            defaults,
            {
                "browser.sessionhistory.preserve_entries": True,
                "browser.sessionhistory.max_entries": 1000000000,
                "browser.sessionstore.max_serialize_back": -1,
                "browser.sessionstore.max_serialize_forward": -1,
                "browser.navigation.requireUserInteraction": False,
            },
        )

    def test_default_back_includes_noninteractive_entries(self):
        self.load("/page/start")
        self.browser.execute_script("""
            history.pushState({}, "", "/page/one");
            history.pushState({}, "", "/page/two");
        """)
        self.chrome("gBrowser.selectedBrowser.goBack();")
        self.wait_url("/page/one")

    def test_session_serialization_retains_more_than_ten_back_entries(self):
        self.set_pref("browser.sessionhistory.max_entries", 1000000000)
        self.set_pref("browser.startup.page", 3)
        self.load("/page/start")
        self.browser.execute_script("""
            for (let step = 1; step <= 30; step++)
                history.pushState({step}, "", "/page/" + step);
        """)
        state = self.tab_state()
        paths = [
            urlsplit(entry["url"]).path
            for entry in state["entries"]
            if entry["url"].startswith(self.origin)
        ]
        self.assertEqual(len(paths), 31)
        self.assertEqual(paths[0], "/page/start")
        self.browser.restart(in_app=True)
        self.browser.set_context("content")
        self.wait_url("/page/30")
        self.assertEqual(len(self.paths()), 31)
        self.assertEqual(self.paths()[0], "/page/start")

    def test_replace_state_still_rejects_cross_origin_addresses(self):
        self.load("/page/start")
        before = self.entries()
        result = self.browser.execute_script("""
            try {
                history.replaceState({}, "", "https://example.invalid/");
                return "accepted";
            } catch (error) { return error.name; }
        """)
        self.assertEqual(result, "SecurityError")
        self.assertEqual(self.entries(), before)

    def test_disabled_policy_retains_upstream_replace_behavior(self):
        self.set_pref("browser.sessionhistory.preserve_entries", False)
        self.load("/page/start")
        self.browser.execute_script("""
            setTimeout(() => location.replace("/target"), 0);
        """)
        self.wait_url("/target")
        self.assertEqual(self.paths(), ["/target"])

    def test_explicit_history_purge_remains_available(self):
        self.load("/page/start")
        self.browser.execute_script("""
            history.pushState({}, "", "/page/one");
            history.pushState({}, "", "/page/two");
        """)
        self.chrome("""
            gBrowser.selectedBrowser.browsingContext.sessionHistory.purgeHistory(2);
        """)
        self.assertEqual(self.paths(), ["/page/two"])

    def test_history_clear_drops_pre_clear_redirect_addresses(self):
        self.load("/page/start")
        Pages.hold_next_frame = True
        self.browser.execute_script(
            'setTimeout(() => location.href = "/redirect/held-start", 0);'
        )
        self.assertTrue(Pages.held_frame_entered.wait(10))
        self.chrome("""
            const history = gBrowser.selectedBrowser.browsingContext.sessionHistory;
            history.purgeHistory(history.count);
        """)
        Pages.held_frame_release.set()
        self.wait_url("/target")
        self.assertEqual(self.paths(), ["/redirect/held-hop", "/target"])
        self.wait_for(lambda: self.navigation_paths() == self.paths())
        self.assertEqual(self.browser.execute_script("return history.length"), 2)

    def test_browser_clear_keeps_only_the_visible_current_entry(self):
        self.load("/page/start")
        self.browser.execute_script("""
            history.pushState({}, "", "/page/one");
            history.pushState({}, "", "/page/two");
        """)
        self.back()
        self.wait_url("/page/one")
        self.chrome("gBrowser.selectedBrowser.purgeSessionHistory();")
        self.wait_for(lambda: self.paths() == ["/page/one"])
        self.assertEqual(self.browser.get_url(), self.origin + "/page/one")
        self.assertEqual(
            self.chrome(
                "return gBrowser.selectedBrowser.browsingContext.sessionHistory.index;"
            ),
            0,
        )
        self.wait_for(lambda: self.navigation_paths() == ["/page/one"])
        self.assertEqual(self.browser.execute_script("return history.length"), 1)
        self.browser.execute_script('history.pushState({}, "", "/page/after");')
        self.assertEqual(self.paths(), ["/page/one", "/page/after"])

    def test_browser_clear_invalidates_pending_redirects_with_one_current_entry(self):
        self.load("/page/start")
        Pages.hold_next_frame = True
        self.browser.execute_script(
            'setTimeout(() => location.href = "/redirect/held-start", 0);'
        )
        self.assertTrue(Pages.held_frame_entered.wait(10))
        self.chrome("gBrowser.selectedBrowser.purgeSessionHistory();")
        Pages.held_frame_release.set()
        self.wait_url("/target")
        self.assertEqual(self.paths(), ["/page/start", "/redirect/held-hop", "/target"])

    def test_partial_purge_keeps_uncommitted_redirect_addresses(self):
        self.load("/page/old")
        self.load("/page/start")
        Pages.hold_next_frame = True
        self.browser.execute_script(
            'setTimeout(() => location.href = "/redirect/held-start", 0);'
        )
        self.assertTrue(Pages.held_frame_entered.wait(10))
        self.chrome(
            "gBrowser.selectedBrowser.browsingContext.sessionHistory.purgeHistory(1);"
        )
        Pages.held_frame_release.set()
        self.wait_url("/target")
        self.assertEqual(
            self.paths(),
            ["/page/start", "/redirect/held-start", "/redirect/held-hop", "/target"],
        )

    def test_forward_only_clear_is_saved_across_restart(self):
        self.set_pref("browser.startup.page", 3)
        self.load("/page/start")
        self.browser.execute_script("""
            history.pushState({}, "", "/page/one");
            history.pushState({}, "", "/page/two");
        """)
        self.tab_state()
        self.back()
        self.wait_url("/page/one")
        self.back()
        self.wait_url("/page/start")
        self.chrome("gBrowser.selectedBrowser.purgeSessionHistory();")
        self.assertEqual(self.paths(), ["/page/start"])
        self.assertEqual(
            [urlsplit(entry["url"]).path for entry in self.tab_state()["entries"]],
            ["/page/start"],
        )
        self.browser.restart(in_app=True)
        self.browser.set_context("content")
        self.wait_url("/page/start")
        self.assertEqual(self.paths(), ["/page/start"])

    def test_frame_traversal_completed_after_clear_creates_a_new_entry(self):
        self.set_pref("browser.sessionhistory.max_total_viewers", 0)
        self.load("/frames/static")
        self.browser.execute_script('frames[0].location.href = "/frame/held";')
        self.wait_for(
            lambda: self.browser.execute_script(
                'return frames[0].location.pathname == "/frame/held"'
            )
        )
        self.back()
        self.wait_for(
            lambda: self.browser.execute_script(
                'return frames[0].location.pathname == "/frame/one"'
            )
        )
        Pages.hold_next_frame = True
        self.chrome("gBrowser.selectedBrowser.goForward(false);")
        self.assertTrue(Pages.held_frame_entered.wait(10))
        self.chrome("gBrowser.selectedBrowser.purgeSessionHistory();")
        self.assertEqual(self.paths(), ["/frames/static"])
        Pages.held_frame_release.set()
        self.wait_for(
            lambda: self.browser.execute_script(
                'return frames[0].location.pathname == "/frame/held"'
            )
        )
        self.wait_for(lambda: len(self.paths()) == 2)
        self.assertEqual(
            urlsplit(self.entry_trees()[1]["children"][0]["url"]).path, "/frame/held"
        )
        self.assertEqual(
            self.chrome(
                "return gBrowser.selectedBrowser.browsingContext.sessionHistory.index;"
            ),
            1,
        )

    def test_top_traversal_completed_after_clear_creates_a_new_entry(self):
        self.set_pref("browser.sessionhistory.max_total_viewers", 0)
        self.load("/frame/held")
        self.load("/page/after")
        Pages.hold_next_frame = True
        self.back()
        self.assertTrue(Pages.held_frame_entered.wait(10))
        self.chrome("gBrowser.selectedBrowser.purgeSessionHistory();")
        self.assertEqual(self.paths(), ["/page/after"])
        Pages.held_frame_release.set()
        self.wait_url("/frame/held")
        self.wait_for(lambda: self.paths() == ["/page/after", "/frame/held"])

    def test_top_traversal_completed_after_full_purge_initializes_history(self):
        self.set_pref("browser.sessionhistory.max_total_viewers", 0)
        self.load("/frame/held")
        self.load("/page/after")
        Pages.hold_next_frame = True
        self.back()
        self.assertTrue(Pages.held_frame_entered.wait(10))
        self.chrome("""
            const history = gBrowser.selectedBrowser.browsingContext.sessionHistory;
            history.purgeHistory(history.count);
        """)
        self.assertEqual(self.paths(), [])
        Pages.held_frame_release.set()
        self.wait_url("/frame/held")
        self.wait_for(lambda: self.paths() == ["/frame/held"])
        self.assertEqual(self.browser.execute_script("return history.length"), 1)
        self.assertEqual(
            self.browser.execute_script("""
                history.pushState({}, "", "/page/new");
                return history.length;
            """),
            2,
        )
        self.assertEqual(self.paths(), ["/frame/held", "/page/new"])

    def test_private_history_is_not_written_to_session_files(self):
        private = Marionette(
            bin=self.binary,
            port=2829,
            prefs={
                "browser.privatebrowsing.autostart": True,
                "browser.sessionhistory.preserve_entries": True,
            },
            app_args=["--headless", "--remote-allow-system-access", "-purgecaches"],
            gecko_log=str(self.output / "private-gecko.log"),
        )
        try:
            private.start_session()
            private.timeout.script = 30
            private.navigate(self.origin + "/page/private")
            private.execute_script(
                'history.replaceState({private: true}, "", "/page/private-state");'
            )
            with private.using_context("chrome"):
                profile = private.execute_script("""
                    const {PrivateBrowsingUtils} = ChromeUtils.importESModule(
                        "resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
                    if (!PrivateBrowsingUtils.isWindowPrivate(window))
                        throw new Error("Expected a private window");
                    return Services.dirsvc.get("ProfD", Ci.nsIFile).path;
                """)
                private.execute_async_script("""
                    const done = arguments[arguments.length - 1];
                    const {SessionSaver} = ChromeUtils.importESModule(
                        "resource:///modules/sessionstore/SessionSaver.sys.mjs");
                    SessionSaver.run().then(() => done());
                """)
            shutdown = private.quit(in_app=True)
            self.assertFalse(shutdown["forced"])
            profile = Path(profile)
            self.assertTrue(profile.is_dir())
            self.assertFalse((profile / "sessionstore.jsonlz4").exists())
            self.assertEqual(
                list((profile / "sessionstore-backups").glob("*.jsonlz4")), []
            )
        finally:
            private.cleanup()

    def test_preservation_does_not_require_navigation_api(self):
        self.set_pref("dom.navigation.webidl.enabled", False)
        self.load("/page/start")
        self.browser.execute_script("""
            history.pushState({}, "", "/page/one");
            history.pushState({}, "", "/page/two");
        """)
        self.back()
        self.wait_url("/page/one")
        self.assertEqual(
            self.browser.execute_script("""
            history.pushState({}, "", "/page/branch");
            return history.length;
        """),
            4,
        )
        self.assertEqual(
            self.paths(), ["/page/start", "/page/one", "/page/branch", "/page/two"]
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--case", action="append", default=[])
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    certificate = args.out / "localhost-cert.pem"
    key = args.out / "localhost-key.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(key),
            "-out",
            str(certificate),
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost,DNS:history.example.com,IP:127.0.0.1",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    server = LocalServer(("127.0.0.1", 0), Pages)
    server.tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server.tls_context.load_cert_chain(certificate, key)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    browser = Marionette(
        bin=args.binary,
        app_args=["--headless", "--remote-allow-system-access", "-purgecaches"],
        gecko_log=str(args.out / "gecko.log"),
    )
    try:
        browser.start_session(capabilities={"acceptInsecureCerts": True})
        browser.timeout.script = 30
        browser.timeout.page_load = 30
        HistoryTests.browser = browser
        HistoryTests.origin = f"http://127.0.0.1:{server.server_port}"
        HistoryTests.binary = args.binary
        HistoryTests.output = args.out
        loader = unittest.TestLoader()
        suite = (
            unittest.TestSuite(HistoryTests(name) for name in args.case)
            if args.case
            else loader.loadTestsFromTestCase(HistoryTests)
        )
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        summary = {
            "tests": result.testsRun,
            "failures": [
                {"test": str(test), "traceback": failure}
                for test, failure in result.failures
            ],
            "errors": [
                {"test": str(test), "traceback": error} for test, error in result.errors
            ],
            "skipped": result.skipped,
            "observations": HistoryTests.observations,
            "successful": result.wasSuccessful(),
        }
        (args.out / "results.json").write_text(json.dumps(summary, indent=2) + "\n")
        return 0 if result.wasSuccessful() else 1
    finally:
        HistoryTests.browser = None
        browser.cleanup()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
