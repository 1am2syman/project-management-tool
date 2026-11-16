"""Run a downloaded copy of Plan without installing packages."""
if __name__ == "__main__":
    import sys
    from pathlib import Path

    # The Windows embeddable runtime excludes the script directory from sys.path.
    sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
    from project_management_tool import main  # pyright: ignore[reportMissingImports] -- src is added above.

    main()
