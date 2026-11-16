"""Shared native public-client authorization. No browser/HTTP dependency."""
import json
import re
from contextlib import contextmanager
from pathlib import Path

from . import AgentError, load_dependencies
from .graph import Graph, auth_error
from .protected import ProtectedState, private_root

CONFIG = Path(__file__).with_name("deployment.json")
SCOPES = ("User.Read", "Mail.Send")
GUID = re.compile(r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$", re.IGNORECASE)


def deployment(path=CONFIG):
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise AgentError("deployment_unconfigured", "The maintainer must ship Plan's native Microsoft application registration.") from None
    if not isinstance(config, dict) or set(config) != {"clientId", "tenant", "audience"}:
        raise AgentError("deployment_unconfigured", "The native Microsoft deployment configuration is invalid.")
    tenant = config.get("tenant", "")
    if not isinstance(config.get("clientId"), str) or not GUID.fullmatch(config["clientId"]) or config["clientId"] == "00000000-0000-0000-0000-000000000000":
        raise AgentError("deployment_unconfigured", "The maintainer must provision and ship a native Microsoft application ID.")
    if config["audience"] == "single-tenant" and isinstance(tenant, str) and GUID.fullmatch(tenant):
        return config
    if config["audience"] == "organizations" and tenant == "organizations":
        return config
    raise AgentError("deployment_unconfigured", "The maintainer must declare a supported organizational audience and authority.")


class NativeAuth:
    def __init__(self, data_dir=None, *, state=None, msal_module=None, config=None, graph=None):
        self.config = config if config is not None else deployment()
        self.state = state if state is not None else ProtectedState(private_root(data_dir))
        self.msal = msal_module if msal_module is not None else load_dependencies()
        self.graph = graph or Graph()

    @contextmanager
    def session(self):
        # Serialize the entire token/cache operation, reloading from disk each time.
        with self.state.transaction() as state:
            cache = self.msal.SerializableTokenCache()
            try:
                if state.get("cache"):
                    cache.deserialize(state["cache"])
            except (ValueError, TypeError):
                raise AgentError("cache_unavailable", "The native Microsoft cache is unreadable. Reconnect explicitly.") from None
            try:
                app = self.msal.PublicClientApplication(self.config["clientId"], authority=f"https://login.microsoftonline.com/{self.config['tenant']}", token_cache=cache, enable_broker_on_windows=False, timeout=30)
                yield state, app
            except AgentError as error:
                state["status"] = error.status()
                raise
            except OSError:
                error = AgentError("authorization_unavailable", "Cannot reach Microsoft sign-in. Pending work stays paused.")
                state["status"] = error.status()
                raise error from None
            finally:
                state["cache"] = cache.serialize()

    def status(self):
        # Read-only, no MSAL constructor, token acquisition or Graph calls.
        with self.state.transaction() as state:
            return {"account": state.get("account"), **state.get("status", {"state": "sign_in_required", "message": "Connect Microsoft 365."})}

    @staticmethod
    def identity(account, profile):
        values = (account.get("home_account_id"), account.get("realm"), profile.get("id"))
        if not all(isinstance(value, str) and value for value in values):
            raise AgentError("account_unavailable", "Microsoft did not return a stable tenant and account identity.")
        return {"homeAccountId": values[0], "tenantId": values[1], "graphId": values[2], "login": profile.get("userPrincipalName", ""), "email": profile.get("mail") or "", "name": profile.get("displayName", "")}

    def connect(self):
        """Interactive only: callers must invoke this on an explicit user action."""
        with self.session() as (state, app):
            result = app.acquire_token_interactive(scopes=list(SCOPES), prompt="select_account", timeout=180)
            if not isinstance(result, dict) or "access_token" not in result:
                raise auth_error(result if isinstance(result, dict) else None)
            profile = self.graph.profile(result["access_token"])
            claims = result.get("id_token_claims", {})
            accounts = [a for a in app.get_accounts() if a.get("local_account_id") == claims.get("oid") and a.get("realm") == claims.get("tid")]
            if len(accounts) != 1:
                raise AgentError("account_unavailable", "Microsoft returned an ambiguous native account. Reconnect.")
            identity = self.identity(accounts[0], profile)
            binding = {k: identity[k] for k in ("homeAccountId", "tenantId", "graphId")}
            if state.get("binding") and state["binding"] != binding:
                app.remove_account(accounts[0])
                raise AgentError("account_mismatch", "This data directory belongs to another reminder account. Explicit project rebinding is required before switching sender.")
            state.update(account=identity, binding=binding, status={"state": "connected", "message": "Native Microsoft 365 connected. Mailbox sending still needs a feasibility test."})
            return identity

    def disconnect(self):
        # The lock serializes this with renewal/submission; it cannot recall accepted mail.
        with self.state.transaction() as state:
            # Clear locally even when offline; do not contact Entra during disconnect.
            state.pop("cache", None)
            state.pop("account", None)
            state["status"] = {"state": "sign_in_required", "message": "Microsoft 365 disconnected. Already submitted mail cannot be recalled."}

    @contextmanager
    def authorized(self):
        with self.session() as (state, app):
            selected = state.get("account")
            if not selected:
                raise auth_error(None)
            matches = [a for a in app.get_accounts() if a.get("home_account_id") == selected["homeAccountId"] and a.get("realm") == selected["tenantId"]]
            if len(matches) != 1:
                raise AgentError("account_mismatch", "The native reminder account is no longer available. Reconnect the original account.")
            result = app.acquire_token_silent_with_error(scopes=list(SCOPES), account=matches[0])
            if not result or "access_token" not in result:
                raise auth_error(result)
            yield result["access_token"], selected

    def send_test(self, *, expected_binding=None, can_submit=None):
        with self.authorized() as (token, account):
            binding = {k: account[k] for k in ("homeAccountId", "tenantId", "graphId")}
            if expected_binding is not None and binding != expected_binding:
                raise AgentError("account_mismatch", "This test belongs to another native account.")
            # Recheck Graph identity and mailbox alias before every feasibility submission.
            profile = self.graph.profile(token)
            if profile["id"] != account["graphId"]:
                raise AgentError("account_mismatch", "Microsoft returned a different mailbox identity. Sending is paused.")
            if can_submit is not None and not can_submit():
                raise AgentError("paused", "The worker was paused or its source changed before submission.")
            return self.graph.send_test(token, {**account, "email": profile.get("mail") or ""})
