"""Narrow local interface for the opt-in phase-one test harness."""
import json
import time

from . import AgentError
from .auth import NativeAuth
from .protected import private_root
from .registration import Registration
from .worker import ProbeLedger


class FeasibilityService:
    def __init__(self, data_dir):
        self.data_dir = data_dir

    def status(self):
        result = {"mode": "feasibility_only", "projectScheduling": False}
        try:
            root = private_root(self.data_dir)
        except (AgentError, OSError) as error:
            result["worker"] = error.status() if isinstance(error, AgentError) else {"state": "state_unavailable", "message": "Cannot access private native reminder state."}
            return result
        for key, function in (("authorization", lambda: NativeAuth(self.data_dir).status()), ("task", lambda: Registration(self.data_dir).status())):
            try:
                result[key] = function()
            except AgentError as error:
                result[key] = error.status()
            except OSError:
                result[key] = {"state": "state_unavailable", "message": "Cannot inspect private reminder state."}
        path = root / "feasibility-health.json"
        try:
            health = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
            recent = 0 <= time.time() - float(health.get("heartbeat", 0)) < 150
            state = health.get("state", "stopped")
            if state == "feasibility_only" and not recent:
                state = "stopped"
            if (root / "feasibility.paused").exists():
                state = "paused"
            result["worker"] = {"state": state, "heartbeat": health.get("heartbeat"), "recent": recent}
            error_path = root / "feasibility-error.json"
            if error_path.exists() and error_path.stat().st_mtime > float(health.get("heartbeat", 0)):
                # Do not reflect arbitrary file contents; the CLI records bounded codes.
                result["worker"]["error"] = "The native feasibility runner stopped. Inspect feasibility-error.json locally."
            result["activity"] = ProbeLedger(root).activity()
        except AgentError as error:
            result["worker"] = error.status()
        except (OSError, ValueError, TypeError):
            result["worker"] = {"state": "state_unavailable", "message": "Cannot read feasibility activity."}
        return result

    def action(self, action):
        if action == "connect":
            NativeAuth(self.data_dir).connect()
            return {"state": "connected"}
        if action == "disconnect":
            NativeAuth(self.data_dir).disconnect()
            return {"state": "disconnected"}
        if action == "install":
            return Registration(self.data_dir).install()
        if action == "remove":
            return Registration(self.data_dir).remove()
        if action == "send-test":
            auth = NativeAuth(self.data_dir)
            account = auth.status().get("account")
            if not account:
                raise AgentError("sign_in_required", "Connect Microsoft 365 before requesting a mail test.")
            if not Registration(self.data_dir).status()["configurationCurrent"]:
                raise AgentError("task_not_ready", "Install the feasibility task before requesting a mail test.")
            owner = json.dumps({k: account[k] for k in ("homeAccountId", "tenantId", "graphId")}, sort_keys=True)
            return ProbeLedger(private_root(self.data_dir)).queue(owner)
        raise AgentError("unsupported_operation", "Unknown feasibility operation.")
