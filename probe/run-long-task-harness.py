#!/usr/bin/env python3
"""Headless Chromium regressions for MioWeave's long-task callback lifecycle.

This uses an isolated temporary Chromium profile and mock tools; no real local
MCP tool executes, and no DeepSeek conversation is created or modified.
"""
import html
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import tempfile
import threading
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BROWSER = shutil.which("chromium") or shutil.which("google-chrome")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *_args):
        pass


class HTTPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class BodyParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.attrs = {}

    def handle_starttag(self, tag, attrs):
        if tag == "body":
            self.attrs = dict(attrs)


def run_case(port, case):
    with tempfile.TemporaryDirectory(prefix="mioweave-browser-fixture-") as profile:
        url = f"http://127.0.0.1:{port}/probe/long-task-stability-harness.html?{case}"
        command = [
            BROWSER, "--headless=new", "--no-sandbox", "--disable-gpu",
            "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
            f"--user-data-dir={profile}", "--virtual-time-budget=18000", "--dump-dom", url,
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=55)
        assert result.returncode == 0, f"Chromium {case}: {result.stderr[-1600:]}"
        parser = BodyParser()
        parser.feed(result.stdout)
        assert "data-budget" in parser.attrs and "data-recovery" in parser.attrs, (
            f"missing test data for {case}: {result.stdout[-1700:]}"
        )
        budget = json.loads(html.unescape(parser.attrs["data-budget"]))
        report = json.loads(html.unescape(parser.attrs["data-recovery"]))
        assert budget["wasTruncated"] and budget["exitCode"] == 0
        assert budget["single"] < 9000 and budget["batch"] <= 24 * 1024, budget
        before = report["before"]
        after = report["restored"]["snapshot"]
        assert not before["orphan"] and not after["orphan"], report
        assert report["restored"]["before"] == report["restored"]["after"]
        assert after["persistedLarge"] < 30000, after
        if "unknown=1" in case:
            assert before["calls"] == after["calls"] == 0, report
            assert "Execution uncertain" in before["statuses"][-1], report
            assert "Inspect interrupted" in before["button"], report
        else:
            assert before["calls"] == after["calls"] == 3, report
            assert before["submitted"] == after["submitted"] == 1, report
            assert len(after["journalEntries"]) == 4, report
            if "echo=1" in case:
                assert before["statuses"] == after["statuses"] == ["Sent"] * 3, report
                assert before["buttonHidden"] and after["buttonHidden"], report
            else:
                assert before["phases"][0] == after["phases"][0] == "submitted", report
                assert "receipt unverified" in after["statuses"][0], report
                assert before["button"] == after["button"] == "Check receipt", report
        print(f"[PASS] {case}: {before['calls']} executions, {before['submitted']} submissions; "
              f"single={budget['single']}, batch={budget['batch']}, "
              f"recovered={after['phases']}")


def run_collapsed_callback_case(port):
    with tempfile.TemporaryDirectory(prefix="mioweave-callback-preview-") as profile:
        url = f"http://127.0.0.1:{port}/probe/collapsed-callback-harness.html"
        command = [
            BROWSER, "--headless=new", "--no-sandbox", "--disable-gpu",
            "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
            f"--user-data-dir={profile}", "--virtual-time-budget=4600", "--dump-dom", url,
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=40)
        assert result.returncode == 0, result.stderr[-1600:]
        parser = BodyParser()
        parser.feed(result.stdout)
        assert "data-collapsed" in parser.attrs, result.stdout[-1300:]
        report = json.loads(html.unescape(parser.attrs["data-collapsed"]))
        initial = report["initial"]
        assert initial["preview"]["hidden"] and initial["preview"]["projected"]
        assert initial["phase"] == "submitted", report
        for key in ("unknown", "toolMismatch", "example"):
            assert not initial[key]["hidden"] and not initial[key]["projected"], (key, report)
        assert report["expanded"]["phase"] == "sent" and report["expanded"]["preview"]["hidden"]
        assert report["remounted"]["phase"] == "sent" and report["remounted"]["preview"]["hidden"]
        assert not report["recycled"]["preview"]["hidden"]
        assert not report["recycled"]["preview"]["projected"]
        print("[PASS] collapsed callback preview, expanded receipt, remount, unrelated user text")


def run_ui_protocol_case(port, fixture, attribute):
    with tempfile.TemporaryDirectory(prefix="mioweave-ui-fixture-") as profile:
        url = f"http://127.0.0.1:{port}/probe/{fixture}"
        command = [
            BROWSER, "--headless=new", "--no-sandbox", "--disable-gpu",
            "--disable-dev-shm-usage", f"--user-data-dir={profile}",
            "--virtual-time-budget=4500", "--dump-dom", url,
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=40)
        assert result.returncode == 0, result.stderr[-1400:]
        parser = BodyParser()
        parser.feed(result.stdout)
        assert attribute in parser.attrs, result.stdout[-1600:]
        data = json.loads(html.unescape(parser.attrs[attribute]))
        if fixture.startswith("alternate"):
            for key in ("markdown", "direct", "preview"):
                assert data["initial"][key]["hidden"] and data["initial"][key]["projection"], (key, data)
                assert not data["disabled"][key]["hidden"] and not data["disabled"][key]["projection"], (key, data)
            for key in ("unrelated", "prose", "other"):
                assert not data["initial"][key]["hidden"], (key, data)
            assert data["initial"]["previewPhase"] == "submitted", data
            assert not data["recycled"]["markdown"]["hidden"], data
        else:
            assert data["cards"] == 1 and data["headerCount"] == 1, data
            assert data["before"] and data["after"] and data["realCode"], data
            assert data["preservedRealToolbar"] and data["sourceHidden"], data
        print(f"[PASS] {fixture}: protocol detection and native-code preservation")


def run_unknown_callback_case(port):
    with tempfile.TemporaryDirectory(prefix="mioweave-unknown-bubble-") as profile:
        url = f"http://127.0.0.1:{port}/probe/unknown-callback-dom-harness.html"
        cmd = [BROWSER, "--headless=new", "--no-sandbox", "--disable-gpu",
               "--disable-dev-shm-usage", f"--user-data-dir={profile}",
               "--virtual-time-budget=4600", "--dump-dom", url]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
        assert result.returncode == 0, result.stderr[-1200:]
        parser = BodyParser()
        parser.feed(result.stdout)
        assert "data-unknown-callback" in parser.attrs, result.stdout[-1400:]
        data = json.loads(html.unescape(parser.attrs["data-unknown-callback"]))
        initial = data["initial"]
        assert initial["rootVisible"], data
        for key in ("single", "batch", "clipped"):
            assert initial[key]["hidden"] or initial[key]["rowHidden"], (key, data)
            assert not data["disabled"][key]["hidden"], (key, data)
        assert initial["noBound"]["projection"] and not initial["noBound"]["rowHidden"], data
        for key in ("unrelated", "quote", "thinking"):
            assert not initial[key]["hidden"] and not initial[key]["projection"], (key, data)
        assert not data["recycled"]["single"]["hidden"]
        assert not data["recycled"]["single"]["projection"]
        print("[PASS] unknown DeepSeek classes: full/batch/clipped, provenance, config, recycled rows")


def main():
    assert BROWSER, "Chromium/Google Chrome executable not found"
    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        for case in ("echo=0", "echo=1", "echo=0&unknown=1"):
            run_case(server.server_address[1], case)
        run_collapsed_callback_case(server.server_address[1])
        run_ui_protocol_case(server.server_address[1], "alternate-callback-dom-harness.html", "data-alternate-callback")
        run_ui_protocol_case(server.server_address[1], "unclassed-fence-harness.html", "data-fence3")
        run_unknown_callback_case(server.server_address[1])
    print("[PASS] no real local MCP calls, no user conversation modified")


if __name__ == "__main__":
    main()
