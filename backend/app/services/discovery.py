from sqlalchemy.orm import Session
from sqlalchemy import select, delete
from pathlib import Path
import re
import uuid
import hashlib
import tempfile
from shutil import copyfile
from threading import RLock

from app.adapters.boss_cli import BossCliAdapter
from app.core.json_utils import dumps, loads
from app.db.models import CandidateRecord, CommunicationAttachmentRecord, JobRecord, ResumeDocumentRecord, RecommendationSnapshotRecord, RecommendedResumeRecord, RecommendedCandidateRecord, RecommendationRecycleRecord, CommunicationRecycleRecord, JobCandidateRecord
from app.core.config import get_settings
from app.core.greeting_identity import identity as greeting_identity
from app.db.models import RecommendationGreetingLedgerRecord
from app.parsers.boss_cli_output import BossCliOutputError
from app.schemas.discovery import CommunicationSnapshot, RecommendationSnapshot, OnlineResumeScreenshot, ResumeCaptureResult, RecommendedPerson, RecommendationLibrary, RecommendationReadResult, RecommendationRecycleBin, RecycledRecommendation
from app.schemas.local import LocalCandidateListResponse, ResumeResponse
from app.services.local_store import LocalStoreService
from app.services.resumes import ResumeService
from app.db.models import RecommendationFirstCaptureRecord, RecommendationHiddenRecord
from app.services.table_store import cleanup_table_row
from app.db.models import RecommendationJobRecord, RecommendationRecycleJobRecord
from app.schemas.discovery import RecommendationJobsSnapshot, RECOMMENDATION_READ_LIMIT
from app.services.recommendation_scope import build_active_recommendation_index, recommendation_identity_for_chat, normalize, recommendation_job_title, unambiguous_stored_chat_keys

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

    @staticmethod
    def job_key(label: str) -> str:
        return hashlib.sha256(' '.join(label.split()).encode('utf-8')).hexdigest()

    def remember_job(self, label: str, available: bool = False) -> RecommendationJobRecord:
        label = ' '.join(label.split())
        key = self.job_key(label)
        row = self.db.get(RecommendationJobRecord, key)
        if row is None:
            row = RecommendationJobRecord(id=key, label=label, available=available)
            self.db.add(row)
            self.db.commit()
        elif available and not row.available:
            row.available = True
            self.db.commit()
        return row

    def jobs(self) -> dict:
        self._prepare_library()
        counts = {}
        hidden_ids = set(self.db.scalars(select(RecommendationHiddenRecord.candidate_id)))
        for row in self.db.scalars(select(RecommendedCandidateRecord)):
            job = self.remember_job(row.source_job)
            if row.id not in hidden_ids:
                counts[job.id] = counts.get(job.id, 0) + 1
        # Migrate the old single snapshot only to its explicitly recorded job.
        legacy = self.db.get(RecommendationSnapshotRecord, 'latest')
        if legacy:
            snapshot = RecommendationSnapshot.model_validate_json(legacy.snapshot_json)
            key = f'job:{self.job_key(snapshot.job_label)}'
            if snapshot.job_label and self.db.get(RecommendationSnapshotRecord, key) is None:
                snapshot.candidates = []
                self.db.add(RecommendationSnapshotRecord(id=key, snapshot_json=snapshot.model_dump_json()))
                self.db.commit()
        rows = self.db.scalars(select(RecommendationJobRecord).order_by(RecommendationJobRecord.available.desc(), RecommendationJobRecord.label)).all()
        return {'jobs': [{'id': r.id, 'label': r.label or '历史未归属岗位', 'available': r.available and bool(r.label), 'count': counts.get(r.id, 0)} for r in rows]}

    async def read_jobs(self) -> dict:
        result = await self.adapter.run('recommend-jobs')
        try:
            snapshot = RecommendationJobsSnapshot.model_validate_json(result.stdout)
        except ValueError as error:
            raise BossCliOutputError('推荐岗位列表格式错误，请重新构建 boss-cli') from error
        labels = [' '.join(label.split()) for label in snapshot.jobs]
        if any(not label for label in labels) or len(set(labels)) != len(labels):
            raise BossCliOutputError('推荐岗位标签为空或重复，无法准确区分，未更新岗位列表')
        for row in self.db.scalars(select(RecommendationJobRecord)):
            row.available = False
        for label in labels:
            key = self.job_key(label)
            row = self.db.get(RecommendationJobRecord, key)
            if row:
                row.available = True
            else:
                self.db.add(RecommendationJobRecord(id=key, label=label, available=True))
        self.db.commit()
        return {**self.jobs(), 'current_job_key': self.job_key(snapshot.current_job)}

    def _job(self, job_key: str) -> RecommendationJobRecord:
        row = self.db.get(RecommendationJobRecord, job_key)
        if row is None:
            raise LookupError('推荐岗位不存在，请刷新 BOSS 岗位列表')
        return row

    def _recycled_for_job(self, job_key: str | None):
        rows = self.db.scalars(select(RecommendationRecycleRecord).order_by(RecommendationRecycleRecord.name, RecommendationRecycleRecord.base_info)).all()
        scopes = {r.identity_key: r.job_id for r in self.db.scalars(select(RecommendationRecycleJobRecord))}
        return [(r, scopes.get(r.identity_key, '')) for r in rows if job_key is None or r.identity_key not in scopes or scopes[r.identity_key] == job_key]

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
            rows = self.db.scalars(select(RecommendedCandidateRecord)).all()
            people = {row.id: RecommendedPerson.model_validate_json(row.person_json) for row in rows}
            changed = False
            for row in rows:
                if not row.screenshot_id or self.db.get(RecommendationFirstCaptureRecord, row.id):
                    continue
                person = people[row.id]
                saved = self.db.get(RecommendedResumeRecord, row.screenshot_id)
                if saved is None:
                    continue
                # Legacy metadata has no basic-info identity. Only associate
                # historical captures when that remote ID/name is unambiguous.
                owners = [p for p in people.values() if p.geekId == person.geekId and p.name == person.name]
                if len(owners) == 1:
                    saved = self.db.scalar(select(RecommendedResumeRecord).where(RecommendedResumeRecord.geek_id == person.geekId, RecommendedResumeRecord.name == person.name).order_by(RecommendedResumeRecord.captured_at).limit(1))
                self.db.add(RecommendationFirstCaptureRecord(candidate_id=row.id, captured_at=saved.captured_at))
                changed = True
            if changed:
                self.db.commit()

    def recycle_bin(self, job_key: str | None = None) -> RecommendationRecycleBin:
        self._prepare_library()
        jobs = self.db.scalars(select(RecommendationJobRecord)).all()
        jobs_by_id = {job.id: job.label for job in jobs}
        entries = [RecycledRecommendation(id=row.identity_key, name=row.name, baseInfo=row.base_info, job_key=key, scope_label=('当前岗位' if job_key else jobs_by_id.get(key, '来源岗位未知')) if key else '历史全局排除') for row, key in self._recycled_for_job(job_key)]
        # Legacy communication tombstones are folded into the same view. New
        # deletions use recommendation identities and do not create these rows.
        jobs_by_title = {recommendation_job_title(job.label): job for job in jobs}
        for row in self.db.scalars(select(CommunicationRecycleRecord).order_by(CommunicationRecycleRecord.name)).all():
            matched_job = jobs_by_title.get(normalize(row.source_job))
            if job_key and (matched_job is None or matched_job.id != job_key):
                continue
            entries.append(RecycledRecommendation(id=f'communication:{row.remote_id}', name=row.name, baseInfo='', job_key=matched_job.id if matched_job else '', scope_label=row.source_job or '历史沟通记录'))
        return RecommendationRecycleBin(candidates=entries)

    def allow_recommendation_again(self, identity_key: str) -> None:
        self._prepare_library()
        if identity_key.startswith('communication:'):
            remote_id = identity_key.removeprefix('communication:')
            row = self.db.get(CommunicationRecycleRecord, remote_id)
            if row is None:
                raise LookupError('回收站记录不存在或已允许重新读取，请刷新回收站')
            self.db.delete(row)
            self.db.commit()
            return
        row = self.db.get(RecommendationRecycleRecord, identity_key)
        if row is None:
            raise LookupError('回收站记录不存在或已允许重新读取，请刷新回收站')
        # Only release this exact name/basic-info identity. The next explicit
        # BOSS read can add it again; deleted profiles/images are not recreated.
        self.db.delete(row)
        self.db.execute(delete(RecommendationRecycleJobRecord).where(RecommendationRecycleJobRecord.identity_key == identity_key))
        self.db.commit()

    def _recycle(self, row: RecommendedCandidateRecord, *, commit: bool = True) -> None:
        hidden = self.db.get(RecommendationHiddenRecord, row.id)
        if hidden is not None:
            self.db.delete(hidden)
        person = RecommendedPerson.model_validate_json(row.person_json)
        job = self.remember_job(row.source_job) if row.source_job else None
        if self.db.get(RecommendationRecycleRecord, row.identity_key) is None:
            self.db.add(RecommendationRecycleRecord(identity_key=row.identity_key, name=person.name, base_info=person.baseInfo))
        if job and self.db.get(RecommendationRecycleJobRecord, row.identity_key) is None:
            self.db.add(RecommendationRecycleJobRecord(identity_key=row.identity_key, job_id=job.id))
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
            if self.job_key(snapshot.job_label) == self.job_key(row.source_job):
                snapshot.candidates = [p for p in snapshot.candidates if self.identity(p) != self.identity(person)]
            cache.snapshot_json = snapshot.model_dump_json()
        cleanup_table_row(self.db, 'recommendations', row.id)
        self.db.execute(delete(RecommendationFirstCaptureRecord).where(RecommendationFirstCaptureRecord.candidate_id == row.id))
        # The same recycle entry also excludes an already imported chat row.
        # Keep its local notes untouched, but require a new explicit sync before
        # the communication relation may become active again after restoration.
        index = build_active_recommendation_index(self.db)
        unique_chat_keys = unambiguous_stored_chat_keys(self.db)
        linked_chats = self.db.execute(
            select(JobCandidateRecord, CandidateRecord.name)
            .join(CandidateRecord, CandidateRecord.id == JobCandidateRecord.candidate_id)
        ).all()
        for relation, candidate_name in linked_chats:
            source = loads(relation.source_snapshot, {})
            identity = source.get('recommendation_identity')
            legacy_match = identity is None and (normalize(candidate_name), normalize(relation.remote_job_text)) in unique_chat_keys and recommendation_identity_for_chat(index, candidate_name, relation.remote_job_text) == row.identity_key
            if identity == row.identity_key or legacy_match:
                source['excluded_by_recommendation'] = True
                relation.source_snapshot = dumps(source)
        self.db.delete(row)
        if commit:
            self.db.commit()

    def recycle_linked_recommendations(self, candidate_id: str) -> bool:
        """Move recommendation records linked to one communication candidate.

        Communication deletion uses the recommendation recycle record as the
        shared tombstone. Historical relations are resolved conservatively by
        name and source job when they predate explicit linking.
        """
        links = self.db.scalars(select(JobCandidateRecord).where(JobCandidateRecord.candidate_id == candidate_id)).all()
        candidate = self.db.get(CandidateRecord, candidate_id)
        index = build_active_recommendation_index(self.db)
        unique_chat_keys = unambiguous_stored_chat_keys(self.db)
        identities = set()
        for link in links:
            identity = loads(link.source_snapshot, {}).get('recommendation_identity')
            if identity is None and candidate is not None and (normalize(candidate.name), normalize(link.remote_job_text)) in unique_chat_keys:
                identity = recommendation_identity_for_chat(index, candidate.name, link.remote_job_text)
            if identity:
                identities.add(identity)
        recycled = False
        for identity_key in identities:
            row = self.db.scalar(select(RecommendedCandidateRecord).where(RecommendedCandidateRecord.identity_key == identity_key))
            if row is not None:
                self._recycle(row, commit=False)
                recycled = True
        if recycled:
            self.db.flush()
        return recycled

    def recommendations(self, job_key: str | None = None) -> RecommendationLibrary:
        self._prepare_library()
        # Only a confirmed send by this platform counts. Merely selecting a row,
        # clicking a button, or discovering a pre-existing BOSS greeting does not.
        greeted = set(self.db.scalars(select(RecommendationGreetingLedgerRecord.id).where(RecommendationGreetingLedgerRecord.status == 'sent')))
        job = self._job(job_key) if job_key else None
        latest = self.db.get(RecommendationSnapshotRecord, f'job:{job_key}' if job else 'latest')
        result = RecommendationLibrary.model_validate_json(latest.snapshot_json) if latest else RecommendationLibrary()
        result.candidates = []
        if job:
            result.job_key = job.id
            result.job_label = job.label
        rows = self.db.scalars(select(RecommendedCandidateRecord).where(RecommendedCandidateRecord.deleted_at.is_(None)).order_by(RecommendedCandidateRecord.created_at.desc(), RecommendedCandidateRecord.id)).all()
        hidden_ids = set(self.db.scalars(select(RecommendationHiddenRecord.candidate_id)))
        for row in rows:
            if row.id in hidden_ids or job and self.job_key(row.source_job) != job.id:
                continue
            person = RecommendedPerson.model_validate_json(row.person_json)
            person.id = row.id
            person.source_job = row.source_job
            person.greeted = bool(person.geekId) and greeting_identity(self.job_key(row.source_job), person.geekId) in greeted
            saved = self.db.get(RecommendedResumeRecord, row.screenshot_id) if row.screenshot_id else None
            person.online_resume = self._resume_view(saved) if saved else None
            first = self.db.get(RecommendationFirstCaptureRecord, row.id)
            person.first_retrieved_at = first.captured_at if first else None
            result.candidates.append(person)
        return result

    def delete_recommendation(self, candidate_id: str) -> None:
        self._prepare_library()
        row = self.db.get(RecommendedCandidateRecord, candidate_id)
        if row is None:
            raise LookupError('推荐人选不存在或已删除')
        if self.db.get(RecommendationHiddenRecord, row.id) is not None:
            raise LookupError('推荐人选已从当前页面隐藏')
        person = RecommendedPerson.model_validate_json(row.person_json)
        greeting = self.db.get(RecommendationGreetingLedgerRecord,
            greeting_identity(self.job_key(row.source_job), person.geekId)) if person.geekId else None
        if greeting is not None and greeting.status == 'sent':
            self.db.add(RecommendationHiddenRecord(candidate_id=row.id))
            self.db.commit()
        else:
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
            if not person.source_job:
                raise LookupError('此历史记录缺少来源岗位，无法准确定位简历')
            result = await self.adapter.run('recommend-resume', '--geek-id', geek_id, '--name', person.name, '--output', str(path), '--job-label', ' '.join(person.source_job.split()))
            try:
                captured = ResumeCaptureResult.model_validate_json(result.stdout)
            except ValueError as error:
                raise BossCliOutputError('截图返回格式不符，请重新构建本地 boss-cli') from error
            if captured.geek_id != geek_id or captured.name != person.name:
                raise BossCliOutputError('截图候选人与所选人员不一致，未保存')
            if ' '.join(captured.job_label.split()) != ' '.join(person.source_job.split()):
                raise BossCliOutputError('截图返回的岗位与来源岗位不一致，未保存')
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
            if self.db.get(RecommendationFirstCaptureRecord, person.id) is None:
                self.db.add(RecommendationFirstCaptureRecord(candidate_id=person.id, captured_at=captured.captured_at))
            self.db.commit()
            return self._resume_view(row)
        except Exception:
            self.db.rollback()
            path.unlink(missing_ok=True)
            raise

    async def read_recommendations(self, job_key: str) -> RecommendationReadResult:
        self._prepare_library()
        job = self._job(job_key)
        if not job.available or not job.label:
            raise ValueError('请先刷新 BOSS 岗位列表，再选择可读取的推荐岗位')
        existing = [r for r in self.db.scalars(select(RecommendedCandidateRecord)) if self.job_key(r.source_job) == job.id]
        recycled = [row for row, _ in self._recycled_for_job(job.id)]
        excluded = [RecommendedPerson.model_validate_json(row.person_json) for row in existing]
        identities = [{'name': p.name, 'baseInfo': p.baseInfo} for p in excluded]
        identities.extend({'name': row.name, 'baseInfo': row.base_info} for row in recycled)
        # A file avoids Windows command-line length limits as the library grows.
        with tempfile.TemporaryDirectory(prefix='ai-hr-recommend-') as folder:
            path = Path(folder) / 'excluded.json'
            path.write_text(dumps(identities), encoding='utf-8')
            result = await self.adapter.run('recommend', '--limit', str(RECOMMENDATION_READ_LIMIT), '--json', '--exclude-file', str(path), '--job-label', job.label)
        try:
            snapshot = RecommendationSnapshot.model_validate_json(result.stdout)
        except ValueError as error:
            raise BossCliOutputError('推荐列表输出格式不符；请确认本地 boss-cli 已重新构建') from error
        if snapshot.captured_at is None or len(snapshot.candidates) > min(snapshot.limit, RECOMMENDATION_READ_LIMIT):
            raise BossCliOutputError('推荐快照缺少采集时间或超过本次读取上限')
        if ' '.join(snapshot.job_label.split()) != job.label:
            raise BossCliOutputError('BOSS 返回的岗位与所选岗位不一致，未保存任何候选人')
        known = {self.identity(p) for p in excluded}
        known.update(self.identity(RecommendedPerson.model_construct(name=r.name, baseInfo=r.base_info)) for r in recycled)
        added = []
        for person in snapshot.candidates:
            key = self.identity(person)
            if key in known:
                continue
            known.add(key)
            person.online_resume = None
            scoped_key = hashlib.sha256(dumps([job.id, key]).encode('utf-8')).hexdigest()
            row = RecommendedCandidateRecord(identity_key=scoped_key, person_json=person.model_dump_json(), source_job=job.label)
            self.db.add(row)
            self.db.flush()
            added.append(row.id)
        snapshot.candidates = []
        job_cache = self.db.get(RecommendationSnapshotRecord, f'job:{job.id}')
        if job_cache is None:
            self.db.add(RecommendationSnapshotRecord(id=f'job:{job.id}', snapshot_json=snapshot.model_dump_json()))
        else:
            job_cache.snapshot_json = snapshot.model_dump_json()
        latest = self.db.get(RecommendationSnapshotRecord, 'latest')
        if latest is None:
            self.db.add(RecommendationSnapshotRecord(id='latest', snapshot_json=snapshot.model_dump_json()))
        else:
            latest.snapshot_json = snapshot.model_dump_json()
        self.db.commit()
        return RecommendationReadResult(**self.recommendations(job.id).model_dump(), added_ids=added)

    async def classify(self, ids: list[str], *, accept_incoming_resumes: bool = False) -> LocalCandidateListResponse:
        if not 1 <= len(ids) <= 10 or len(set(ids)) != len(ids):
            raise ValueError('每次仅可核验 1 到 10 位不同候选人')
        rows = [self.db.get(CandidateRecord, candidate_id) for candidate_id in ids]
        if any(row is None for row in rows):
            raise LookupError('所选候选人不存在，请刷新列表')
        local = LocalStoreService(self.db)
        eligible = build_active_recommendation_index(self.db, greeted_only=True)
        unique_chats = unambiguous_stored_chat_keys(self.db)
        if any(not local._candidate_in_recommendations(row.id, index=eligible, unique_chat_keys=unique_chats) for row in rows):
            raise ValueError('核验名单中有人不在已打招呼的推荐牛人范围内，请重新同步')
        targets = []
        for row in rows:
            source = loads(row.source_snapshot, {})
            if not source.get('job'):
                raise ValueError('候选人缺少来源岗位，请先同步')
            if not source.get('source_id'):
                raise ValueError('候选人缺少 BOSS 会话编号，请先同步后核验；旧的同名记录需要人工确认')
            targets.append({'id': row.id, 'sourceId': source['source_id'], 'name': row.name, 'job': source['job']})
        if accept_incoming_resumes and get_settings().automation_emergency_stop:
            raise ValueError('紧急停止已开启，未执行附件简历同意操作')
        args = ['classify', '--targets', dumps(targets)]
        if accept_incoming_resumes:
            args.append('--accept-incoming-resumes')
        result = await self.adapter.run(*args)
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

    async def download_attachment(self, candidate_id: str, job_id: str) -> tuple[ResumeResponse, bool, str]:
        row = self.db.get(CandidateRecord, candidate_id)
        if row is None:
            raise LookupError('所选沟通候选人不存在，请刷新列表')
        job = self.db.get(JobRecord, job_id)
        if job is None:
            raise LookupError('所选岗位不存在，请刷新列表')
        local = LocalStoreService(self.db)
        if not local._candidate_in_recommendations(candidate_id, job_id=job_id,
                index=build_active_recommendation_index(self.db, greeted_only=True),
                unique_chat_keys=unambiguous_stored_chat_keys(self.db)):
            raise ValueError('该候选人不属于当前岗位已保留、已打招呼的推荐牛人')
        if local._candidate_view(row).communication_status != 'mutual':
            raise ValueError('仅可下载双方已沟通候选人的附件简历，请先同步核验')
        resumes = ResumeService(self.db, get_settings())
        export_root = (Path(get_settings().data_dir).resolve() / 'downloaded-resumes').resolve()
        saved = self.db.scalar(select(CommunicationAttachmentRecord).where(
            CommunicationAttachmentRecord.candidate_id == candidate_id,
            CommunicationAttachmentRecord.job_id == job_id))
        if saved:
            export_path = (export_root / saved.export_path).resolve()
            if not export_path.is_relative_to(export_root):
                raise ValueError('已保存附件的路径无效，未重新下载')
            document = self.db.get(ResumeDocumentRecord, saved.resume_id)
            if document and export_path.is_file() and resumes.path(document.id).is_file():
                return resumes.get(document.id), True, str(export_path.parent)
            self.db.delete(saved)
            self.db.commit()
        source = loads(row.source_snapshot, {})
        if not source.get('source_id') or not source.get('job'):
            raise ValueError('候选人缺少准确的 BOSS 会话编号或来源岗位，请先同步')
        target = {'id': candidate_id, 'sourceId': source['source_id'], 'name': row.name, 'job': source['job']}
        root = Path(get_settings().data_dir).resolve()
        root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='attachment-', dir=root) as folder:
            path = Path(folder) / 'attachment.pdf'
            result = await self.adapter.run('download-attachment', '--target', dumps(target), '--output', str(path))
            try:
                receipt = loads(result.stdout, {})
                if receipt.get('version') != 1 or receipt.get('id') != candidate_id or receipt.get('source_id') != source['source_id'] or receipt.get('name') != row.name or receipt.get('job') != source['job']:
                    raise ValueError('附件下载回执的候选人身份不匹配')
                data = path.read_bytes()
                if len(data) != receipt.get('size') or not data.startswith(b'%PDF-'):
                    raise ValueError('附件文件与下载回执不一致')
            except (OSError, ValueError, TypeError) as error:
                raise BossCliOutputError(f'附件下载结果无效：{error}') from error
            resume = resumes.import_file(candidate_id, receipt['original_name'], 'application/pdf', data)
            safe_job = re.sub(r'[\\/:*?"<>|]', '_', job.title).strip(' .')[:80] or '未命名岗位'
            safe_name = re.sub(r'[\\/:*?"<>|]', '_', row.name).strip(' .')[:50] or candidate_id[:8]
            safe_file = re.sub(r'[\\/:*?"<>|]', '_', resume.original_name).strip(' .')[:100]
            relative = Path(f'{safe_job}-{job_id[:8]}') / f'{safe_name}-{resume.id[:8]}-{safe_file}'
            export_path = export_root / relative
            export_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = export_path.with_name(export_path.name + f'.{uuid.uuid4().hex}.tmp')
            try:
                copyfile(resumes.path(resume.id), temporary)
                temporary.replace(export_path)
                self.db.add(CommunicationAttachmentRecord(candidate_id=candidate_id, job_id=job_id,
                    resume_id=resume.id, export_path=str(relative)))
                self.db.commit()
            finally:
                temporary.unlink(missing_ok=True)
            return resume, False, str(export_path.parent)
