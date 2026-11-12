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


def run_panel_diagnostics_case(port):
    with tempfile.TemporaryDirectory(prefix="mioweave-panel-diagnostics-") as profile:
        url = f"http://127.0.0.1:{port}/probe/panel-diagnostics-harness.html"
        cmd = [BROWSER, "--headless=new", "--no-sandbox", "--disable-gpu",
               "--disable-dev-shm-usage", f"--user-data-dir={profile}",
               "--virtual-time-budget=2600", "--dump-dom", url]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
        assert result.returncode == 0, result.stderr[-1200:]
        parser = BodyParser()
        parser.feed(result.stdout)
        assert "data-diagnostics" in parser.attrs, result.stdout[-1400:]
        report = json.loads(html.unescape(parser.attrs["data-diagnostics"]))
        assert report["controlsExist"] and report["noSecretInReport"], report
        assert report["hiddenWhenEnabled"], report
        assert report["visibleWhenDisabled"], report
        print("[PASS] inline callback diagnostics and settings; no callback data exposed")


def run_journal_first_case(port):
    with tempfile.TemporaryDirectory(prefix="mioweave-write-ahead-") as profile:
        url = f"http://127.0.0.1:{port}/probe/journal-first-harness.html"
        cmd = [BROWSER, "--headless=new", "--no-sandbox", "--disable-gpu",
               "--disable-dev-shm-usage", f"--user-data-dir={profile}",
               "--virtual-time-budget=5400", "--dump-dom", url]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
        assert result.returncode == 0, result.stderr[-1400:]
        parser = BodyParser()
        parser.feed(result.stdout)
        assert "data-journal-first" in parser.attrs, result.stdout[-1300:]
        data = json.loads(html.unescape(parser.attrs["data-journal-first"]))
        assert data["beforeAck"]["count"] == 0, data
        after = data["afterAck"]
        assert after["count"] == 1 and after["acknowledged"], data
        assert "not executed" in after["refused"] and not after["failedSaved"], data
        assert after["successfulSaved"] == "result-ready", data
        assert data["navigated"]["before"] == data["navigated"]["count"] == 1, data
        assert "page changed" in data["navigated"]["label"], data
        failed = data["continuingFailure"]
        assert not failed["sent"] and failed["clicks"] == 0, data
        assert "recovery unavailable" in failed["state"], data
        draft = data["changedDraft"]
        assert not draft["sent"] and draft["clicks"] == 0, data
        assert draft["preserved"] and draft["journalPhase"] == "result-ready", data
        assert "Draft changed" in draft["label"], data
        restored = data["recovery"]
        assert restored["phase"] == "submitted" and "uncertain" in restored["label"], data
        assert restored["count"] == restored["afterClick"] == 1, data
        assert data["batchBefore"]["calls"] == data["batchAfter"]["calls"] == 1, data
        assert data["batchBefore"]["clicks"] == data["batchAfter"]["clicks"] == 0, data
        assert "check" in data["batchBefore"]["button"].lower(), data
        assert "Unverified" in data["batchAfter"]["button"], data
        assert data["idCollision"] == {"phase":"collision","disabled":True,"noExtraCalls":True}, data
        assert data["idMismatchOnReload"] == {"phase":"collision","disabled":True}, data
        assert data["noChat"]["count"] == 1 and "not executed" in data["noChat"]["label"], data
        print("[PASS] write-ahead tool/callback journal, failures fail closed, crash no-resend")


def run_theme_scope_cases(port):
    for system_dark in (False, True):
        for width, height in ((390, 844), (640, 360)):
            with tempfile.TemporaryDirectory(prefix="mioweave-theme-scope-") as profile:
                cmd = [BROWSER, "--headless=new", "--no-sandbox", "--disable-gpu",
                       "--disable-dev-shm-usage", f"--user-data-dir={profile}",
                       f"--window-size={width},{height}", "--virtual-time-budget=2000",
                       "--dump-dom",
                       f"http://127.0.0.1:{port}/probe/theme-scope-harness.html"]
                if system_dark:
                    cmd.insert(1, "--force-dark-mode")
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
                assert result.returncode == 0, result.stderr[-1200:]
                parser = BodyParser()
                parser.feed(result.stdout)
                assert "data-theme-scope" in parser.attrs, result.stdout[-1600:]
                report = json.loads(html.unescape(parser.attrs["data-theme-scope"]))
                assert "error" not in report, report
                assert report["systemDark"] == system_dark, report
                assert report["approvalInViewport"], report
                for state in report["states"]:
                    assert state["cardDark"] == state["buttonDark"] == state["panelDark"] == state["dark"], state
                    assert state["errorDistinct"] and state["minContrast"] >= 4.5, state
                    assert state["panelInViewport"] and not state["overlap"] and not state["overflow"], state
    print("[PASS] host/OS theme independence, same-frame theme changes, contrast, narrow labels and bounded overlays")


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
        run_panel_diagnostics_case(server.server_address[1])
        run_journal_first_case(server.server_address[1])
        run_theme_scope_cases(server.server_address[1])
    print("[PASS] no real local MCP calls, no user conversation modified")


if __name__ == "__main__":
    main()
