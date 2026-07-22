import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function StudentFoundation() {
  return (
    <main>
      <p className="eyebrow">做成■ / Student</p>
      <h1>把真实任务推进到可核验交付</h1>
      <p>
        正式工作台正在按“任务—资料—证据—结构—初稿—核验—导出”状态机接入。
        当前页面只标识应用边界，不宣称工作流已经完成。
      </p>
      <div className="status" role="status">
        □ ZC-01 应用骨架已建立；正式项目数据将在后续提交接入。
      </div>
    </main>
  );
}

const root = document.querySelector('#root');
if (root === null) {
  throw new Error('Student application root is missing');
}

createRoot(root).render(
  <StrictMode>
    <StudentFoundation />
  </StrictMode>,
);

