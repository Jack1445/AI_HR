import { useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Card, Col, Descriptions, Empty, Input, Layout, List, Row, Select, Space, Spin, Statistic, Table, Tag, Typography, message,
} from "antd";
import { CheckCircleOutlined, ReloadOutlined, SafetyOutlined, SyncOutlined } from "@ant-design/icons";
import {
  confirmAction, createAction, fetchCandidateDetail, fetchCandidates, fetchHealth, fetchJobs, fetchLocalCandidates, fetchLocalJobs, fetchPolicy, matchCandidate, syncLocal, updateCandidate,
  type ActionResponse, type AgentPolicy, type Candidate, type CandidateDetail, type HealthResponse, type Job, type LocalCandidate, type LocalJob, type MatchResult,
} from "./api";

const { Header, Content, Footer } = Layout;
const stageOptions = ["new", "contacted", "communicating", "interview_pending", "interviewing", "decision", "offer", "hired", "rejected", "archived"];

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [policy, setPolicy] = useState<AgentPolicy | null>(null);
  const [remoteJobs, setRemoteJobs] = useState<Job[]>([]);
  const [localJobs, setLocalJobs] = useState<LocalJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<LocalJob | Job | null>(null);
  const [localCandidates, setLocalCandidates] = useState<LocalCandidate[]>([]);
  const [remoteCandidates, setRemoteCandidates] = useState<Candidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<CandidateDetail | null>(null);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<ActionResponse | null>(null);

  const displayJobs = useMemo(() => localJobs.length ? localJobs : remoteJobs, [localJobs, remoteJobs]);

  const loadOverview = async () => {
    setLoading(true); setError(null);
    const [healthResult, remoteResult, localResult, policyResult] = await Promise.allSettled([fetchHealth(), fetchJobs(), fetchLocalJobs(), fetchPolicy()]);
    if (healthResult.status === "fulfilled") setHealth(healthResult.value);
    if (remoteResult.status === "fulfilled") setRemoteJobs(remoteResult.value.jobs);
    if (localResult.status === "fulfilled") setLocalJobs(localResult.value.jobs);
    if (policyResult.status === "fulfilled") setPolicy(policyResult.value);
    const failed = [healthResult, remoteResult, localResult, policyResult].find((result) => result.status === "rejected");
    if (failed?.status === "rejected") setError(failed.reason instanceof Error ? failed.reason.message : "部分数据读取失败");
    setLoading(false);
  };

  useEffect(() => { void loadOverview(); }, []);

  const selectJob = async (job: LocalJob | Job) => {
    setSelectedJob(job); setSelectedCandidate(null); setMatch(null); setCandidateLoading(true); setError(null);
    try {
      if ("remote_id" in job) {
        const result = await fetchLocalCandidates({ job_id: job.id, q: query || undefined });
        setLocalCandidates(result.candidates); setRemoteCandidates([]);
      } else {
        const result = await fetchCandidates(job.id);
        setRemoteCandidates(result.candidates); setLocalCandidates([]);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "读取候选人失败"); }
    finally { setCandidateLoading(false); }
  };

  const runSync = async () => {
    setSyncing(true); setError(null);
    try { const result = await syncLocal(); message.success(`同步完成：写入 ${result.records_written} 条`); await loadOverview(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "同步失败"); }
    finally { setSyncing(false); }
  };

  const selectCandidate = async (candidate: LocalCandidate) => {
    try { setSelectedCandidate(await fetchCandidateDetail(candidate.id)); setMatch(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取候选人详情失败"); }
  };

  const changeStage = async (candidate: LocalCandidate, stage: string) => {
    try { const updated = await updateCandidate(candidate.id, { stage, reason: "看板人工更新" }); setLocalCandidates((items) => items.map((item) => item.id === candidate.id ? { ...item, stage: updated.stage, updated_at: updated.updated_at } : item)); if (selectedCandidate?.id === candidate.id) setSelectedCandidate(updated); }
    catch (reason) { message.error(reason instanceof Error ? reason.message : "阶段更新失败"); }
  };

  const runMatch = async () => {
    if (!selectedCandidate || !selectedJob || !("remote_id" in selectedJob)) return;
    try { setMatch(await matchCandidate(selectedCandidate.id, selectedJob.id)); }
    catch (reason) { message.error(reason instanceof Error ? reason.message : "匹配分析失败"); }
  };

  const draftMessage = async () => {
    if (!selectedCandidate) return;
    try { setAction(await createAction({ action_type: "send_message", candidate_id: selectedCandidate.id, job_id: "remote_id" in (selectedJob ?? {}) ? selectedJob?.id : undefined, payload: { text: "您好，感谢您关注这个岗位。方便补充一份简历吗？" } })); }
    catch (reason) { message.error(reason instanceof Error ? reason.message : "创建草稿失败"); }
  };

  const confirmDraft = async () => {
    if (!action) return;
    try { setAction(await confirmAction(action.id)); }
    catch (reason) { message.error(reason instanceof Error ? reason.message : "确认失败"); }
  };

  const localColumns = [
    { title: "候选人", dataIndex: "name", key: "name", render: (value: string, row: LocalCandidate) => <Button type="link" onClick={() => void selectCandidate(row)}>{value}</Button> },
    { title: "阶段", key: "stage", render: (_: unknown, row: LocalCandidate) => <Select size="small" value={row.stage} options={stageOptions.map((stage) => ({ value: stage, label: stage }))} onChange={(stage) => void changeStage(row, stage)} /> },
    { title: "标签", key: "tags", render: (_: unknown, row: LocalCandidate) => row.tags.map((tag) => <Tag key={tag}>{tag}</Tag>) },
    { title: "未读", dataIndex: "unread_count", key: "unread_count" },
    { title: "最近沟通", dataIndex: "latest_time", key: "latest_time" },
    { title: "最近消息", dataIndex: "latest_message", key: "latest_message", ellipsis: true },
  ];
  const remoteColumns = [
    { title: "姓名", dataIndex: "name", key: "name" }, { title: "未读", dataIndex: "unread_count", key: "unread_count" }, { title: "最近沟通", dataIndex: "time", key: "time" }, { title: "最近消息", dataIndex: "message", key: "message", ellipsis: true },
  ];

  return <Layout className="app-shell">
    <Header className="app-header"><div className="brand-mark">AI Recruiter</div><Space><Tag color="blue">Stage 7 · 本地可控</Tag><Tag icon={<SafetyOutlined />} color={policy?.writes_enabled ? "orange" : "green"}>{policy?.writes_enabled ? "BOSS 写入已开启" : "BOSS 写入默认关闭"}</Tag></Space></Header>
    <Content className="app-content">
      <div className="hero-copy"><Typography.Title level={1}>招聘工作台</Typography.Title><Typography.Paragraph>先同步到本地，再在候选人详情中做标注、匹配和人工确认动作。</Typography.Paragraph></div>
      {error && <Alert closable onClose={() => setError(null)} message={error} type="warning" showIcon />}
      <Row gutter={[20, 20]}>
        <Col xs={24} lg={8}><Card title="岗位" extra={<Space><Button size="small" icon={<SyncOutlined />} loading={syncing} onClick={() => void runSync()}>同步</Button><Button size="small" icon={<ReloadOutlined />} onClick={() => void loadOverview()}>刷新</Button></Space>}>
          {loading ? <Spin /> : displayJobs.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无岗位，请先确认 BOSS 已登录" /> : <List<LocalJob | Job> dataSource={displayJobs} renderItem={(job) => <List.Item className={selectedJob && selectedJob.id === job.id ? "job-item job-item-selected" : "job-item"} onClick={() => void selectJob(job)}><Space direction="vertical" size={2}><Typography.Text strong>{job.title}</Typography.Text><Typography.Text type="secondary">{job.status}{job.label ? ` · ${job.label}` : ""}</Typography.Text></Space></List.Item>} />}
        </Card></Col>
        <Col xs={24} lg={16}><Card title="运行状态" extra={<SafetyOutlined />}><Row gutter={24}><Col><Statistic title="后端" value={health?.status === "ok" ? "正常" : "未知"} prefix={<CheckCircleOutlined />} /></Col><Col><Statistic title="岗位" value={localJobs.length || remoteJobs.length} /></Col><Col><Statistic title="本地候选人" value={localCandidates.length} /></Col></Row><Typography.Text type="secondary">{health ? `${health.service} · v${health.version}` : "正在连接…"}</Typography.Text></Card></Col>
        <Col xs={24}><Card title={selectedJob ? `${selectedJob.title} · 候选人` : "候选人列表"} extra={selectedJob && <Input.Search placeholder="搜索姓名或负责人" allowClear value={query} onChange={(event) => setQuery(event.target.value)} onSearch={() => selectedJob && void selectJob(selectedJob)} style={{ width: 220 }} />}>
          {!selectedJob ? <Empty description="请选择一个岗位" /> : candidateLoading ? <Spin tip="正在读取候选人…" /> : localJobs.length > 0 ? <Table<LocalCandidate> rowKey="id" columns={localColumns} dataSource={localCandidates} locale={{ emptyText: "本地暂无候选人，请点击同步" }} pagination={{ pageSize: 10 }} scroll={{ x: 820 }} /> : <Table<Candidate> rowKey={(row) => `${row.name}-${row.time}`} columns={remoteColumns} dataSource={remoteCandidates} locale={{ emptyText: "该岗位暂无已建立沟通的候选人" }} pagination={{ pageSize: 10 }} scroll={{ x: 680 }} />}
        </Card></Col>
        {selectedCandidate && <Col xs={24} lg={10}><Card title={`${selectedCandidate.name} · 候选人详情`} extra={<Tag color="blue">{selectedCandidate.stage}</Tag>}><Descriptions column={1} size="small"><Descriptions.Item label="岗位">{selectedCandidate.job_titles.join("、") || "未绑定"}</Descriptions.Item><Descriptions.Item label="负责人">{selectedCandidate.owner || "未分配"}</Descriptions.Item><Descriptions.Item label="标签">{selectedCandidate.tags.join("、") || "暂无"}</Descriptions.Item><Descriptions.Item label="最近消息">{selectedCandidate.latest_message || "暂无"}</Descriptions.Item></Descriptions><Space wrap><Button onClick={() => void runMatch()} disabled={!selectedJob || !("remote_id" in selectedJob)}>生成匹配建议</Button><Button onClick={() => void draftMessage()}>生成消息草稿</Button></Space>{match && <Alert className="detail-alert" message={`匹配分 ${match.score} · ${match.recommendation}`} description={<Space direction="vertical"><Typography.Text>优势：{match.strengths.join("；") || "暂无充分证据"}</Typography.Text><Typography.Text>风险：{match.risks.join("；") || "暂无"}</Typography.Text><Typography.Text>待确认：{match.questions.join("；") || "暂无"}</Typography.Text></Space>} type="info" showIcon />}{action && <Alert className="detail-alert" message={`动作草稿：${action.status}`} description={<Space direction="vertical"><Typography.Text>{String(action.payload.text ?? "")}</Typography.Text><Button size="small" type="primary" disabled={action.status !== "pending_confirmation"} onClick={() => void confirmDraft()}>人工确认</Button></Space>} type={action.status === "blocked" ? "warning" : "success"} />}</Card></Col>}
        <Col xs={24}><Card title="安全边界"><Space direction="vertical"><Typography.Text>✓ 同步、标签、备注、阶段和匹配结果保存在本地数据库</Typography.Text><Typography.Text>✓ AI 输出标注证据与未知项，只作为人工参考</Typography.Text><Typography.Text>✓ BOSS 写动作必须先生成草稿，再人工确认；默认开关关闭</Typography.Text></Space></Card></Col>
      </Row>
    </Content><Footer className="app-footer">AI Recruiter · 本地数据可追踪 · {new Date().getFullYear()}</Footer>
  </Layout>;
}

export default App;
