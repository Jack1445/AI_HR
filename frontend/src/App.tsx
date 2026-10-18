import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Layout,
  List,
  Row,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import { CheckCircleOutlined, ReloadOutlined, SafetyOutlined } from "@ant-design/icons";

import { fetchCandidates, fetchHealth, fetchJobs, type Candidate, type HealthResponse, type Job } from "./api";

const { Header, Content, Footer } = Layout;

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);

  const loadHealth = () => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchHealth(controller.signal)
      .then(setHealth)
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setHealth(null);
        setError(reason instanceof Error ? reason.message : "无法连接后端");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  };

  useEffect(loadHealth, []);

  const loadJobs = () => {
    setJobsLoading(true);
    setJobsError(null);
    fetchJobs()
      .then((result) => setJobs(result.jobs))
      .catch((reason: unknown) => {
        setJobs([]);
        setJobsError(reason instanceof Error ? reason.message : "无法读取岗位");
      })
      .finally(() => setJobsLoading(false));
  };

  const loadCandidates = (job: Job) => {
    setSelectedJob(job);
    setCandidatesLoading(true);
    setCandidatesError(null);
    fetchCandidates(job.id)
      .then((result) => setCandidates(result.candidates))
      .catch((reason: unknown) => {
        setCandidates([]);
        setCandidatesError(reason instanceof Error ? reason.message : "无法读取候选人");
      })
      .finally(() => setCandidatesLoading(false));
  };

  useEffect(() => {
    loadJobs();
  }, []);

  const candidateColumns = [
    { title: "姓名", dataIndex: "name", key: "name", width: 120 },
    { title: "来源岗位", dataIndex: "job", key: "job", width: 160 },
    { title: "未读", dataIndex: "unread_count", key: "unread_count", width: 70 },
    { title: "最近沟通", dataIndex: "time", key: "time", width: 120 },
    { title: "最近消息", dataIndex: "message", key: "message", ellipsis: true },
  ];

  return (
    <Layout className="app-shell">
      <Header className="app-header">
        <div className="brand-mark">AI Recruiter</div>
        <Tag color="blue">Stage 0 · 只读基线</Tag>
      </Header>
      <Content className="app-content">
        <div className="hero-copy">
          <Typography.Title level={1}>招聘数据，先从可验证开始</Typography.Title>
          <Typography.Paragraph>
            当前版本只连接基础设施和健康检查，为后续读取岗位与候选人数据准备稳定边界。
          </Typography.Paragraph>
        </div>
        <Row gutter={[20, 20]}>
          <Col xs={24} lg={8}>
            <Card
              title="岗位列表"
              extra={<Button size="small" icon={<ReloadOutlined />} loading={jobsLoading} onClick={loadJobs}>刷新</Button>}
            >
              {jobsError && <Alert message={jobsError} type="warning" showIcon />}
              {jobsLoading && !jobsError && <Spin tip="正在读取岗位…" />}
              {!jobsLoading && !jobsError && jobs.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无岗位" />}
              {!jobsLoading && jobs.length > 0 && (
                <List
                  dataSource={jobs}
                  renderItem={(job) => (
                    <List.Item
                      className={selectedJob?.id === job.id ? "job-item job-item-selected" : "job-item"}
                      onClick={() => loadCandidates(job)}
                    >
                      <Space direction="vertical" size={2}>
                        <Typography.Text strong>{job.title}</Typography.Text>
                        <Typography.Text type="secondary">{job.status}{job.label ? ` · ${job.label}` : ""}</Typography.Text>
                      </Space>
                    </List.Item>
                  )}
                />
              )}
            </Card>
          </Col>
          <Col xs={24} lg={16}>
            <Card title="运行状态" extra={<SafetyOutlined />}>
              {loading && <Spin tip="正在连接后端…" />}
              {!loading && health && (
                <Space direction="vertical" size="small">
                  <Typography.Text strong>
                    <CheckCircleOutlined className="success-icon" /> 后端连接正常
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {health.service} · v{health.version} · {new Date(health.timestamp).toLocaleString()}
                  </Typography.Text>
                </Space>
              )}
              {!loading && error && (
                <Space direction="vertical" size="middle">
                  <Alert message={error} description="请确认后端已在 http://localhost:8000 启动。" type="warning" showIcon />
                  <Button icon={<ReloadOutlined />} onClick={loadHealth}>重新检查</Button>
                </Space>
              )}
            </Card>
          </Col>
          <Col xs={24}>
            <Card
              title={selectedJob ? `${selectedJob.title} · 沟通候选人` : "候选人列表"}
              extra={selectedJob && <Button size="small" icon={<ReloadOutlined />} loading={candidatesLoading} onClick={() => loadCandidates(selectedJob)}>刷新</Button>}
            >
              {!selectedJob && <Empty description="请选择一个岗位查看候选人" />}
              {selectedJob && candidatesError && <Alert message={candidatesError} type="warning" showIcon />}
              {selectedJob && candidatesLoading && !candidatesError && <Spin tip="正在读取候选人…" />}
              {selectedJob && !candidatesLoading && !candidatesError && (
                <Table<Candidate>
                  rowKey={(candidate) => `${candidate.name}-${candidate.job}-${candidate.time}`}
                  columns={candidateColumns}
                  dataSource={candidates}
                  locale={{ emptyText: "该岗位暂无已建立沟通的候选人" }}
                  pagination={{ pageSize: 10, showSizeChanger: false }}
                  scroll={{ x: 680 }}
                />
              )}
            </Card>
          </Col>
          <Col xs={24}>
            <Card title="当前边界">
              <Space direction="vertical">
                <Typography.Text>✓ 岗位和候选人数据暂不写入 BOSS</Typography.Text>
                <Typography.Text>✓ 候选人列表来自已建立沟通的会话</Typography.Text>
                <Typography.Text>✓ 当前页面没有发送、打招呼或状态修改按钮</Typography.Text>
              </Space>
            </Card>
          </Col>
        </Row>
      </Content>
      <Footer className="app-footer">AI Recruiter · 本地开发基线</Footer>
    </Layout>
  );
}

export default App;
