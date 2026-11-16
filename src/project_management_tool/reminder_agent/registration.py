"""Standard-user Task Scheduler feasibility task; no password or elevation."""
import base64
import hashlib
import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from . import AgentError
from .protected import atomic_write, current_sid, file_lock, private_root, source_id

NAMESPACE = "http://schemas.microsoft.com/windows/2004/02/mit/task"
ROOT = Path(__file__).resolve().parents[3]


def source_version():
    digest = hashlib.sha256()
    for path in sorted(Path(__file__).parent.glob("*")):
        if path.suffix in {".py", ".json"}:
            digest.update(path.name.encode())
            digest.update(path.read_bytes())
    entry = ROOT / "reminder-agent.py"
    if entry.exists():
        digest.update(entry.read_bytes())
    manifest = ROOT / "runtime/native-auth/windows-x64/manifest.json"
    if manifest.exists():
        digest.update(manifest.read_bytes())
    return digest.hexdigest()


def task_name(data_dir, sid):
    return f"Plan.ReminderFeasibility.{sid}.{source_id(data_dir)}"


def task_xml(data_dir, sid, root=ROOT):
    ET.register_namespace("", NAMESPACE)
    task = ET.Element("Task", {"version": "1.4", "xmlns": NAMESPACE})

    def add(parent, tag, text=None):
        element = ET.SubElement(parent, tag)
        element.text = text
        return element

    info = add(task, "RegistrationInfo")
    add(info, "Description", "Plan native reminder feasibility probe. Does not schedule project mail.")
    trigger = add(add(task, "Triggers"), "LogonTrigger")
    add(trigger, "Enabled", "true")
    add(trigger, "UserId", sid)
    principal = add(add(task, "Principals"), "Principal")
    principal.set("id", "CurrentUser")
    add(principal, "UserId", sid)
    add(principal, "LogonType", "InteractiveToken")
    add(principal, "RunLevel", "LeastPrivilege")
    settings = add(task, "Settings")
    for key, value in {"MultipleInstancesPolicy": "IgnoreNew", "DisallowStartIfOnBatteries": "false", "StopIfGoingOnBatteries": "false", "AllowHardTerminate": "true", "StartWhenAvailable": "true", "RunOnlyIfNetworkAvailable": "false", "RunOnlyIfIdle": "false", "AllowStartOnDemand": "true", "Enabled": "true", "Hidden": "true", "ExecutionTimeLimit": "PT0S", "WakeToRun": "false"}.items():
        add(settings, key, value)
    restart = add(settings, "RestartOnFailure")
    add(restart, "Interval", "PT1M")
    add(restart, "Count", "10")
    actions = add(task, "Actions")
    actions.set("Context", "CurrentUser")
    action = add(actions, "Exec")
    add(action, "Command", str(root / "runtime/windows-x64/pythonw.exe"))
    add(action, "Arguments", subprocess.list2cmdline(["-B", str(root / "reminder-agent.py"), "run", "--data-dir", str(Path(data_dir).resolve()), "--source-version", source_version()]))
    add(action, "WorkingDirectory", str(root))
    return ET.tostring(task, encoding="unicode")


def configuration_matches(actual, expected):
    """Task Scheduler may add defaults; compare every requested field and trigger/action count."""
    if any(len(value) > 131072 or "<!" in value for value in (actual, expected)):
        return False
    try:
        # Local Task Scheduler XML and our generated definition; reject all DTDs above.
        left = ET.fromstring(actual)  # noqa: S314 -- bounded local XML, DTD/entity declarations rejected.
        right = ET.fromstring(expected)  # noqa: S314 -- generated XML, DTD/entity declarations rejected.
    except ET.ParseError:
        return False

    def contains(actual_node, wanted):
        if actual_node.tag != wanted.tag or any(actual_node.get(k) != v for k, v in wanted.attrib.items()):
            return False
        if len(wanted) == 0:
            return (actual_node.text or "").strip() == (wanted.text or "").strip()
        if wanted.tag.endswith(("}Actions", "}Triggers", "}Principals")) and len(actual_node) != len(wanted):
            return False
        for child in wanted:
            candidates = actual_node.findall(child.tag)
            if len(candidates) != 1 or not contains(candidates[0], child):
                return False
        return True

    return contains(left, right)


# Data is base64 JSON; paths and XML are never inserted as PowerShell syntax.
SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Get-ActualHResult($record) {
  $exception = $record.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  return $exception.HResult
}
try {
  $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $folder = $service.GetFolder('\')
  $task = $null
  try { $task = $folder.GetTask($p.name) } catch {
    if ((Get-ActualHResult $_) -ne -2147024894) { throw }
  }
  if ($p.action -eq 'query') {
    if ($null -eq $task) { @{installed=$false} | ConvertTo-Json -Compress }
    else { @{installed=$true; xml=$task.Xml; state=$task.State; lastResult=$task.LastTaskResult} | ConvertTo-Json -Compress }
  } elseif ($p.action -eq 'install') {
    if ($null -ne $task) {
      $task.Stop(0)
      if ($task.GetInstances(0).Count -ne 0) { throw 'Previous task is still stopping' }
    }
    $definition = $service.NewTask(0)
    $definition.XmlText = $p.xml
    $task = $folder.RegisterTaskDefinition($p.name, $definition, 6, $p.sid, $null, 3, $null)
    @{installed=$true} | ConvertTo-Json -Compress
  } elseif ($p.action -eq 'start') {
    if ($null -eq $task) { throw 'Task missing' }
    $null = $task.Run($null)
    @{installed=$true} | ConvertTo-Json -Compress
  } elseif ($p.action -eq 'remove') {
    if ($null -ne $task) {
      $task.Stop(0)
      if ($task.GetInstances(0).Count -ne 0) { throw 'Task is still stopping' }
      $folder.DeleteTask($p.name, 0)
    }
    @{installed=$false} | ConvertTo-Json -Compress
  } else { throw 'Unsupported operation' }
} catch {
  @{error='registration_failed'; hresult=(Get-ActualHResult $_)} | ConvertTo-Json -Compress
  exit 1
}
"""


def powershell(payload):
    if sys.platform != "win32":
        raise AgentError("unsupported_platform", "Task Scheduler requires Windows.")
    encoded_data = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
    encoded_script = base64.b64encode(SCRIPT.replace("__PAYLOAD__", encoded_data).encode("utf-16-le")).decode("ascii")
    try:
        result = subprocess.run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded_script], capture_output=True, timeout=30, creationflags=0x08000000, check=False)
        value = json.loads(result.stdout.decode("utf-8-sig"))
        if result.returncode or not isinstance(value, dict) or "error" in value:
            if isinstance(value, dict) and value.get("hresult") == -2147024891:
                raise AgentError("device_policy_blocked", "Windows denied background task setup. Ask your device administrator about Task Scheduler policy.")
            raise AgentError("registration_failed", "Windows could not configure the background task. Inspect Task Scheduler; local planning remains available.")
        return value
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise AgentError("registration_unavailable", "Cannot contact Windows Task Scheduler. No elevation was requested.") from None


def verify_runtime():
    """Actually import the bundled native dependencies before registering a task."""
    if sys.platform != "win32":
        raise AgentError("unsupported_platform", "Native runtime verification requires Windows.")
    executable = ROOT / "runtime/windows-x64/python.exe"
    if not executable.is_file() or not (executable.parent / "pythonw.exe").is_file():
        raise AgentError("runtime_missing", "Restore Plan's complete bundled Windows runtime.")
    script = "import sys; sys.path.insert(0, sys.argv[1]); from project_management_tool.reminder_agent import load_dependencies; load_dependencies()"
    try:
        result = subprocess.run([str(executable), "-I", "-B", "-c", script, str(ROOT / "src")], capture_output=True, timeout=20, creationflags=0x08000000, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise AgentError("runtime_unavailable", "Windows could not run Plan's bundled native runtime.") from None
    if result.returncode:
        raise AgentError("dependencies_unavailable", "Plan's native authentication bundle could not load. Restore the complete Windows release.")


class Registration:
    def __init__(self, data_dir, *, root=None, sid=None, runner=None, runtime_check=None):
        self.data_dir = Path(data_dir).resolve()
        self.root = root if root is not None else private_root(data_dir)
        self.sid = sid if sid is not None else current_sid()
        self.name = task_name(self.data_dir, self.sid)
        self.runner = runner or powershell
        self.runtime_check = runtime_check or verify_runtime

    def call(self, action, **extra):
        return self.runner({"action": action, "name": self.name, "sid": self.sid, **extra})

    def status(self):
        value = self.call("query")
        return {"installed": value.get("installed", False), "configurationCurrent": bool(value.get("installed") and configuration_matches(value.get("xml", ""), task_xml(self.data_dir, self.sid))), "taskState": value.get("state"), "lastResult": value.get("lastResult")}

    def install(self):
        with file_lock(self.root / "registration.lock"):
            self.runtime_check()
            expected = task_xml(self.data_dir, self.sid)
            value = self.call("query")
            if not value.get("installed") or not configuration_matches(value.get("xml", ""), expected):
                # Leave paused if repair fails. Existing/manual instances observe the marker.
                atomic_write(self.root / "feasibility.paused", b"paused")
                self.call("install", xml=expected)
            if not self.status()["configurationCurrent"]:
                raise AgentError("registration_failed", "Windows did not retain the requested task configuration.")
            (self.root / "feasibility.paused").unlink(missing_ok=True)
            self.call("start")
            return self.status()

    def remove(self):
        with file_lock(self.root / "registration.lock"):
            atomic_write(self.root / "feasibility.paused", b"paused")
            self.call("remove")
            if self.call("query").get("installed"):
                raise AgentError("registration_failed", "Windows has not removed automatic startup. Sending remains paused.")
            return {"installed": False, "state": "paused"}
