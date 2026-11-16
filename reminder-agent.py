"""Standalone windowless entry point, compatible with isolated bundled Python."""
if __name__ == "__main__":
    import importlib
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
    main = importlib.import_module("project_management_tool.reminder_agent.__main__").main

    raise SystemExit(main())
