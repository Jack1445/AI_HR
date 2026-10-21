import asyncio

from app.adapters.boss_cli import BossCliResult
from app.services.boss_readonly import BossReadOnlyService


class FakeBossCli:
    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []

    async def run(self, *args: str, **kwargs) -> BossCliResult:
        self.calls.append(tuple(args))
        if args == ("positions",):
            output = """已读取 2 个职位（页面统计：共 2 个）。
职位明细：
1. AI产品经理｜状态:开放中｜标签:急招｜本科｜3-5年｜北京｜看过我:12｜沟通过:4｜感兴趣:2｜ID:10001
2. 后端工程师｜状态:待开放｜标签:｜本科｜1-3年｜上海｜看过我:3｜沟通过:1｜感兴趣:0｜ID:10002
"""
        else:
            output = """沟通列表共 2 人，其中 1 人有未读消息。
候选人明细：
1. 张三｜AI产品经理｜未读:2｜时间:10:30｜消息:您好
2. 李四｜后端工程师｜时间:昨天｜消息:感谢
"""
        return BossCliResult(args=tuple(args), stdout=output, stderr="", returncode=0)


def test_service_filters_candidates_by_selected_job_title() -> None:
    adapter = FakeBossCli()
    service = BossReadOnlyService(adapter)  # type: ignore[arg-type]

    response = asyncio.run(service.list_candidates_for_job("10001"))

    assert response.job_title == "AI产品经理"
    assert [candidate.name for candidate in response.candidates] == ["张三"]
    assert adapter.calls == [("positions",), ("list",)]


def test_sync_reads_one_snapshot_for_all_jobs_and_keeps_job_associations() -> None:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from app.db.base import Base
    from app.services.local_store import LocalStoreService

    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    adapter = FakeBossCli()
    with Session(engine) as db:
        store = LocalStoreService(db, BossReadOnlyService(adapter))
        result = asyncio.run(store.sync())
        assert result.status == "success"
        assert adapter.calls == [("positions",), ("list",)]
        associations = {
            job.title: [c.name for c in store.list_candidates(job_id=job.id).candidates]
            for job in store.list_jobs().jobs
        }
        assert associations == {"AI产品经理": ["张三"], "后端工程师": ["李四"]}

        adapter.calls.clear()
        asyncio.run(store.sync(scope="jobs"))
        assert adapter.calls == [("positions",)]


def test_empty_jobs_do_not_read_communication_list() -> None:
    adapter = FakeBossCli()
    service = BossReadOnlyService(adapter)
    assert asyncio.run(service.list_candidates_for_jobs([])) == {}
    assert adapter.calls == []
