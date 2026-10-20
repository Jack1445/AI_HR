from fastapi.testclient import TestClient

from app.main import app


def test_health_does_not_require_boss_cli() -> None:
    response = TestClient(app).get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["service"] == "ai-hr-backend"


def test_debug_status_exposes_runtime_without_cli_output() -> None:
    response = TestClient(app).get("/api/debug/status")

    assert response.status_code == 200
    body = response.json()
    assert body["runtime"]["pid"] > 0
    assert "boss_cli_entrypoint_exists" in body["config"]
    assert '"stdout":' not in response.text
    assert '"stderr":' not in response.text
