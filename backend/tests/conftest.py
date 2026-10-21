import pytest

from app.core.config import Settings
from app.services import diagnostics


@pytest.fixture(autouse=True)
def isolate_diagnostic_files(tmp_path, monkeypatch):
    """Synthetic test runs must not replace the user's latest diagnostic log."""
    monkeypatch.setattr(diagnostics, "get_settings", lambda: Settings(data_dir=str(tmp_path)))
