"""Native phase-one regressions. All state is temporary; Graph and Scheduler are fakes."""
import base64
import copy
import hashlib
import json
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.client import HTTPConnection
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.project_management_tool import create_server
from src.project_management_tool.reminder_agent import AgentError
from src.project_management_tool.reminder_agent.auth import NativeAuth, deployment
from src.project_management_tool.reminder_agent.graph import (
    Graph,
    auth_error,
    retry_delay,
)
from src.project_management_tool.reminder_agent.protected import (
    DPAPI,
    ProtectedState,
    file_lock,
    source_id,
)
from src.project_management_tool.reminder_agent.registration import (
    NAMESPACE,
    Registration,
    configuration_matches,
    powershell,
    source_version,
    task_xml,
    verify_runtime,
)
from src.project_management_tool.reminder_agent.worker import ProbeLedger, run, tick
from tools.vendor_native_auth import compatible

ROOT = Path(__file__).resolve().parents[1]
CONFIG = {"clientId": "11111111-1111-1111-1111-111111111111", "tenant": "organizations", "audience": "organizations"}
ACCOUNT = {"home_account_id": "home.tenant", "realm": "tenant", "local_account_id": "oid"}
PROFILE = {"id": "oid", "mail": "mailbox@example.com", "userPrincipalName": "login@example.com", "displayName": "Test User"}
IDENTITY = {"homeAccountId": "home.tenant", "tenantId": "tenant", "graphId": "oid", "email": "mailbox@example.com", "login": "login@example.com", "name": "Test User"}
BINDING = {k: IDENTITY[k] for k in ("homeAccountId", "tenantId", "graphId")}


class TestProtector:
    """A deterministic, non-Windows test double; production has no fallback."""
    def encrypt(self, raw):
        return b"test-only:" + base64.b64encode(raw)

    def decrypt(self, raw):
        if not raw.startswith(b"test-only:"):
            raise ValueError("Invalid test envelope")
        return base64.b64decode(raw[10:])


class FakeCache:
    def __init__(self):
        self.value = "{}"

    def deserialize(self, value):
        json.loads(value)
        self.value = value

    def serialize(self):
        return self.value


class TemporaryState(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="Plan native Ω & ")
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)


class AuthTests(TemporaryState):
    def setUp(self):
        super().setUp()
        self.state = ProtectedState(self.root, TestProtector())
        self.app = Mock()
        self.app.get_accounts.return_value = [copy.deepcopy(ACCOUNT)]
        self.app.acquire_token_interactive.return_value = {"access_token": "secret-do-not-export", "id_token_claims": {"oid": "oid", "tid": "tenant"}}
        self.app.acquire_token_silent_with_error.return_value = {"access_token": "silent-secret"}
        self.msal = SimpleNamespace(SerializableTokenCache=FakeCache, PublicClientApplication=Mock(return_value=self.app))
        self.graph = Mock()
        self.graph.profile.return_value = copy.deepcopy(PROFILE)
        self.graph.send_test.return_value = {"state": "accepted", "correlationId": "correlation"}
        self.auth = NativeAuth(state=self.state, msal_module=self.msal, config=CONFIG, graph=self.graph)

    def test_connect_requests_only_mail_and_profile_and_preserves_alias_identity(self):
        self.assertEqual(self.auth.connect(), IDENTITY)
        self.assertEqual(self.app.acquire_token_interactive.call_args.kwargs["scopes"], ["User.Read", "Mail.Send"])
        self.assertFalse(self.msal.PublicClientApplication.call_args.kwargs["enable_broker_on_windows"])
        status = self.auth.status()
        self.assertEqual(status["account"], IDENTITY)
        self.assertNotIn("secret", json.dumps(status))
        self.assertNotIn("cache", status)

    def test_status_does_not_construct_msal_or_acquire_tokens(self):
        self.assertEqual(self.auth.status()["state"], "sign_in_required")
        self.msal.PublicClientApplication.assert_not_called()
        self.graph.profile.assert_not_called()

    def test_silent_send_is_bound_to_home_tenant_and_graph_identity(self):
        self.auth.connect()
        self.assertEqual(self.auth.send_test()["state"], "accepted")
        self.graph.send_test.assert_called_once_with("silent-secret", IDENTITY)
        self.app.acquire_token_silent_with_error.assert_called_once_with(scopes=["User.Read", "Mail.Send"], account=ACCOUNT)
        self.assertEqual(self.app.acquire_token_interactive.call_count, 1)

    def test_silent_failure_never_launches_interactive_auth(self):
        self.auth.connect()
        self.app.acquire_token_silent_with_error.return_value = {"error": "interaction_required", "error_description": "private-secret"}
        with self.assertRaises(AgentError) as failure:
            self.auth.send_test()
        self.assertEqual(failure.exception.code, "sign_in_required")
        self.assertNotIn("private-secret", str(failure.exception))
        self.assertEqual(self.app.acquire_token_interactive.call_count, 1)
        self.graph.send_test.assert_not_called()

    def test_graph_identity_mismatch_stops_submission(self):
        self.auth.connect()
        self.graph.profile.return_value = {**PROFILE, "id": "someone-else"}
        with self.assertRaises(AgentError) as failure:
            self.auth.send_test()
        self.assertEqual(failure.exception.code, "account_mismatch")
        self.graph.send_test.assert_not_called()

    def test_final_submission_guard_checks_pause_after_identity_lookup(self):
        self.auth.connect()
        with self.assertRaises(AgentError) as failure:
            self.auth.send_test(expected_binding=BINDING, can_submit=lambda: False)
        self.assertEqual(failure.exception.code, "paused")
        self.graph.profile.assert_called()
        self.graph.send_test.assert_not_called()

    def test_expected_owner_is_checked_inside_authorization_lock(self):
        self.auth.connect()
        with self.assertRaises(AgentError) as failure:
            self.auth.send_test(expected_binding={**BINDING, "homeAccountId": "old-owner"})
        self.assertEqual(failure.exception.code, "account_mismatch")
        self.graph.send_test.assert_not_called()

    def test_account_switch_does_not_rebind_after_disconnect(self):
        self.auth.connect()
        self.auth.disconnect()
        self.app.get_accounts.return_value = [{**ACCOUNT, "home_account_id": "different.home"}]
        with self.assertRaises(AgentError) as failure:
            self.auth.connect()
        self.assertEqual(failure.exception.code, "account_mismatch")
        with self.state.transaction() as state:
            self.assertEqual(state["binding"], BINDING)
            self.assertNotIn("account", state)
        self.app.remove_account.assert_called_once()

    def test_disconnect_clears_authorization_offline_and_keeps_binding(self):
        self.auth.connect()
        self.msal.PublicClientApplication.side_effect = OSError("private-token")
        self.auth.disconnect()
        with self.state.transaction() as state:
            self.assertNotIn("cache", state)
            self.assertNotIn("account", state)
            self.assertEqual(state["binding"], BINDING)
        with self.assertRaises(AgentError):
            self.auth.send_test()
        self.graph.send_test.assert_not_called()

    def test_each_session_reloads_cache_under_lock(self):
        self.auth.connect()
        with self.state.transaction() as state:
            state["cache"] = '{"updatedByOtherProcess":true}'
        with self.auth.session() as (state, _):
            self.assertEqual(json.loads(state["cache"]), {"updatedByOtherProcess": True})

    def test_corrupt_cache_is_preserved_without_plaintext_fallback(self):
        path = self.root / "connection.dpapi"
        path.write_bytes(b"corrupt")
        with self.assertRaises(AgentError) as failure:
            self.auth.status()
        self.assertEqual(failure.exception.code, "cache_unavailable")
        self.assertEqual(path.read_bytes(), b"corrupt")

    def test_concurrent_transactions_keep_every_update(self):
        def increment(_):
            with self.state.transaction() as state:
                state["count"] = state.get("count", 0) + 1
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(increment, range(20)))
        with self.state.transaction() as state:
            self.assertEqual(state["count"], 20)
        self.assertEqual(list(self.root.glob(".replace-*")), [])

    def test_lock_excludes_an_independent_process_and_releases_on_exit(self):
        script = """import sys
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from project_management_tool.reminder_agent import AgentError
from project_management_tool.reminder_agent.protected import file_lock
try:
    with file_lock(Path(sys.argv[2]), timeout=0):
        print('acquired')
except AgentError as error:
    print(error.code)
"""
        args = [sys.executable, "-I", "-B", "-c", script, str(ROOT / "src"), str(self.root / "process.lock")]
        with file_lock(self.root / "process.lock"):
            result = subprocess.run(args, capture_output=True, text=True, timeout=10, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "connection_busy")
        result = subprocess.run(args, capture_output=True, text=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "acquired")
        with file_lock(self.root / "process.lock", timeout=0):
            pass

    def test_oauth_classification_uses_error_codes_and_redacts_descriptions(self):
        fixtures = [({"error_codes": [90094]}, "organization_approval_required"), ({"error_codes": [50105]}, "application_access_restricted"), ({"error_codes": [53003]}, "organization_policy_required"), ({"error": "access_denied"}, "consent_denied"), ({"error": "consent_required"}, "consent_required"), ({"error": "interaction_required"}, "sign_in_required"), ({"error": "temporarily_unavailable"}, "authorization_unavailable")]
        for data, expected in fixtures:
            with self.subTest(expected=expected):
                error = auth_error({**data, "error_description": "secret@example.com token-value"})
                self.assertEqual(error.code, expected)
                self.assertNotIn("token-value", str(error))

    def test_deployment_rejects_missing_registration_and_untrusted_authorities(self):
        path = self.root / "deployment.json"
        for invalid in ({**CONFIG, "clientId": ""}, {**CONFIG, "tenant": "https://evil.example"}, {**CONFIG, "tenant": "consumers"}, {**CONFIG, "clientSecret": "do-not-use"}, {**CONFIG, "audience": "single-tenant"}):
            path.write_text(json.dumps(invalid))
            with self.assertRaises(AgentError):
                deployment(path)
        path.write_text(json.dumps(CONFIG))
        self.assertEqual(deployment(path), CONFIG)
        path.write_text(json.dumps({**CONFIG, "tenant": CONFIG["clientId"], "audience": "single-tenant"}))
        self.assertEqual(deployment(path)["audience"], "single-tenant")


class GraphTests(unittest.TestCase):
    def response(self, status, value=None, retry=None):
        response = Mock(status=status)
        response.read.return_value = json.dumps(value or {}).encode()
        response.getheader.return_value = retry
        connection = Mock()
        connection.getresponse.return_value = response
        return Graph(lambda: connection), connection

    def test_send_uses_only_me_sender_primary_alias_and_sent_items(self):
        graph, connection = self.response(202)
        self.assertEqual(graph.send_test("token", IDENTITY)["state"], "accepted")
        args, kwargs = connection.request.call_args
        self.assertEqual(args, ("POST", "/v1.0/me/sendMail"))
        payload = json.loads(kwargs["body"])
        self.assertIs(payload["saveToSentItems"], True)
        self.assertNotIn("from", payload["message"])
        self.assertEqual(payload["message"]["toRecipients"], [{"emailAddress": {"address": "mailbox@example.com"}}])
        connection.close.assert_called_once()

    def test_failure_before_submission_is_safely_retryable(self):
        graph, connection = self.response(202)
        connection.connect.side_effect = OSError("secret")
        with self.assertRaises(AgentError) as failure:
            graph.send_test("token", IDENTITY)
        self.assertEqual(failure.exception.code, "network_unavailable")
        connection.request.assert_not_called()

    def test_transport_failure_after_submission_begins_is_uncertain(self):
        for stage in ("request", "getresponse"):
            graph, connection = self.response(202)
            getattr(connection, stage).side_effect = TimeoutError("secret")
            with self.assertRaises(AgentError) as failure:
                graph.send_test("token", IDENTITY)
            self.assertEqual(failure.exception.code, "uncertain")
            self.assertNotIn("secret", str(failure.exception))
            self.assertEqual(connection.request.call_count, 1)

    def test_throttling_and_authorization_are_not_blindly_retried(self):
        for status, expected in ((429, "throttled"), (401, "sign_in_required"), (403, "graph_access_denied"), (503, "uncertain")):
            graph, connection = self.response(status, retry="120")
            with self.assertRaises(AgentError) as failure:
                graph.send_test("token", IDENTITY)
            self.assertEqual(failure.exception.code, expected)
            self.assertEqual(connection.request.call_count, 1)
            if status == 429:
                self.assertEqual(failure.exception.retry_after, 120)

    def test_mailbox_failure_is_distinct_from_login(self):
        graph, _ = self.response(404, {"error": {"code": "MailboxNotEnabledForRESTAPI", "message": "secret"}})
        with self.assertRaises(AgentError) as failure:
            graph.send_test("token", IDENTITY)
        self.assertEqual(failure.exception.code, "mailbox_unavailable")
        self.assertNotIn("secret", str(failure.exception))

    def test_unexpected_success_status_is_not_claimed_as_accepted(self):
        graph, _ = self.response(200)
        with self.assertRaises(AgentError) as failure:
            graph.send_test("token", IDENTITY)
        self.assertEqual(failure.exception.code, "uncertain")

    def test_missing_mail_alias_is_not_assumed_from_login(self):
        graph, connection = self.response(202)
        with self.assertRaises(AgentError):
            graph.send_test("token", {**IDENTITY, "email": ""})
        connection.request.assert_not_called()

    def test_retry_after_bounds(self):
        self.assertEqual(retry_delay("120"), 120)
        self.assertEqual(retry_delay("-1"), 1)
        self.assertEqual(retry_delay("99999999"), 86400)
        self.assertEqual(retry_delay("nonsense"), 60)


class RegistrationTests(TemporaryState):
    def test_windows_path_identity_normalizes_case_and_separators(self):
        self.assertEqual(source_id(r"C:\Plan Data\..\Plan Data", True), source_id("c:/plan data/", True))
        self.assertNotEqual(source_id(r"C:\Plan Data", True), source_id(r"D:\Plan Data", True))

    def test_xml_contains_only_least_privilege_current_user_logon_and_safe_arguments(self):
        sid = "S-1-5-21-1-2-3-1001"
        root = self.root / 'install Ω & $` (space)'
        xml = task_xml(self.root, sid, root=root)
        document = ET.fromstring(xml)  # noqa: S314 -- generated in this test.
        ns = {"t": NAMESPACE}
        def text(path):
            return document.findtext(path, default="", namespaces=ns)
        self.assertEqual(text("t:Principals/t:Principal/t:LogonType"), "InteractiveToken")
        self.assertEqual(text("t:Principals/t:Principal/t:RunLevel"), "LeastPrivilege")
        self.assertEqual(text("t:Triggers/t:LogonTrigger/t:UserId"), sid)
        self.assertEqual(len(document.findall("t:Triggers/*", ns)), 1)
        expected = {"ExecutionTimeLimit": "PT0S", "MultipleInstancesPolicy": "IgnoreNew", "DisallowStartIfOnBatteries": "false", "StopIfGoingOnBatteries": "false", "WakeToRun": "false", "RunOnlyIfNetworkAvailable": "false"}
        for key, value in expected.items():
            self.assertEqual(text(f"t:Settings/t:{key}"), value)
        self.assertEqual(text("t:Actions/t:Exec/t:Command"), str(root / "runtime/windows-x64/pythonw.exe"))
        self.assertIn('"' + str(root / "reminder-agent.py") + '"', text("t:Actions/t:Exec/t:Arguments"))
        self.assertIn("--data-dir", text("t:Actions/t:Exec/t:Arguments"))
        self.assertNotIn("BootTrigger", xml)
        self.assertTrue(configuration_matches(xml, xml))
        for old, new in (("LeastPrivilege", "HighestAvailable"), ("PT0S", "PT72H"), ("InteractiveToken", "S4U"), ("IgnoreNew", "Parallel")):
            self.assertFalse(configuration_matches(xml.replace(old, new), xml))
        self.assertFalse(configuration_matches("<!DOCTYPE Task [<!ENTITY a 'x'>]><Task>&a;</Task>", xml))
        self.assertFalse(configuration_matches("invalid", xml))

    def test_idempotent_install_repairs_relocation_and_remove_stops_task(self):
        stored = {}
        calls = []
        def runner(payload):
            action = payload["action"]
            calls.append(action)
            if action == "query":
                return {"installed": bool(stored), "xml": stored.get("xml", "")}
            if action == "install":
                stored["xml"] = payload["xml"]
            if action == "remove":
                self.assertTrue((self.root / "feasibility.paused").exists())
                stored.clear()
            return {"installed": bool(stored)}
        registration = Registration(self.root, root=self.root, sid="S-1-5-21-1", runner=runner, runtime_check=lambda: None)
        registration.install()
        registration.install()
        self.assertEqual(calls.count("install"), 1)
        stored["xml"] = stored["xml"].replace("reminder-agent.py", "old-folder.py")
        registration.install()
        self.assertEqual(calls.count("install"), 2)
        self.assertFalse((self.root / "feasibility.paused").exists())
        self.assertEqual(registration.remove()["state"], "paused")
        self.assertFalse(stored)

    def test_failed_install_leaves_manual_and_old_workers_paused(self):
        runner = Mock(side_effect=[{"installed": False}, AgentError("device_policy_blocked", "Denied")])
        registration = Registration(self.root, root=self.root, sid="S-1-5-21-1", runner=runner, runtime_check=lambda: None)
        with self.assertRaises(AgentError):
            registration.install()
        self.assertTrue((self.root / "feasibility.paused").exists())

    def test_runtime_is_actually_checked_before_registration(self):
        fake = SimpleNamespace(returncode=0)
        with patch("src.project_management_tool.reminder_agent.registration.sys.platform", "win32"), patch("src.project_management_tool.reminder_agent.registration.subprocess.run", return_value=fake) as process:
            verify_runtime()
        args = process.call_args.args[0]
        self.assertEqual(args[0], str(ROOT / "runtime/windows-x64/python.exe"))
        self.assertEqual(args[1:4], ["-I", "-B", "-c"])
        self.assertIn("load_dependencies()", args[4])
        checker = Mock(side_effect=AgentError("dependencies_unavailable", "Restore bundle"))
        runner = Mock()
        registration = Registration(self.root, root=self.root, sid="S-1-5-21-1", runner=runner, runtime_check=checker)
        with self.assertRaises(AgentError):
            registration.install()
        runner.assert_not_called()

    def test_powershell_encodes_unicode_and_metacharacters_as_data(self):
        payload = {"action": "query", "name": "Plan Ω & $`' test", "sid": "S-1-5-21-1"}
        fake = SimpleNamespace(returncode=0, stdout=b'{"installed":false}')
        with patch("src.project_management_tool.reminder_agent.registration.sys.platform", "win32"), patch("src.project_management_tool.reminder_agent.registration.subprocess.run", return_value=fake) as process:
            self.assertFalse(powershell(payload)["installed"])
        args, kwargs = process.call_args
        script = base64.b64decode(args[0][-1]).decode("utf-16-le")
        self.assertNotIn(payload["name"], script)
        self.assertIn(base64.b64encode(json.dumps(payload).encode()).decode(), script)
        self.assertIn("RegisterTaskDefinition($p.name, $definition, 6, $p.sid, $null, 3, $null)", script)
        self.assertNotIn("RunAs", script)
        self.assertEqual(kwargs["creationflags"], 0x08000000)
        self.assertNotIn("shell", kwargs)

    def test_policy_failure_is_not_ready_or_elevated(self):
        fake = SimpleNamespace(returncode=1, stdout=b'{"error":"registration_failed","hresult":-2147024891}')
        with patch("src.project_management_tool.reminder_agent.registration.sys.platform", "win32"), patch("src.project_management_tool.reminder_agent.registration.subprocess.run", return_value=fake), self.assertRaises(AgentError) as failure:
            powershell({"action": "install"})
        self.assertEqual(failure.exception.code, "device_policy_blocked")


class WorkerTests(TemporaryState):
    def setUp(self):
        super().setUp()
        self.ledger = ProbeLedger(self.root)
        self.owner = json.dumps(BINDING, sort_keys=True)
        self.auth = Mock()
        self.auth.status.return_value = {"account": IDENTITY}
        self.auth.send_test.return_value = {"state": "accepted", "correlationId": "fixed-correlation"}

    def test_queued_test_sends_without_server_or_project_database(self):
        self.ledger.queue(self.owner)
        tick(self.root, self.ledger, lambda: self.auth)
        self.assertEqual(self.ledger.activity()[0]["state"], "accepted")
        self.assertEqual(self.ledger.activity()[0]["correlation"], "fixed-correlation")
        tick(self.root, self.ledger, lambda: self.auth)
        self.auth.send_test.assert_called_once()
        self.assertFalse((self.root / "plan.db").exists())

    def test_crash_after_claim_does_not_resubmit(self):
        self.ledger.queue(self.owner)
        self.ledger.claim()
        self.ledger.recover()
        self.assertEqual(self.ledger.activity()[0]["state"], "uncertain")
        tick(self.root, self.ledger, lambda: self.auth)
        self.auth.send_test.assert_not_called()
        with self.assertRaises(AgentError):
            self.ledger.queue(self.owner)

    def test_ambiguous_send_is_not_retried(self):
        self.ledger.queue(self.owner)
        self.auth.send_test.side_effect = AgentError("uncertain", "Unknown")
        tick(self.root, self.ledger, lambda: self.auth)
        tick(self.root, self.ledger, lambda: self.auth)
        self.assertEqual(self.ledger.activity()[0]["state"], "uncertain")
        self.auth.send_test.assert_called_once()

    def test_concurrent_claims_take_only_one_job(self):
        self.ledger.queue(self.owner)
        with ThreadPoolExecutor(max_workers=4) as pool:
            claims = list(pool.map(lambda _: self.ledger.claim(), range(4)))
        self.assertEqual(sum(item is not None for item in claims), 1)

    def test_changed_account_or_paused_task_never_submits(self):
        for pause in (False, True):
            with self.subTest(pause=pause):
                self.ledger.queue(self.owner)
                self.auth.status.return_value = {"account": {**IDENTITY, "homeAccountId": "different"}}
                if pause:
                    (self.root / "feasibility.paused").touch()
                tick(self.root, self.ledger, lambda: self.auth)
                self.assertEqual(self.ledger.activity()[0]["state"], "failed")
        self.auth.send_test.assert_not_called()

    def test_old_test_expires_instead_of_sending_late(self):
        with patch("src.project_management_tool.reminder_agent.worker.time.time", return_value=time.time() - 7200):
            self.ledger.queue(self.owner)
        tick(self.root, self.ledger, lambda: self.auth)
        self.assertEqual(self.ledger.activity()[0]["state"], "expired")
        self.auth.send_test.assert_not_called()

    def test_old_source_exits_before_submitting(self):
        self.ledger.queue(self.owner)
        run(self.root, "obsolete-version", root=self.root, auth_factory=lambda: self.auth)
        self.assertEqual(json.loads((self.root / "feasibility-health.json").read_text())["state"], "source_changed")
        self.auth.send_test.assert_not_called()
        self.assertEqual(self.ledger.activity()[0]["state"], "pending")

    def test_future_schema_is_not_overwritten(self):
        with self.ledger.connection() as database:
            database.execute("PRAGMA user_version=999")
        with self.assertRaises(AgentError) as failure:
            ProbeLedger(self.root)
        self.assertEqual(failure.exception.code, "ledger_version_unsupported")
        with self.ledger.connection() as database:
            self.assertEqual(database.execute("PRAGMA user_version").fetchone()[0], 999)

    def test_singleton_does_not_recover_another_live_workers_submission(self):
        self.ledger.queue(self.owner)
        self.ledger.claim()
        with file_lock(self.root / "feasibility-worker.lock"):
            run(self.root, source_version(), root=self.root, auth_factory=lambda: self.auth)
        self.assertEqual(self.ledger.activity()[0]["state"], "submitting")
        self.auth.send_test.assert_not_called()


class FeasibilityHTTPTests(TemporaryState):
    def setUp(self):
        super().setUp()
        self.server = create_server(0, self.root, reminder_feasibility=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.port = self.server.server_port
        self.origin = f"http://127.0.0.1:{self.port}"

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)

    def request(self, action="status", *, method="GET", headers=None, body=None):
        with closing(HTTPConnection("127.0.0.1", self.port, timeout=5)) as connection:
            connection.request(method, "/api/reminder-feasibility/" + action, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, json.loads(response.read())

    def test_normal_server_does_not_expose_native_controls(self):
        server = create_server(0, self.root / "normal")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with closing(HTTPConnection("127.0.0.1", server.server_port, timeout=5)) as connection:
                connection.request("GET", "/api/reminder-feasibility/status")
                response = connection.getresponse()
                self.assertEqual(response.status, 404)
                self.assertIn("not enabled", json.loads(response.read())["error"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)
        self.assertFalse((self.root / "normal/plan.db").exists())

    def test_status_is_available_without_auth_and_never_reads_projects(self):
        with patch("src.project_management_tool.reminder_agent.service.private_root", return_value=self.root), patch("src.project_management_tool.reminder_agent.service.NativeAuth", side_effect=AgentError("deployment_unconfigured", "Maintainer registration required")), patch("src.project_management_tool.reminder_agent.service.Registration", side_effect=AgentError("device_policy_blocked", "Denied")):
            status, value = self.request()
        self.assertEqual(status, 200)
        self.assertFalse(value["projectScheduling"])
        self.assertEqual(value["authorization"]["state"], "deployment_unconfigured")
        self.assertEqual(value["task"]["state"], "device_policy_blocked")
        self.assertFalse((self.root / "plan.db").exists())
        self.assertNotIn("access_token", json.dumps(value))

    def test_mutations_require_exact_origin_host_and_empty_json(self):
        with patch("src.project_management_tool.reminder_agent.service.FeasibilityService.action", return_value={"state": "connected"}) as action:
            for headers, body, expected in [({}, "{}", 403), ({"Origin": "http://evil.example", "Content-Type": "application/json"}, "{}", 403), ({"Origin": self.origin, "Content-Type": "text/plain"}, "{}", 415), ({"Origin": self.origin, "Content-Type": "application/json"}, '{"url":"https://evil.example"}', 400), ({"Origin": self.origin, "Content-Type": "application/json"}, "{", 400)]:
                self.assertEqual(self.request("connect", method="POST", headers=headers, body=body)[0], expected)
            action.assert_not_called()
            self.assertEqual(self.request("connect", method="POST", headers={"Origin": self.origin, "Content-Type": "application/json"}, body="{}")[0], 200)
            action.assert_called_once_with("connect")
            self.assertEqual(self.request(headers={"Host": "evil.example"})[0], 403)

    def test_unknown_proxy_or_command_is_rejected(self):
        with patch("src.project_management_tool.reminder_agent.service.FeasibilityService.action") as action:
            for target in ("graph", "run", "../install", "https://evil.example", "install?command=anything"):
                status, _ = self.request(target, method="POST", headers={"Origin": self.origin, "Content-Type": "application/json"}, body="{}")
                self.assertIn(status, {400, 404})
            action.assert_not_called()


class BundleTests(unittest.TestCase):
    def test_vendored_files_checksums_provenance_licenses_and_platform(self):
        root = ROOT / "runtime/native-auth/windows-x64"
        manifest = json.loads((root / "manifest.json").read_text())
        lock = json.loads((ROOT / "tools/native-auth-wheels.json").read_text())
        self.assertEqual(manifest["artifacts"], lock["artifacts"])
        actual = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file() and "__pycache__" not in p.parts}
        self.assertEqual(actual, set(manifest["files"]) | {"manifest.json"})
        for name, expected in manifest["files"].items():
            self.assertEqual(hashlib.sha256((root / name).read_bytes()).hexdigest(), expected, name)
        for artifact in lock["artifacts"]:
            self.assertGreater(compatible(artifact["filename"]), 0)
            self.assertTrue(artifact["url"].startswith("https://files.pythonhosted.org/"))
            self.assertRegex(artifact["sha256"], r"^[0-9a-f]{64}$")
            normalized = artifact["name"].replace("-", "_")
            licenses = list((root / f"{normalized}-{artifact['version']}.dist-info").rglob("LICENSE*"))
            self.assertTrue(licenses, artifact["name"])
        for path in root.rglob("*.pyd"):
            raw = path.read_bytes()
            self.assertEqual(raw[:2], b"MZ")
            position = struct.unpack_from("<I", raw, 0x3c)[0]
            self.assertEqual(struct.unpack_from("<H", raw, position + 4)[0], 0x8664)
        for incompatible in ("pkg-1-cp314-cp314t-win_amd64.whl", "pkg-1-cp314-cp314-win32.whl", "pkg-1-cp315-cp315-win_amd64.whl", "pkg-1-cp314-cp314-manylinux_x86_64.whl"):
            self.assertEqual(compatible(incompatible), 0)

    @unittest.skipUnless(sys.platform == "win32", "Windows native dependency execution requires Windows")
    def test_bundled_interpreter_imports_native_auth_offline_with_isolation(self):
        script = "import sys; sys.path.insert(0, sys.argv[1]); from project_management_tool.reminder_agent import load_dependencies; m=load_dependencies(); assert m.__version__ == '1.39.0'; print('offline native authentication imports passed')"
        result = subprocess.run([str(ROOT / "runtime/windows-x64/python.exe"), "-I", "-B", "-c", script, str(ROOT / "src")], capture_output=True, text=True, timeout=30, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("offline native authentication imports passed", result.stdout)

    @unittest.skipUnless(sys.platform == "win32", "DPAPI requires Windows")
    def test_actual_current_user_dpapi_roundtrip_and_corruption(self):
        protector = DPAPI()
        raw = b"isolated-test-credential"
        encrypted = protector.encrypt(raw)
        self.assertNotIn(raw, encrypted)
        self.assertEqual(protector.decrypt(encrypted), raw)
        with self.assertRaises(AgentError):
            protector.decrypt(b"invalid")

    @unittest.skipIf(sys.platform == "win32", "Other platforms must fail closed")
    def test_non_windows_has_no_plaintext_credential_fallback(self):
        with self.assertRaises(AgentError) as failure:
            DPAPI().encrypt(b"secret")
        self.assertEqual(failure.exception.code, "unsupported_platform")


if __name__ == "__main__":
    unittest.main()
