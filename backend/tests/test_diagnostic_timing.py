import asyncio
import json
import sys

import pytest

from app.adapters.boss_cli import BossCliAdapter, BossCliTimeoutError
from app.api.routes.debug import _summarize_log
from app.services.diagnostics import DiagnosticLog


def test_timing_is_visible_before_cli_exits_and_output_is_preserved(tmp_path):
    trace = DiagnosticLog(tmp_path / "trace.log")
    script = tmp_path / "fake_cli.py"
    script.write_text('''import json, sys, time
print('[boss-cli][timing] ' + json.dumps({"stage": "cli.update_check", "status": "start", "span_id": "s1", "time": "2026-10-21T00:00:00+00:00", "pid": 1}), file=sys.stderr, flush=True)
time.sleep(1)
print('[boss-cli][timing] ' + json.dumps({"stage": "cli.update_check", "status": "complete", "span_id": "s1", "elapsed_seconds": 1}), file=sys.stderr, flush=True)
print('private candidate data', flush=True)
''', encoding="utf-8")

    async def run():
        adapter = BossCliAdapter(sys.executable, str(script), timeout_seconds=10)
        task = asyncio.create_task(adapter.run("positions", diagnostic_log=trace))
        for _ in range(100):
            await asyncio.sleep(0.01)
            events = _summarize_log(trace.path)["events"]
            if any(e["event"] == "cli.timing" for e in events):
                assert not task.done(), "Timing must stream before command completion"
                break
        else:
            pytest.fail("No live timing event received")
        result = await task
        assert "private candidate data" in result.stdout

    asyncio.run(run())
    text = trace.path.read_text(encoding="utf-8")
    assert "private candidate data" not in text  # normal sync stores metadata only
    rows = _summarize_log(trace.path)["timings"]
    row = next(r for r in rows if r["stage"] == "cli.update_check")
    assert row["status"] == "complete" and row["elapsed_seconds"] == 1


def test_timeout_keeps_partial_output_and_last_stage(tmp_path):
    trace = DiagnosticLog(tmp_path / "timeout.log")
    script = tmp_path / "slow_cli.py"
    script.write_text('''import json, sys, time
print('partial stdout', flush=True)
print('[boss-cli][timing] ' + json.dumps({"stage": "browser.connect", "status": "start", "span_id": "s2", "time": "2026-10-21T00:00:00+00:00"}), file=sys.stderr, flush=True)
time.sleep(30)
''', encoding="utf-8")
    adapter = BossCliAdapter(sys.executable, str(script), timeout_seconds=0.5)
    with pytest.raises(BossCliTimeoutError):
        asyncio.run(adapter.run("list", debug=True, diagnostic_log=trace))
    trace.write("sync.failed")
    events = [json.loads(line) for line in trace.path.read_text(encoding="utf-8").splitlines()]
    timed_out = next(e for e in events if e["event"] == "cli.timeout")
    assert "partial stdout" in timed_out["details"]["stdout"]
    row = next(r for r in _summarize_log(trace.path)["timings"] if r["stage"] == "browser.connect")
    assert row["status"] == "interrupted"
    assert '"stdout":' not in json.dumps(_summarize_log(trace.path))


def test_long_stderr_line_does_not_block_timing(tmp_path):
    trace = DiagnosticLog(tmp_path / "long.log")
    script = tmp_path / "long_cli.py"
    script.write_text("import sys\nsys.stderr.write('x' * 100000 + '\\n')\nprint('ok')\n", encoding="utf-8")
    result = asyncio.run(BossCliAdapter(sys.executable, str(script), timeout_seconds=10).run("list", diagnostic_log=trace))
    assert len(result.stderr.strip()) == 100000
    assert result.stdout.strip() == "ok"


def test_queued_sync_identifies_direct_read_and_preserves_serial_execution(tmp_path):
    script = tmp_path / "queued_cli.py"
    script.write_text('''import pathlib, sys, time
root = pathlib.Path(__file__).parent
if sys.argv[1] == 'positions':
    (root / 'started').touch()
    deadline = time.monotonic() + 5
    while not (root / 'release').exists() and time.monotonic() < deadline:
        time.sleep(0.01)
else:
    (root / 'second_started').touch()
print('ok')
''', encoding="utf-8")
    trace = DiagnosticLog(tmp_path / "sync.log")

    async def run():
        adapter = BossCliAdapter(sys.executable, str(script), timeout_seconds=10)
        first = asyncio.create_task(adapter.run("positions"))
        try:
            for _ in range(200):
                if (tmp_path / "started").exists():
                    break
                await asyncio.sleep(0.01)
            assert (tmp_path / "started").exists()
            owner = adapter.active_command
            assert owner is not None
            assert owner["command"] == "positions"
            assert "cli-" in owner["diagnostic_log"]
            second = asyncio.create_task(adapter.run("list", diagnostic_log=trace))
            await asyncio.sleep(0.05)
            assert not (tmp_path / "second_started").exists()
            queued = next(json.loads(line) for line in trace.path.read_text().splitlines() if json.loads(line)["event"] == "cli.queue_start")
            assert queued["details"]["blocking_command_id"] == owner["command_id"]
            assert queued["details"]["blocking_log"] == owner["diagnostic_log"]
        finally:
            (tmp_path / "release").touch()
            await first
        await second
        assert adapter.active_command is None

    asyncio.run(run())
