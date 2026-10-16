import { useEffect, useState } from "react";
import { Alert, Button, Card, Col, Layout, Row, Space, Spin, Tag, Typography } from "antd";
import { CheckCircleOutlined, ReloadOutlined, SafetyOutlined } from "@ant-design/icons";

import { fetchHealth, type HealthResponse } from "./api";

const { Header, Content, Footer } = Layout;

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
          <Col xs={24} md={16}>
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
          <Col xs={24} md={8}>
            <Card title="当前边界">
              <Space direction="vertical">
                <Typography.Text>✓ 岗位和候选人数据暂不写入 BOSS</Typography.Text>
                <Typography.Text>✓ 所有外部操作保留人工确认</Typography.Text>
                <Typography.Text>✓ 后续通过 boss-cli 适配层接入</Typography.Text>
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
