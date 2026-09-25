# Add New Adapter

添加新平台适配器的引导流程。

## 需要的信息

请提供：
1. **平台 ID**: 小写英文，如 `douyin`
2. **平台名称**: 显示名称，如 `抖音`
3. **平台首页**: 如 `https://www.douyin.com`
4. **发布接口**: 需要调用的 API 端点

## 执行步骤

1. 创建 `packages/core/src/adapters/platforms/{id}.ts`
2. 参考 `docs/adapter-spec.md` 实现必要方法；如平台支持直接发布，声明 `'publish'` 能力并用 `finishWithPublish` 完成发布（见 4.5 节）
3. 在 `packages/core/src/adapters/platforms/index.ts` 导出
4. 在 `packages/extension/src/adapters/index.ts` 注册
5. 运行 `pnpm typecheck && pnpm test && pnpm build` 验证

## 适配器模板

```typescript
import { CodeAdapter, ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('PlatformName')

export class PlatformAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: 'platform-id',
    name: '平台名称',
    icon: 'https://...',
    homepage: 'https://...',
    capabilities: ['article', 'draft'],
  }

  async checkAuth(): Promise<AuthResult> {
    // 检查登录状态
  }

  async publish(article: Article): Promise<SyncResult> {
    // 发布文章
  }
}
```
