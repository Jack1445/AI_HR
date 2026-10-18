from pathlib import Path

from app.parsers.boss_cli_output import parse_candidates, parse_positions


FIXTURES = Path(__file__).parent / "fixtures"


def test_parse_positions_preserves_stable_id_and_stats() -> None:
    parsed = parse_positions((FIXTURES / "positions.sample.txt").read_text(encoding="utf-8"))

    assert parsed.remote_total == 2
    assert parsed.jobs[0].id == "10001"
    assert parsed.jobs[0].title == "AI产品经理"
    assert parsed.jobs[0].chatted == 4
    assert parsed.jobs[1].status == "待开放"


def test_parse_candidates_reads_communicated_candidate_fields() -> None:
    parsed = parse_candidates((FIXTURES / "list.sample.txt").read_text(encoding="utf-8"))

    assert parsed.remote_total == 2
    assert parsed.unread_total == 1
    assert parsed.candidates[0].name == "张三"
    assert parsed.candidates[0].job == "AI产品经理"
    assert parsed.candidates[0].unread_count == 2
    assert parsed.candidates[1].message == "感谢您的沟通"
