<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { usePortStore } from '../stores/portStore';
import { useVesselStore } from '../stores/vesselStore';
import { useShelterStore } from '../stores/shelterStore';
import ShelterSideEditor from '../components/common/ShelterSideEditor.vue';
import ShelterAssignmentTable from '../components/common/ShelterAssignmentTable.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { PlanSide, ArrangeSlot } from '../types/shelter';
import { PLAN_SIDE_LABEL, PLAN_SIDES } from '../types/shelter';
import type { FishingVessel } from '../types/vessel';
import { formatDateTime, formatNumber, nowLocalInputValue, toLocalInputValue } from '../utils/format';
import { groupAssignmentsBySlot } from '../utils/shelter';

const portStore = usePortStore();
const vesselStore = useVesselStore();
const shelterStore = useShelterStore();

const loaded = ref(false);
const activeSide = ref<PlanSide>('coop');

const createVisible = ref(false);
const creating = ref(false);

interface SlotFormRow {
  label: string;
  range: [string, string] | null;
}
const createForm = reactive({
  portId: '',
  typhoonName: '',
  alertAt: nowLocalInputValue(),
  slots: [
    { label: '第一批 08:00-14:00', range: null },
    { label: '第二批 14:00-20:00', range: null },
  ] as SlotFormRow[],
});

const portOptions = computed(() => portStore.ports);

const currentPlan = computed(() => shelterStore.activePlan);
const currentPort = computed(() =>
  currentPlan.value ? portStore.portById(currentPlan.value.portId) : undefined,
);
const currentBerths = computed(() =>
  currentPlan.value ? portStore.berthsOf(currentPlan.value.portId) : [],
);

/** 避风渔船名册：按吃水从深到浅，深吃水船优先安排便于核对 */
const shelterVessels = computed<FishingVessel[]>(() =>
  [...vesselStore.vessels].sort((a, b) => b.draftDepth - a.draftDepth),
);

const vesselNames = computed(() => new Map(vesselStore.vessels.map((v) => [v.id, v.name])));

const mergedGroups = computed(() => (currentPlan.value ? groupAssignmentsBySlot(currentPlan.value) : []));

const pendingVessels = computed(() =>
  currentPlan.value ? shelterStore.pendingVesselsOfPlan(currentPlan.value, vesselNames.value) : [],
);

const mergeStatus = computed(() => {
  const plan = currentPlan.value;
  if (!plan || plan.lastMergeOk === null) return null;
  return plan.lastMergeOk
    ? { type: 'success' as const, text: `最近一次合并成功（修订 r${plan.revision} · ${formatDateTime(plan.mergedAt)}）` }
    : { type: 'error' as const, text: '最近一次合并失败，已保留两台电脑原草稿' };
});

onMounted(async () => {
  await Promise.all([
    portStore.ports.length ? Promise.resolve() : portStore.loadAll(),
    vesselStore.vessels.length ? Promise.resolve() : vesselStore.loadAll(),
    shelterStore.plans.length ? Promise.resolve() : shelterStore.loadAll(),
  ]);
  loaded.value = true;
});

function selectPlan(id: string): void {
  shelterStore.setActive(id);
}

function openCreate(): void {
  createForm.portId = portStore.ports[0]?.id ?? '';
  createForm.typhoonName = '';
  createForm.alertAt = nowLocalInputValue();
  createForm.slots = [
    { label: '第一批 08:00-14:00', range: defaultSlotRange(8, 14) },
    { label: '第二批 14:00-20:00', range: defaultSlotRange(14, 20) },
  ];
  createVisible.value = true;
}

function defaultSlotRange(startHour: number, endHour: number): [string, string] {
  const base = new Date();
  base.setDate(base.getDate() + 1);
  const at = (h: number) => {
    const d = new Date(base);
    d.setHours(h, 0, 0, 0);
    return toLocalInputValue(d);
  };
  return [at(startHour), at(endHour)];
}

function addSlotRow(): void {
  createForm.slots.push({ label: `第${createForm.slots.length + 1}批`, range: null });
}

function removeSlotRow(index: number): void {
  createForm.slots.splice(index, 1);
}

async function submitCreate(): Promise<void> {
  if (!createForm.portId) {
    ElMessage.warning('请选择避风渔港');
    return;
  }
  if (!createForm.typhoonName.trim()) {
    ElMessage.warning('请填写台风警报名称');
    return;
  }
  const slots: ArrangeSlot[] = [];
  for (const row of createForm.slots) {
    if (!row.range || !row.range[0] || !row.range[1]) {
      ElMessage.warning(`时段「${row.label || '未命名'}」的起止时间不完整`);
      return;
    }
    if (new Date(row.range[0]).getTime() >= new Date(row.range[1]).getTime()) {
      ElMessage.warning(`时段「${row.label}」靠泊时间需早于离泊时间`);
      return;
    }
    slots.push({
      label: row.label.trim() || '未命名时段',
      startAt: new Date(row.range[0]).toISOString(),
      endAt: new Date(row.range[1]).toISOString(),
    });
  }
  slots.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

  creating.value = true;
  try {
    const plan = await shelterStore.createPlan({
      portId: createForm.portId,
      typhoonName: createForm.typhoonName,
      alertAt: new Date(createForm.alertAt).toISOString(),
      slots,
    });
    createVisible.value = false;
    ElMessage.success(`已为「${plan.typhoonName}」建立避风预排，两台电脑可分别离线排泊`);
  } catch (error) {
    ElMessage.error(`建立预排失败：${(error as Error).message}`);
  } finally {
    creating.value = false;
  }
}

async function onAutoArrange(side: PlanSide, slot: ArrangeSlot, vesselIds: string[]): Promise<void> {
  const plan = currentPlan.value;
  if (!plan) return;
  const vessels = vesselIds
    .map((id) => vesselStore.vesselById(id))
    .filter((v): v is FishingVessel => Boolean(v))
    .map((v) => ({ id: v.id, name: v.name, draftDepth: v.draftDepth }));
  const result = await shelterStore.autoArrangeSide(plan.id, side, slot, vessels, currentBerths.value);
  if (result.unplaced.length) {
    ElMessage.warning(
      `${PLAN_SIDE_LABEL[side]}「${slot.label}」已排 ${result.placed} 艘，${result.unplaced.length} 艘无适配空闲泊位，记入待排`,
    );
  } else {
    ElMessage.success(`${PLAN_SIDE_LABEL[side]}「${slot.label}」已排 ${result.placed} 艘`);
  }
}

async function onAddAssignment(
  side: PlanSide,
  slot: ArrangeSlot,
  berthNo: string,
  vesselId: string,
): Promise<void> {
  const plan = currentPlan.value;
  const vessel = vesselStore.vesselById(vesselId);
  const berth = currentBerths.value.find((b) => b.berthNo === berthNo);
  if (!plan || !vessel || !berth) return;
  const result = await shelterStore.setSideAssignment(plan.id, side, {
    portId: plan.portId,
    berthNo,
    berthDepth: berth.designDepth,
    vesselId: vessel.id,
    vesselName: vessel.name,
    vesselDraft: vessel.draftDepth,
    slot,
  });
  if (!result.ok) ElMessage.warning(result.reason);
  else ElMessage.success(`${PLAN_SIDE_LABEL[side]}已把 ${vessel.name} 排到 ${berthNo}`);
}

async function onRemoveAssignment(side: PlanSide, key: string): Promise<void> {
  const plan = currentPlan.value;
  if (!plan) return;
  await shelterStore.removeSideAssignment(plan.id, side, key);
  ElMessage.info('已从该侧草稿移除');
}

async function runMerge(): Promise<void> {
  const plan = currentPlan.value;
  if (!plan) return;
  const outcome = await shelterStore.merge(plan.id, currentBerths.value);
  if (outcome.ok) {
    ElMessage.success(
      `合并成功：共 ${outcome.mergedCount} 条靠泊安排${outcome.pendingCount ? `，${outcome.pendingCount} 艘待排` : ''}`,
    );
  } else {
    const parts: string[] = [];
    if (outcome.conflictCount) parts.push(`${outcome.conflictCount} 处同时段冲突`);
    if (outcome.violationCount) parts.push(`${outcome.violationCount} 项时段重叠 / 水深违反`);
    ElMessage.error(`合并失败（${parts.join('，')}），已恢复保留合作社与值班室原草稿`);
  }
}

async function removePlan(): Promise<void> {
  const plan = currentPlan.value;
  if (!plan) return;
  try {
    await ElMessageBox.confirm(`确定删除「${plan.typhoonName}」避风预排？两侧草稿与历史一并删除。`, '删除避风预排', {
      type: 'warning',
    });
  } catch {
    return;
  }
  await shelterStore.removePlan(plan.id);
  ElMessage.success('已删除避风预排');
}

const statusTagType = (status: string): 'success' | 'info' | 'warning' =>
  status === '已落实' ? 'success' : status === '已失效' ? 'info' : 'warning';

function sideCount(side: PlanSide): number {
  return currentPlan.value?.[side].assignments.length ?? 0;
}
</script>

<template>
  <section class="page">
    <header class="page__head">
      <div>
        <h1>避风预排</h1>
        <p class="page__sub">
          台风警报后合作社与值班室两台电脑断网排泊，按吃水适配泊位水深、同泊位时段不重叠；回港按稳定编号整份合并
        </p>
      </div>
      <el-button type="primary" data-testid="new-shelter-plan" @click="openCreate">新建避风预排</el-button>
    </header>

    <el-card shadow="never" class="filter-card" v-if="shelterStore.sortedPlans.length">
      <div class="plan-bar">
        <span class="plan-bar__label">选择预排方案：</span>
        <el-radio-group v-model="shelterStore.activeId" @change="selectPlan(String($event))">
          <el-radio-button v-for="p in shelterStore.sortedPlans" :key="p.id" :value="p.id" :data-testid="`plan-tab-${p.id}`">
            {{ p.typhoonName }} · {{ portStore.portById(p.portId)?.name ?? p.portId }}
          </el-radio-button>
        </el-radio-group>
      </div>
    </el-card>

    <template v-if="currentPlan && currentPort">
      <el-alert
        :title="`${currentPlan.typhoonName} · ${currentPort.name} · 警报拉响 ${formatDateTime(currentPlan.alertAt)} · 修订 r${currentPlan.revision}`"
        :type="currentPlan.lastMergeOk === false ? 'error' : 'warning'"
        show-icon
        :closable="false"
        class="plan-alert"
        data-testid="plan-banner"
      />

      <el-alert
        v-if="mergeStatus"
        :title="mergeStatus.text"
        :type="mergeStatus.type"
        show-icon
        :closable="false"
        class="plan-alert"
        data-testid="merge-status"
      />

      <el-card shadow="never" class="detail-card">
        <template #header>
          <div class="card-head">
            <span class="card-title">两台电脑离线排泊（合作社 / 值班室）</span>
            <div>
              <el-button type="primary" data-testid="run-merge" @click="runMerge">回港合并两侧安排</el-button>
              <el-button text type="danger" @click="removePlan">删除方案</el-button>
            </div>
          </div>
        </template>

        <el-tabs v-model="activeSide" data-testid="side-tabs">
          <el-tab-pane v-for="side in PLAN_SIDES" :key="side" :name="side">
            <template #label>
              <el-tag :type="side === 'coop' ? 'primary' : 'success'" size="small" effect="plain">
                {{ PLAN_SIDE_LABEL[side] }} · {{ sideCount(side) }} 条
              </el-tag>
            </template>
            <ShelterSideEditor
              :plan="currentPlan"
              :side="side"
              :draft="currentPlan[side]"
              :vessels="shelterVessels"
              :berths="currentBerths"
              @auto-arrange="onAutoArrange"
              @add-assignment="onAddAssignment"
              @remove-assignment="onRemoveAssignment"
            />
          </el-tab-pane>
        </el-tabs>
      </el-card>

      <el-card v-if="currentPlan.conflicts.length" shadow="never" class="detail-card conflict-card" data-testid="conflict-panel">
        <template #header><span class="card-title conflict-title">合并冲突（{{ currentPlan.conflicts.length }}）· 同一时段两边都改</span></template>
        <el-table :data="currentPlan.conflicts" size="small" border>
          <el-table-column prop="slotLabel" label="时段" min-width="160" />
          <el-table-column prop="berthNo" label="泊位" width="80" />
          <el-table-column label="合作社" min-width="130">
            <template #default="scope">{{ scope.row.coop?.vesselName ?? '—' }}</template>
          </el-table-column>
          <el-table-column label="值班室" min-width="130">
            <template #default="scope">{{ scope.row.duty?.vesselName ?? '—' }}</template>
          </el-table-column>
          <el-table-column prop="detail" label="冲突说明" min-width="200" />
        </el-table>
      </el-card>

      <el-card v-if="currentPlan.violations.length" shadow="never" class="detail-card" data-testid="violation-panel">
        <template #header><span class="card-title conflict-title">硬性违反项（{{ currentPlan.violations.length }}）</span></template>
        <ul class="violation-list">
          <li v-for="(v, i) in currentPlan.violations" :key="i">{{ v }}</li>
        </ul>
      </el-card>

      <el-card shadow="never" class="detail-card">
        <template #header>
          <span class="card-title">
            合并结果 · 权威避风靠泊表（{{ currentPlan.merged.length }} 条
            <template v-if="pendingVessels.length"> · 待排 {{ pendingVessels.length }} 艘</template>）
          </span>
        </template>

        <div v-if="mergedGroups.length">
          <div v-for="group in mergedGroups" :key="group.startAt" class="merged-group" :data-testid="`merged-group-${group.slotLabel}`">
            <p class="merged-group__title">
              {{ group.slotLabel }}
              <span class="merged-group__time">{{ formatDateTime(group.startAt) }} ~ {{ formatDateTime(group.endAt) }}</span>
            </p>
            <ShelterAssignmentTable :assignments="group.items" dense />
          </div>
        </div>
        <EmptyState
          v-else
          title="尚未合并出权威靠泊表"
          description="两台电脑分别排泊后，点击「回港合并两侧安排」；不同时段直接并入，同一时段两边都改会列出冲突。"
        />

        <el-alert
          v-if="pendingVessels.length"
          type="warning"
          show-icon
          :closable="false"
          class="pending-alert"
          data-testid="pending-panel"
          :title="`泊位容量 / 水深不足，合并后仍有 ${pendingVessels.length} 艘待排（已排船只保留）`"
        >
          <div class="pending-tags">
            <el-tag v-for="v in pendingVessels" :key="v.id" type="warning" size="small" effect="plain">{{ v.name }}</el-tag>
          </div>
        </el-alert>
      </el-card>

      <el-card shadow="never" class="detail-card">
        <template #header><span class="card-title">落实 / 失效留痕（{{ currentPlan.history.length }}）· 安排失效但历史不丢</span></template>
        <el-timeline v-if="currentPlan.history.length" data-testid="shelter-history">
          <el-timeline-item
            v-for="h in [...currentPlan.history].reverse()"
            :key="h.id"
            :timestamp="formatDateTime(h.at)"
            :type="h.result === '已落实' ? 'success' : 'info'"
            placement="top"
          >
            <div class="history-row">
              <el-tag size="small" :type="statusTagType(h.result)" effect="plain">{{ h.result }}</el-tag>
              <b>{{ h.vesselName }}</b>
              <span>{{ h.slotLabel }} · 预排 {{ h.berthNo }}</span>
              <template v-if="h.actualBerthNo">· 实际 {{ h.actualBerthNo }}（{{ formatDateTime(h.actualTime) }}）</template>
            </div>
            <p class="history-reason">{{ h.reason }}</p>
          </el-timeline-item>
        </el-timeline>
        <p v-else class="empty-line">预排后到「进出港登记」登记实际靠离泊，系统会自动对账：泊位 / 时间变化让旧安排失效并在此留痕。</p>
      </el-card>
    </template>

    <EmptyState
      v-else-if="loaded"
      title="还没有避风预排方案"
      description="台风警报拉响后新建预排，约定靠泊时段，合作社与值班室即可在各自电脑断网排泊。"
    >
      <el-button type="primary" @click="openCreate">新建避风预排</el-button>
    </EmptyState>

    <el-dialog v-model="createVisible" title="新建避风预排" width="640px" data-testid="create-plan-dialog">
      <el-form label-width="110px">
        <el-form-item label="避风渔港" required>
          <el-select v-model="createForm.portId" placeholder="选择渔港" style="width: 100%" data-testid="create-plan-port">
            <el-option v-for="p in portOptions" :key="p.id" :label="`${p.name}（水深 ${formatNumber(p.berthDepth)}m · ${p.berthCount} 泊位）`" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="台风警报" required>
          <el-input v-model="createForm.typhoonName" placeholder="如：18号台风「海燕」" data-testid="create-plan-name" />
        </el-form-item>
        <el-form-item label="警报拉响时间">
          <el-date-picker v-model="createForm.alertAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" style="width: 100%" data-testid="create-plan-alert" />
        </el-form-item>

        <el-divider content-position="left">约定靠泊时段（两台电脑共用稳定时段）</el-divider>
        <div v-for="(row, index) in createForm.slots" :key="index" class="slot-row" :data-testid="`create-slot-${index}`">
          <el-input v-model="row.label" placeholder="时段名" style="width: 190px" />
          <el-date-picker
            v-model="row.range"
            type="datetimerange"
            range-separator="~"
            start-placeholder="靠泊"
            end-placeholder="离泊"
            value-format="YYYY-MM-DDTHH:mm"
            style="flex: 1"
          />
          <el-button text type="danger" :disabled="createForm.slots.length <= 1" @click="removeSlotRow(index)">删除</el-button>
        </div>
        <el-button text type="primary" data-testid="add-slot-row" @click="addSlotRow">+ 增加时段</el-button>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" data-testid="submit-create-plan" @click="submitCreate">建立预排</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.page__head h1 {
  margin: 0;
  font-size: 22px;
  color: #17324d;
}
.page__sub {
  margin: 6px 0 0;
  font-size: 13px;
  color: #6b7c8c;
}
.filter-card,
.detail-card {
  border-radius: 10px;
}
.detail-card {
  margin-bottom: 0;
}
.plan-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.plan-bar__label {
  font-size: 13px;
  color: #5b6b7b;
}
.plan-alert {
  border-radius: 10px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.card-title {
  font-weight: 600;
  color: #17324d;
}
.conflict-card {
  border-color: #f5c6cb;
}
.conflict-title {
  color: #c45656;
}
.violation-list {
  margin: 0;
  padding-left: 18px;
  color: #c45656;
  font-size: 13px;
}
.merged-group {
  margin-bottom: 14px;
}
.merged-group__title {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 600;
  color: #17324d;
}
.merged-group__time {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: #8592a0;
}
.pending-alert {
  margin-top: 12px;
  border-radius: 8px;
}
.pending-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.history-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #4b5c6d;
}
.history-reason {
  margin: 4px 0 0;
  font-size: 12px;
  color: #8592a0;
}
.empty-line {
  margin: 0;
  font-size: 13px;
  color: #8592a0;
}
.slot-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
</style>
