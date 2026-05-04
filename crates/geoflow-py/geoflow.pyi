"""Type stubs for the geoflow Python extension module."""

from __future__ import annotations

from typing import Any

__version__: str

class AgsFile:
    """An in-memory representation of a parsed AGS 4.x file."""

    @property
    def ags_version(self) -> str | None:
        """AGS version detected during parsing, e.g. ``"4.1"``."""
        ...

    def group_names(self) -> list[str]:
        """Names of every group present in the file, in declared order."""
        ...

    def row_count(self, group: str) -> int | None:
        """Number of DATA rows in *group*, or ``None`` if the group is absent."""
        ...

    def group_metadata(self, group: str) -> list[dict[str, str]]:
        """Heading metadata for *group*.

        Each entry is a dict with keys ``name``, ``unit``, and ``type``
        (the raw AGS type code, e.g. ``"2DP"`` or ``"DT"``).

        Raises ``ValueError`` if the group does not exist.
        """
        ...

    def group_rows(self, group: str) -> list[dict[str, Any]]:
        """All DATA rows of *group* as a list of dicts.

        Values are typed: numbers become ``float``, Y/N fields become
        ``bool``, empty fields become ``None``.

        Raises ``ValueError`` if the group does not exist.
        """
        ...

    def validate(self, rules: list[str] | None = None) -> list[dict[str, Any]]:
        """Run the built-in rule registry against this file.

        *rules* is an optional list of extra rule-pack specs (file paths or
        built-in references such as ``"ice:mini@0.1"``).

        Returns a list of diagnostic dicts, each with keys:

        * ``rule_id`` (str)
        * ``severity`` (``"info"``, ``"warning"``, or ``"error"``)
        * ``message`` (str)
        * ``group`` (str | None)
        * ``line`` (int | None)
        * ``file`` (str | None)
        """
        ...

    def fix(self, rules: list[str] | None = None) -> list[str]:
        """Apply safe auto-fixes in-place.

        *rules* is an optional list of DSL rule-pack specs that declare
        ``fix:`` blocks.

        Returns the sorted, deduplicated list of fix names that were applied.
        """
        ...

    def to_diggs(self) -> tuple[str, str]:
        """Serialize to DIGGS XML.

        Returns ``(xml_string, report_json)`` where *report_json* is a JSON
        string describing which groups were natively mapped and which fields
        were not carried to DIGGS.
        """
        ...

    def to_ags(self) -> str:
        """Serialize back to AGS 4 text."""
        ...

    def to_dict(self) -> dict[str, list[dict[str, Any]]]:
        """Return all groups as ``{group_name: [row, ...]}``.

        Equivalent to calling :meth:`group_rows` for every group and
        collecting the results.
        """
        ...

    def to_csv(self) -> dict[str, str]:
        """Return all groups as ``{group_name: csv_text}``.

        Each CSV starts with a header row of heading names followed by one
        row per DATA row.  Values containing commas or quotes are properly
        quoted.
        """
        ...

    def to_dataframes(self) -> dict[str, Any]:
        """Return all groups as ``{group_name: pandas.DataFrame}``.

        Requires ``pandas`` to be installed (``pip install pandas``).
        """
        ...

    def to_dataframe(self, group: str) -> Any:
        """Return *group* as a ``pandas.DataFrame``.

        Requires ``pandas`` to be installed (``pip install pandas``).
        Raises ``ValueError`` if the group does not exist.
        """
        ...

    def __repr__(self) -> str: ...


def read_ags(path: str) -> AgsFile:
    """Read an AGS 4.x file from disk.

    Raises ``IOError`` on read failure.
    """
    ...


def parse_ags(text: str) -> AgsFile:
    """Parse AGS 4.x text already in memory."""
    ...


def read_diggs(path: str) -> AgsFile:
    """Read a DIGGS XML file from disk and convert to the AGS model.

    Raises ``IOError`` on read failure and ``ValueError`` on parse error.
    """
    ...


def installed_pack_refs() -> list[str]:
    """List all built-in rule pack references (e.g. ``["ice:mini@0.1"]``)."""
    ...
