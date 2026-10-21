from sqlalchemy.orm import Session
from sqlalchemy import select
from pathlib import Path
import re
import uuid
import hashlib
import tempfile
from threading import RLock

from app.adapters.boss_cli import BossCliAdapter
from app.core.json_utils import dumps, loads
from app.db.models import CandidateRecord, RecommendationSnapshotRecord, RecommendedResumeRecord, RecommendedCandidateRecord, RecommendationRecycleRecord
from app.core.config import get_settings
from app.parsers.boss_cli_output import BossCliOutputError
from app.schemas.discovery import CommunicationSnapshot, RecommendationSnapshot, OnlineResumeScreenshot, ResumeCaptureResult, RecommendedPerson, RecommendationLibrary, RecommendationReadResult, RecommendationRecycleBin, RecycledRecommendation
from app.schemas.local import LocalCandidateListResponse
from app.services.local_store import LocalStoreService

_library_upgrade_lock = RLock()


class DiscoveryService:
    def __init__(self, db: Session, adapter: BossCliAdapter):
        self.db = db
        self.adapter = adapter

    @staticmethod
    def identity(person: RecommendedPerson) -> str:
        # Both fields must match; never merge by name or remote ID alone.
        fields = [' '.join(person.name.split()), ' '.join(person.baseInfo.split())]
        return hashlib.sha256(dumps(fields).encode('utf-8')).hexdigest()

    def _import_legacy(self) -> None:
        if self.db.get(RecommendationSnapshotRecord, 'library-imported'):
            return
        old = self.db.get(RecommendationSnapshotRecord, 'latest')
        if old:
            snapshot = RecommendationSnapshot.model_validate_json(old.snapshot_json)
            for person in snapshot.candidates:
                key = self.identity(person)
                if self.db.scalar(select(RecommendedCandidateRecord).where(RecommendedCandidateRecord.identity_key == key)):
                    continue
                saved = self.db.scalar(select(RecommendedResumeRecord).where(RecommendedResumeRecord.geek_id == person.geekId, RecommendedResumeRecord.name == person.name).order_by(RecommendedResumeRecord.captured_at.desc()).limit(1)) if person.geekId else None
                self.db.add(RecommendedCandidateRecord(identity_key=key, person_json=person.model_dump_json(), source_job=snapshot.job_label, screenshot_id=saved.id if saved else None))
                self.db.flush()
        self.db.add(RecommendationSnapshotRecord(id='library-imported', snapshot_json='{}'))
        self.db.commit()

    def _prepare_library(self) -> None:
        with _library_upgrade_lock:
            self._import_legacy()
            # Upgrade earlier soft deletions into minimal recycle-bin entries.
            for row in self.db.scalars(select(RecommendedCandidateRecord).where(RecommendedCandidateRecord.deleted_at.is_not(None))).all():
                self._recycle(row)

    def recycle_bin(self) -> RecommendationRecycleBin:
        self._prepare_library()
        rows = self.db.scalars(select(RecommendationRecycleRecord).order_by(RecommendationRecycleRecord.name, RecommendationRecycleRecord.base_info)).all()
        return RecommendationRecycleBin(candidates=[RecycledRecommendation(id=row.identity_key, name=row.name, baseInfo=row.base_info) for row in rows])

    def allow_recommendation_again(self, identity_key: str) -> None:
        self._prepare_library()
        row = self.db.get(RecommendationRecycleRecord, identity_key)
        if row is None:
            raise LookupError('回收站记录不存在或已允许重新读取，请刷新回收站')
        # Only release this exact name/basic-info identity. The next explicit
        # BOSS read can add it again; deleted profiles/images are not recreated.
        self.db.delete(row)
        self.db.commit()

    def _recycle(self, row: RecommendedCandidateRecord) -> None:
        person = RecommendedPerson.model_validate_json(row.person_json)
        if self.db.get(RecommendationRecycleRecord, row.identity_key) is None:
            self.db.add(RecommendationRecycleRecord(identity_key=row.identity_key, name=person.name, base_info=person.baseInfo))
        others = self.db.scalars(select(RecommendedCandidateRecord).where(RecommendedCandidateRecord.id != row.id)).all()
        others_people = [RecommendedPerson.model_validate_json(other.person_json) for other in others]
        # Old screenshot metadata lacks local candidate IDs. Keep files owned by
        # another record with the same remote ID/name; never delete their files.
        shared_identity = any(other.geekId == person.geekId and other.name == person.name for other in others_people)
        if person.geekId and not shared_identity:
            images = self.db.scalars(select(RecommendedResumeRecord).where(RecommendedResumeRecord.geek_id == person.geekId, RecommendedResumeRecord.name == person.name)).all()
            protected = {other.screenshot_id for other in others if other.screenshot_id}
            for image in images:
                if image.id not in protected:
                    self._screenshot_path(image.id).unlink(missing_ok=True)
                    self.db.delete(image)
        # Remove duplicate personal content from the legacy/latest cache too.
        for cache in self.db.scalars(select(RecommendationSnapshotRecord).where(RecommendationSnapshotRecord.id != 'library-imported')).all():
            snapshot = RecommendationSnapshot.model_validate_json(cache.snapshot_json)
            snapshot.candidates = [p for p in snapshot.candidates if self.identity(p) != row.identity_key]
            cache.snapshot_json = snapshot.model_dump_json()
        self.db.delete(row)
        self.db.commit()

    def recommendations(self) -> RecommendationLibrary:
        self._prepare_library()
        latest = self.db.get(RecommendationSnapshotRecord, 'latest')
        result = RecommendationLibrary.model_validate_json(latest.snapshot_json) if latest else RecommendationLibrary()
        result.candidates = []
        rows = self.db.scalars(select(RecommendedCandidateRecord).where(RecommendedCandidateRecord.deleted_at.is_(None)).order_by(RecommendedCandidateRecord.created_at.desc(), RecommendedCandidateRecord.id)).all()
        for row in rows:
            person = RecommendedPerson.model_validate_json(row.person_json)
            person.id = row.id
            person.source_job = row.source_job
            saved = self.db.get(RecommendedResumeRecord, row.screenshot_id) if row.screenshot_id else None
            person.online_resume = self._resume_view(saved) if saved else None
            result.candidates.append(person)
        return result

    def delete_recommendation(self, candidate_id: str) -> None:
        self._prepare_library()
        row = self.db.get(RecommendedCandidateRecord, candidate_id)
        if row is None:
            raise LookupError('推荐人选不存在或已删除')
        self._recycle(row)

    @staticmethod
    def _resume_view(row: RecommendedResumeRecord) -> OnlineResumeScreenshot:
        return OnlineResumeScreenshot(id=row.id, image_url=f'/api/local/recommendation-resumes/{row.id}/image', captured_at=row.captured_at)

    @staticmethod
    def _screenshot_path(screenshot_id: str) -> Path:
        if not re.fullmatch(r'[0-9a-f]{32}', screenshot_id):
            raise LookupError('无效的截图编号')
        root = (Path(get_settings().data_dir) / 'recommended-resumes').resolve()
        path = (root / f'{screenshot_id}.png').resolve()
        if path.parent != root:
            raise LookupError('截图路径无效')
        return path

    def resume_image(self, screenshot_id: str) -> Path:
        if self.db.get(RecommendedResumeRecord, screenshot_id) is None:
            raise LookupError('未找到已保存的在线简历截图')
        path = self._screenshot_path(screenshot_id)
        if not path.is_file():
            raise LookupError('本地截图文件不存在，请重新读取在线简历')
        return path

    async def capture_resume(self, geek_id: str, candidate_id: str | None = None) -> OnlineResumeScreenshot:
        matches = [person for person in self.recommendations().candidates if person.geekId == geek_id and geek_id and (candidate_id is None or person.id == candidate_id)]
        if len(matches) != 1:
            raise LookupError('该候选人不在本地推荐名单中或 ID 不唯一，请刷新列表')
        person = matches[0]
        screenshot_id = uuid.uuid4().hex
        path = self._screenshot_path(screenshot_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            result = await self.adapter.run('recommend-resume', '--geek-id', geek_id, '--name', person.name, '--output', str(path))
            try:
                captured = ResumeCaptureResult.model_validate_json(result.stdout)
            except ValueError as error:
                raise BossCliOutputError('截图返回格式不符，请重新构建本地 boss-cli') from error
            if captured.geek_id != geek_id or captured.name != person.name:
                raise BossCliOutputError('截图候选人与所选人员不一致，未保存')
            if not path.is_file() or not 24 <= path.stat().st_size <= get_settings().max_resume_bytes:
                raise BossCliOutputError('截图文件未生成或超过允许大小')
            with path.open('rb') as file:
                header = file.read(24)
            if header[:8] != b'\x89PNG\r\n\x1a\n' or header[12:16] != b'IHDR' or int.from_bytes(header[16:20], 'big') <= 0 or int.from_bytes(header[20:24], 'big') <= 0:
                raise BossCliOutputError('截图不是有效的 PNG 图片')
            row = RecommendedResumeRecord(id=screenshot_id, geek_id=geek_id, name=person.name, captured_at=captured.captured_at)
            self.db.add(row)
            candidate = self.db.get(RecommendedCandidateRecord, person.id)
            candidate.screenshot_id = screenshot_id
            self.db.commit()
            return self._resume_view(row)
        except Exception:
            self.db.rollback()
            path.unlink(missing_ok=True)
            raise

    async def read_recommendations(self) -> RecommendationReadResult:
        self._prepare_library()
        existing = self.db.scalars(select(RecommendedCandidateRecord)).all()
        recycled = self.db.scalars(select(RecommendationRecycleRecord)).all()
        excluded = [RecommendedPerson.model_validate_json(row.person_json) for row in existing]
        identities = [{'name': p.name, 'baseInfo': p.baseInfo} for p in excluded]
        identities.extend({'name': row.name, 'baseInfo': row.base_info} for row in recycled)
        # A file avoids Windows command-line length limits as the library grows.
        with tempfile.TemporaryDirectory(prefix='ai-hr-recommend-') as folder:
            path = Path(folder) / 'excluded.json'
            path.write_text(dumps(identities), encoding='utf-8')
            result = await self.adapter.run('recommend', '--limit', '10', '--json', '--exclude-file', str(path))
        try:
            snapshot = RecommendationSnapshot.model_validate_json(result.stdout)
        except ValueError as error:
            raise BossCliOutputError('推荐列表输出格式不符；请确认本地 boss-cli 已重新构建') from error
        if snapshot.captured_at is None or len(snapshot.candidates) > snapshot.limit:
            raise BossCliOutputError('推荐快照缺少采集时间或超过本次读取上限')
        known = {row.identity_key for row in [*existing, *recycled]}
        added = []
        for person in snapshot.candidates:
            key = self.identity(person)
            if key in known:
                continue
            known.add(key)
            person.online_resume = None
            row = RecommendedCandidateRecord(identity_key=key, person_json=person.model_dump_json(), source_job=snapshot.job_label)
            self.db.add(row)
            self.db.flush()
            added.append(row.id)
        snapshot.candidates = []
        latest = self.db.get(RecommendationSnapshotRecord, 'latest')
        if latest is None:
            self.db.add(RecommendationSnapshotRecord(id='latest', snapshot_json=snapshot.model_dump_json()))
        else:
            latest.snapshot_json = snapshot.model_dump_json()
        self.db.commit()
        return RecommendationReadResult(**self.recommendations().model_dump(), added_ids=added)

    async def classify(self, ids: list[str]) -> LocalCandidateListResponse:
        if not 1 <= len(ids) <= 10 or len(set(ids)) != len(ids):
            raise ValueError('每次仅可核验 1 到 10 位不同候选人')
        rows = [self.db.get(CandidateRecord, candidate_id) for candidate_id in ids]
        if any(row is None for row in rows):
            raise LookupError('所选候选人不存在，请刷新列表')
        targets = []
        for row in rows:
            source = loads(row.source_snapshot, {})
            if not source.get('job'):
                raise ValueError('候选人缺少来源岗位，请先同步')
            targets.append({'id': row.id, 'name': row.name, 'job': source['job']})
        result = await self.adapter.run('classify', '--targets', dumps(targets))
        try:
            snapshot = CommunicationSnapshot.model_validate_json(result.stdout)
        except ValueError as error:
            raise BossCliOutputError('沟通核验输出格式不符；请确认本地 boss-cli 已重新构建') from error
        if len(snapshot.results) != len(ids) or {item.id for item in snapshot.results} != set(ids):
            raise BossCliOutputError('沟通核验返回的候选人与请求不一致，未保存结果')
        by_id = {item.id: item for item in snapshot.results}
        for row in rows:
            self.db.refresh(row)
            profile = loads(row.profile_json, {})
            profile['communication'] = by_id[row.id].model_dump(mode='json')
            self.db.add(row)
            row.profile_json = dumps(profile)
        self.db.commit()
        local = LocalStoreService(self.db)
        return LocalCandidateListResponse(candidates=[local._candidate_view(row) for row in rows], total=len(rows))
