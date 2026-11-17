# Bundled Windows Python

`windows-x64/` contains the complete, unmodified **CPython 3.14.10 Windows x64 embeddable distribution** from the Python Software Foundation. `start.bat` invokes this interpreter directly, and `start.py` adds the repository's `src` directory to its isolated import path. Plan uses only the standard library, including the bundled SQLite and ctypes modules.

- Local Windows file connections, the operation journal and any temporarily staged project snapshots are kept under `%LOCALAPPDATA%\Plan\file-access`, separate from the runtime and `Documents\Plan\plan.db`. They are local user data, not bundled runtime files; protect them and do not remove them as part of runtime cleanup.
- Supported launcher target: **64-bit Windows 10/11 (Intel/AMD x64)**. This is not a native ARM64 or 32-bit runtime. Other systems can use an existing Python 3.10+ installation with `python start.py`.
- Upstream release: <https://www.python.org/downloads/release/python-31410/>
- Original archive: <https://www.python.org/ftp/python/3.14.10/python-3.14.10-embed-amd64.zip>
- Archive SHA-256: `90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159`
- License and bundled notices: [windows-x64/LICENSE.txt](windows-x64/LICENSE.txt).
- Upstream software bill of materials: [python-3.14.10-embed-amd64.spdx.json](python-3.14.10-embed-amd64.spdx.json). Its CPython package records the archive URL, version and SHA-256.
- Extracted file checksums and provenance: [windows-x64.manifest.json](windows-x64.manifest.json).

These files are ordinary Git files, without Git LFS or submodules. A clone, repository ZIP or complete folder copy contains the runtime. No runtime installer, administrator access, package installation, PowerShell extraction or network access is required at startup. Keep the upstream `python314._pth` file intact; the launcher supplies the app import path without enabling global site packages or depending on `PYTHONPATH`. `.gitattributes` preserves the upstream bytes even in checkouts that otherwise convert line endings.

The original archive is approximately 12 MiB compressed; the extracted runtime is approximately 23 MiB. It includes the upstream Visual C++ runtime DLLs, standard-library ZIP, SQLite and other native modules. Do not remove individual files from the distribution.

## Verify or replace the runtime

Using an existing Python installation, run from the repository root:

```sh
python -B -m unittest discover -s tests -p "test_runtime.py" -v
```

This checks all extracted file hashes, Windows x64 executable headers, standard-library ZIP integrity, required native modules, isolation settings and the license against the recorded manifest. On Windows it also launches the bundled interpreter from a separate working directory and checks the app's command-line help. No test downloads files.

For a runtime update, a maintainer on an unrestricted machine should download the official x64 embeddable ZIP and its SPDX metadata over HTTPS, verify the archive's SHA-256 against the upstream release metadata, and replace the entire `windows-x64/` directory with the archive contents. Update the manifest's version, source URL, archive hash and every extracted file hash; replace the SPDX file and update these details to match. Preserve every upstream file byte-for-byte, including the license and `._pth` file. Commit the actual runtime files with the manifest and launcher changes so users receive them through the repository.

Before distributing an updated runtime, run the verification and persistence suites and launch `start.bat` on Windows with networking disabled. Confirm browser startup and SQLite saves. Users only need the updated repository; they do not need access to Python.org or Astral.
