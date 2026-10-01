# 渔港与渔船档案地图（sologsb-1128 / gbfishport）

面向渔港管理站、渔业合作社与船东的**纯前端单页应用**：把渔港泊位条件、渔船技术档案、进出港动态与台风避风预排集中到一张图上核对。
支持登记泊位与补给能力、建立含主机功率、吨位与吃水的渔船档案、记录进出港与泊位占用，以及合作社 / 值班室双机离线排泊后按稳定编号整份合并。

## 一键启动（Docker Compose）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21828>

停止：

```bash
docker compose down
```

## 技术栈

| 分类 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + TypeScript） |
| 构建 | Vite 5 |
| UI | Element Plus 2 |
| 状态 | Pinia |
| 路由 | Vue Router 4（history 模式，nginx `try_files` 兜底） |
| 本地存储 | IndexedDB（Dexie 4，库名 `gbfishport-db`）+ localStorage（表单草稿） |
| 地图 | 高德地图 JS API（`VITE_AMAP_KEY`），未配置 key 时降级为本地 SVG 网格视图 |
| 托管 | nginx:alpine（gzip + 前端路由回退） |
## 目录结构

```
sologsb-1128/
├── docker-compose.yml          # 无 version 字段；顶层 name: gbfishport
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── frontend/
│   ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # port.ts / vessel.ts / call.ts / berth.ts / shelter.ts（5 个数据模型）
│       ├── stores/             # portStore.ts / vesselStore.ts / shelterStore.ts / uiStore.ts
│       ├── db/                 # index.ts（Dexie v1→v4 迁移）/ berth.ts / seed.ts
│       ├── components/common/  # PortCard / BerthGrid / VesselSpecTable / MapPanel / ShelterSideEditor / ShelterAssignmentTable / EmptyState
│       ├── hooks/              # useAmapLoader / useBerthStatus / useLocalDraft
│       ├── pages/              # PortList / PortDetail / VesselList / VesselDetail / CallBoard / ShelterBoard / MapView
│       ├── router/index.ts
│       └── utils/              # tonnage.ts / geo.ts / format.ts
└── README.md
```

## 页面与路由

| 路由 | 说明 | 消费模型 |
| --- | --- | --- |
| `/` | 渔港一览：卡片展示等级、泊位数、在港船数与占用率，支持按等级与避风能力筛选 | FishingPort、Berth、PortCall |
| `/ports/:id` | 渔港详情：基本信息与补给能力、SVG 泊位网格（点击查看占用船舶）、在港船舶与近日流水 | 四个模型 |
| `/vessels` | 渔船检索：按作业类型、主机功率区间、总吨位与船籍港组合查询 | FishingVessel |
| `/vessels/:id` | 渔船档案详情：主尺度、主机功率、作业类型、证书有效期与进出港时间线 | FishingVessel、PortCall |
| `/calls` | 进出港登记：选择渔船与类型，填写泊位号、加冰量、加油量、卸货量并同步泊位状态 | PortCall、Berth、FishingVessel |
| `/shelter` | 避风预排：台风警报后合作社 / 值班室两台电脑断网排泊，按吃水适配泊位、同泊位时段不重叠，回港按稳定编号整份合并，落实/失效留痕 | ShelterPlan、BerthAssignment、Berth、FishingVessel、PortCall |
| `/map` | 渔港与在港渔船分布：高德 JS API 标记，未配置 key 时为 SVG 网格视图，点选弹出泊位占用摘要 | FishingPort、Berth、ShelterPlan |

## 数据存储说明

- **业务数据走 IndexedDB（Dexie）**，库名 `gbfishport-db`，含版本号与升级迁移：
  - `v1`：建 `ports`、`vessels` 表
  - `v2`：新增 `calls` 表与 `vesselId` 索引
  - `v3`：新增 `berths` 表，并按每个渔港登记的泊位数生成初始泊位记录
  - `v4`：新增 `shelterPlans` 表（避风预排），并为历史渔船档案按船长回填吃水 `draftDepth`
- **表单草稿走 localStorage**（键前缀 `gbfishport:draft:`），例如进出港登记草稿 `gbfishport:draft:call-board`，提交成功后自动清空。
- 首次打开会自动写入一组演示数据（4 座渔港、6 艘渔船、8 条进出港流水与对应泊位、2 份台风避风预排方案），便于直接查看各页面效果。
- 容器无状态：不使用数据库服务、不挂载命名卷，清空浏览器站点数据即可重置。

## 避风预排（离线双机 → 稳定编号合并）

台风警报拉响后，**合作社**与**值班室**各用一台电脑断网给渔船排避风泊位，回到港区时安排只能**整份覆盖**合并：

1. **建警报与时段**：在 `/shelter` 选择渔港、填写台风名、约定若干靠泊时段（两台电脑共用同一套稳定时段）。
2. **水深适配排泊**：按渔船吃水 `draftDepth` 与泊位设计水深 `designDepth` 适配，深吃水船优先、泊位由浅到深择优；维修泊位、水深不足泊位、与港内已有占用或本侧已排安排时段重叠的泊位一律跳过；同一泊位的靠泊时段不重叠。
3. **容量不足留待排**：排不下 / 无适配深泊位的渔船进入该侧「待排」；合并后保留已排船只并汇总仍待排的数量。
4. **两侧离线整份草稿**：合作社 / 值班室各一个 Tab，改动随时整份存入 IndexedDB（`coop` / `duty` 两个 SideDraft，互不覆盖）。
5. **稳定编号合并**：靠泊安排主键 `key = 港口id|泊位号|靠泊时间ISO`。
   - 仅一侧排了 → 直接并入；
   - 两侧编号一致且船 / 离泊时间一致 → 视为同一条；
   - **同一时段两边都改且不一致（不同船 / 离泊时间不同）→ 列出冲突**，同时校验同泊位时段重叠、水深不足、港内占用等硬性违反；
   - 有冲突 / 违反或合并异常时**不覆盖权威结果、两侧原草稿保留（即恢复原草稿）**，修订号不增长。
6. **预排后登记实际进出港**：在 `/calls` 登记实际靠 / 离泊后自动对账——实际泊位与预排一致且时间偏差 ≤3 小时记为「已落实」；泊位变了或时间变了让旧安排「失效」，安排记录与事件都写入 `history`，**失效不丢历史**。
7. **同一批结果多处可见**：避风靠泊表同时出现在避风预排页、渔港详情、渔船档案与地图（节点右上角橙色徽标显示已排船数，红色表示有合并冲突）。

纯算法（自动排泊 / 合并 / 对账）位于 `src/utils/shelter.ts`，可用 `npm run check:shelter` 跑 37 项断言核对。

## 高德地图 Key（可选）

`VITE_AMAP_KEY` 留空时**不会**请求任何外部地图服务，`useAmapLoader()` 立即返回降级标记，页面渲染本地 SVG 网格视图（可点选查看泊位占用）。需要真实底图时，在 `.env` 中填入 key 后重新构建：

```bash
VITE_AMAP_KEY=your-key docker compose up -d --build
```

## 本地开发（可选）

```bash
cd frontend
npm install
npm run dev
```

构建校验（类型检查 + 打包）：`npm run build`（等价于 `vue-tsc -b && vite build`）。
