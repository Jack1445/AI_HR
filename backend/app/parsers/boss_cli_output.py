import re
from dataclasses import dataclass


class BossCliOutputError(ValueError):
    """The configured boss-cli output did not match the expected contract."""


@dataclass(frozen=True)
class ParsedJob:
    id: str
    title: str
    status: str
    label: str
    meta: tuple[str, ...]
    viewed: int
    chatted: int
    interested: int


@dataclass(frozen=True)
class ParsedJobs:
    jobs: tuple[ParsedJob, ...]
    remote_total: int | None


@dataclass(frozen=True)
class ParsedCandidate:
    name: str
    job: str
    time: str
    message: str
    unread_count: int


@dataclass(frozen=True)
class ParsedCandidates:
    candidates: tuple[ParsedCandidate, ...]
    remote_total: int | None
    unread_total: int | None


_JOB_COUNT_RE = re.compile(r"已读取\s*(\d+)\s*个职位(?:（页面统计：共\s*(\d+)\s*个）)?")
_JOB_LINE_RE = re.compile(r"^\s*\d+\.\s*(?P<body>.+?)\s*$")
_CANDIDATE_LINE_RE = re.compile(r"^\s*\d+\.\s*(?P<body>.+?)\s*$")
_LIST_COUNT_RE = re.compile(r"沟通列表共\s*(\d+)\s*人，其中\s*(\d+)\s*人有未读消息")
_UNREAD_COUNT_RE = re.compile(r"未读筛选：共\s*(\d+)\s*人")


def _to_int(value: str, field: str) -> int:
    try:
        return int(value.strip())
    except ValueError as exc:
        raise BossCliOutputError(f"字段 {field} 不是整数：{value!r}") from exc


def _split_keyed_segments(body: str) -> list[str]:
    return [segment.strip() for segment in body.split("｜") if segment.strip()]


def parse_positions(text: str) -> ParsedJobs:
    lines = text.splitlines()
    header = next((line.strip() for line in lines if line.strip().startswith("已读取")), "")
    count_match = _JOB_COUNT_RE.search(header)
    remote_total = _to_int(count_match.group(2), "页面统计") if count_match and count_match.group(2) else None
    jobs: list[ParsedJob] = []
    in_details = False
    for raw_line in lines:
        line = raw_line.strip()
        if line == "职位明细：":
            in_details = True
            continue
        if not in_details:
            continue
        match = _JOB_LINE_RE.match(line)
        if not match:
            continue
        segments = _split_keyed_segments(match.group("body"))
        if not segments:
            continue
        title = segments[0]
        values: dict[str, str] = {}
        meta: list[str] = []
        keyed_prefixes = ("状态:", "标签:", "看过我:", "沟通过:", "感兴趣:", "ID:")
        for segment in segments[1:]:
            if any(segment.startswith(prefix) for prefix in keyed_prefixes):
                key, value = segment.split(":", 1)
                values[key] = value.strip()
            else:
                meta.append(segment)
        job_id = values.get("ID", "")
        if not job_id:
            raise BossCliOutputError(f"职位“{title}”缺少稳定 ID")
        jobs.append(
            ParsedJob(
                id=job_id,
                title=title,
                status=values.get("状态", "未知"),
                label=values.get("标签", ""),
                meta=tuple(meta),
                viewed=_to_int(values.get("看过我", "0"), "看过我"),
                chatted=_to_int(values.get("沟通过", "0"), "沟通过"),
                interested=_to_int(values.get("感兴趣", "0"), "感兴趣"),
            )
        )
    if count_match and _to_int(count_match.group(1), "职位数量") != len(jobs):
        raise BossCliOutputError(
            f"职位数量不一致：标题声明 {count_match.group(1)}，实际解析 {len(jobs)}"
        )
    return ParsedJobs(jobs=tuple(jobs), remote_total=remote_total)


def parse_candidates(text: str) -> ParsedCandidates:
    lines = text.splitlines()
    first_line = next((line.strip() for line in lines if line.strip()), "")
    list_match = _LIST_COUNT_RE.search(first_line)
    unread_match = _UNREAD_COUNT_RE.search(first_line)
    remote_total = int(list_match.group(1)) if list_match else int(unread_match.group(1)) if unread_match else None
    unread_total = int(list_match.group(2)) if list_match else None
    candidates: list[ParsedCandidate] = []
    in_details = False
    for raw_line in lines:
        line = raw_line.strip()
        if line.startswith("候选人明细："):
            in_details = True
            continue
        if not in_details:
            continue
        if line in {"暂无。", "暂无", "当前页面未读取到候选人。"}:
            continue
        match = _CANDIDATE_LINE_RE.match(line)
        if not match:
            continue
        segments = _split_keyed_segments(match.group("body"))
        if not segments:
            continue
        name = segments[0]
        job = ""
        time = ""
        message = ""
        unread_count = 0
        for index, segment in enumerate(segments[1:]):
            if segment.startswith("未读:"):
                unread_count = _to_int(segment.split(":", 1)[1], "未读")
            elif segment.startswith("时间:"):
                time = segment.split(":", 1)[1].strip()
            elif segment.startswith("消息:"):
                message = "｜".join([segment.split(":", 1)[1].strip(), *segments[index + 2 :]]).strip("｜ ")
                break
            elif not job:
                job = segment
        candidates.append(
            ParsedCandidate(
                name=name,
                job=job,
                time=time,
                message=message,
                unread_count=unread_count,
            )
        )
    if remote_total is not None and remote_total != len(candidates):
        raise BossCliOutputError(
            f"候选人数量不一致：标题声明 {remote_total}，实际解析 {len(candidates)}"
        )
    return ParsedCandidates(
        candidates=tuple(candidates),
        remote_total=remote_total,
        unread_total=unread_total,
    )
