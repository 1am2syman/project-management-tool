"""Allowlisted Microsoft Graph operations and conservative submission outcomes."""
import http.client
import json
import uuid
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from . import AgentError

UTC = timezone.utc  # noqa: UP017 -- support Python 3.10 as declared in pyproject.toml.


def retry_delay(value, now=None):
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        try:
            target = parsedate_to_datetime(value)
            seconds = int((target - (now or datetime.now(UTC))).total_seconds())
        except (TypeError, ValueError, OverflowError):
            seconds = 60
    return max(1, min(86400, seconds))


def auth_error(result):
    """Interpret structured Entra evidence; never expose raw OAuth descriptions."""
    result = result or {}
    codes = {str(code) for code in result.get("error_codes", [])}
    error = result.get("error", "")
    if codes & {"90094", "900941", "900981"}:
        return AgentError("organization_approval_required", "Your organization must approve Plan's requested permissions.")
    if codes & {"50105", "7000112", "700016", "7000218"}:
        return AgentError("application_access_restricted", "Your organization or app maintainer must enable access to this application.")
    if codes & {"53000", "53001", "53003", "50097"}:
        return AgentError("organization_policy_required", "Your organization's device or sign-in policy requires attention.")
    if error == "access_denied":
        return AgentError("consent_denied", "Microsoft access was declined. Connect again when you are ready.")
    if error == "consent_required" or "65001" in codes:
        return AgentError("consent_required", "Connect Microsoft 365 to grant the required permission; organization approval may be needed.")
    if error in {"interaction_required", "login_required", "invalid_grant"} or codes & {"50076", "50079", "70043", "700082"}:
        return AgentError("sign_in_required", "Reconnect Microsoft 365 to continue.")
    if error in {"temporarily_unavailable", "server_error"}:
        return AgentError("authorization_unavailable", "Microsoft sign-in is temporarily unavailable. Try again later.")
    return AgentError("sign_in_required", "Connect Microsoft 365 to continue.")


class Graph:
    """Fixed host and operations; no arbitrary URL, headers or sender overrides."""
    def __init__(self, connection_factory=None):
        self.connection_factory = connection_factory or (lambda: http.client.HTTPSConnection("graph.microsoft.com", timeout=30))

    def _request(self, method, path, token, body=None, submission=False):
        connection = self.connection_factory()
        correlation = str(uuid.uuid4())
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        try:
            # A failure here is known to precede submission.
            connection.connect()
        except (OSError, http.client.HTTPException):
            connection.close()
            raise AgentError("network_unavailable", "Cannot reach Microsoft Graph.", 60) from None
        try:
            try:
                connection.request(method, path, body=payload, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "client-request-id": correlation, "return-client-request-id": "true"})
                response = connection.getresponse()
                raw = response.read(1024 * 1024 + 1)
            except (OSError, http.client.HTTPException):
                code = "uncertain" if submission else "network_unavailable"
                raise AgentError(code, "Microsoft submission outcome is unknown. Do not automatically resend." if submission else "Cannot read Microsoft Graph response.") from None
            if response.status == 202 and submission:
                return {"state": "accepted", "correlationId": correlation}
            if response.status == 429:
                raise AgentError("throttled", "Microsoft Graph requested a later retry.", retry_delay(response.getheader("Retry-After")))
            try:
                value = json.loads(raw) if raw and len(raw) <= 1024 * 1024 else {}
            except (ValueError, UnicodeError):
                value = {}
            code = value.get("error", {}).get("code", "") if isinstance(value, dict) and isinstance(value.get("error", {}), dict) else ""
            if code in {"MailboxNotEnabledForRESTAPI", "ErrorMailboxNotEnabledForRESTAPI", "ErrorInvalidUser", "ErrorNonExistentMailbox"}:
                raise AgentError("mailbox_unavailable", "This account does not have an accessible Exchange Online mailbox.")
            if response.status == 401:
                raise AgentError("sign_in_required", "Reconnect Microsoft 365 to continue.")
            if response.status == 403:
                raise AgentError("graph_access_denied", "Microsoft denied this operation. Check granted permissions and organization policy.")
            if submission and 200 <= response.status < 300:
                raise AgentError("uncertain", "Microsoft returned an unexpected submission response. Review before retrying.")
            if not 200 <= response.status < 300:
                if submission and response.status >= 500:
                    raise AgentError("uncertain", "Microsoft could not confirm the submission outcome. Review before retrying.")
                raise AgentError("graph_unavailable", "Microsoft Graph could not complete the requested operation.", 60 if response.status >= 500 else None)
            if not isinstance(value, dict) or len(raw) > 1024 * 1024:
                raise AgentError("graph_unavailable", "Microsoft Graph returned an invalid response.")
            return value
        finally:
            connection.close()

    def profile(self, token):
        profile = self._request("GET", "/v1.0/me?$select=id,displayName,mail,userPrincipalName", token)
        if not isinstance(profile.get("id"), str) or not profile["id"]:
            raise AgentError("account_unavailable", "Microsoft did not return a stable account identity.")
        return profile

    def send_test(self, token, profile):
        # Feasibility only: one fixed message to the connected mailbox. No recipient input.
        address = profile.get("email", "")
        if not isinstance(address, str) or "@" not in address or any(c in address for c in "\r\n"):
            raise AgentError("mailbox_unavailable", "Microsoft did not identify the connected account's primary mailbox address.")
        return self._request("POST", "/v1.0/me/sendMail", token, {
            "message": {"subject": "Plan native reminder feasibility test", "body": {"contentType": "Text", "content": "This explicitly requested test was submitted by Plan's native Windows connection. Verify receipt, sender, timestamp and Sent Items before marking the feasibility gate complete."}, "toRecipients": [{"emailAddress": {"address": address}}]},
            "saveToSentItems": True,
        }, submission=True)
