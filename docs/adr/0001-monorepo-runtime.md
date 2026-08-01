# ADR-0001：MVP单仓库与运行时基线

- 状态：Accepted
- 日期：2026-08-01

## 背景

MVP由一名项目负责人与Code Agent协作开发，需要避免前后端重复建模和多套部署流程。同时，批量导入、索引重建和模型调用不能阻塞普通Web请求。

## 决策

1. 使用Node.js 22、TypeScript 5.x、pnpm和Turborepo组织单仓库。
2. `apps/web`使用Next.js 15承载页面和Route Handlers。
3. `apps/worker`作为同仓库独立进程，后续承载BullMQ长任务。
4. 稳定Schema和通用类型放入`packages/*`；首个共享包为`@culiu/shared`。
5. CI、Docker构建和正式检查统一使用Node.js 22；开发机上的其他Node.js主版本不作为兼容性依据。
6. MVP不建设独立第二套后端、Skill Runtime、动态Registry或Multi-Agent编排。

## 后果

- Web和Worker共享类型、校验和版本，但保持独立进程边界。
- 新领域能力应按业务边界增加包，不把数据访问、权限、模型和页面逻辑混入共享工具包。
- 任何Node.js主版本升级都必须先通过CI、构建和回归测试，并新增或修订ADR。
