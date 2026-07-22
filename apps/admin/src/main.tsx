import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function AdminFoundation() {
  return (
    <main>
      <p className="eyebrow">做成■ / Admin</p>
      <h1>运营与审计控制台</h1>
      <p>
        用户、Workspace、任务、课程、用量、订单与审计将使用独立的后台权限边界。
        当前只建立应用边界，不展示伪造运营指标。
      </p>
      <section aria-labelledby="foundation-title">
        <h2 id="foundation-title">基础状态</h2>
        <p>□ RBAC、正式数据和真实事件仍在后续 ZC 阶段实现。</p>
      </section>
    </main>
  );
}

const root = document.querySelector('#root');
if (root === null) {
  throw new Error('Admin application root is missing');
}

createRoot(root).render(
  <StrictMode>
    <AdminFoundation />
  </StrictMode>,
);

