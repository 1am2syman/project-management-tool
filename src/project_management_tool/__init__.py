"""Tiny static server for the project-management prototype: `uv run project-management-tool`."""
import argparse
import contextlib
import functools
import http.server
import pathlib
import webbrowser

WEB = pathlib.Path(__file__).parent / "web"


def main() -> None:
    ap = argparse.ArgumentParser(description="Serve the sheet + gantt prototype")
    ap.add_argument("-p", "--port", type=int, default=5173)
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args()
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(WEB))
    with http.server.ThreadingHTTPServer(("127.0.0.1", a.port), handler) as srv:
        url = f"http://127.0.0.1:{a.port}/"
        print(f"Serving {url}  (Ctrl+C to stop)")
        if not a.no_open:
            webbrowser.open(url)
        with contextlib.suppress(KeyboardInterrupt):
            srv.serve_forever()
