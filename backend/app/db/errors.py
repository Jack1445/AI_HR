"""Database diagnostics without SQL statements or candidate/chat parameters."""
import re

from sqlalchemy.exc import SQLAlchemyError


def database_error_summary(error: SQLAlchemyError) -> str:
    original = getattr(error, 'orig', None)
    code = getattr(original, 'sqlite_errorname', '')
    # SQLite constraint messages contain schema identifiers only in this form.
    constraint = re.fullmatch(r'((?:UNIQUE|NOT NULL) constraint failed: [a-zA-Z0-9_., ]+)', str(original))
    return ': '.join(part for part in (type(error).__name__, code, constraint.group(1) if constraint else '') if part)


def redact_legacy_sql_error(value: str | None) -> str | None:
    """Previously stored failures can contain raw SQL and parameter dumps."""
    if value and '[SQL:' in value and ('sqlalchemy' in value.lower() or 'Error:' in value):
        return value.split('[SQL:', 1)[0].strip()[:500]
    return value
