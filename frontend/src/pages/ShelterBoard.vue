<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { usePortStore } from '../stores/portStore';
import { useVesselStore } from '../stores/vesselStore';
import { useShelterStore } from '../stores/shelterStore';
import { isDepthCompatible, planCounts } from '../utils/shelter';
import { formatDateTime, formatNumber, nowLocalInputValue, toLocalInputValue } from '../utils/format';
import { sideLabel, type ShelterConflict, type ShelterDraft, type ShelterEntry, type ShelterPlanStatus, type ShelterSide } from '../types/shelter';
import EmptyState from '../components/common/EmptyState.vue';

const portStore = usePortStore();
const vesselStore = useVesselStore();
const shelterStore = useShelterStore();

const portId = ref('');
const typhoonNo = ref('台风202601号');
const windowStart = ref(nowLocalInputValue());
const windowEnd = ref(toLocalInputValue(new Date(Date.now() + 48 * 3600 * 1000)));

const drafts = reactive<Record<ShelterSide, ShelterDraft | null>>({ cooperative: null, duty: null });

const merging = ref(false);
const conflictVisible = ref(false);
const conflicts = ref<ShelterConflict[]>([]);
const resolutions = reactive<Record<string, 'base' | 'incoming'>>({});
const mergedEntries = ref<ShelterEntry[] | null>(null);

const port = computed(() => portStore.portById(portId.value));
const portBerths = computed(() => portStore.berthsOf(portId.value));
const history = computed(() => (portId.value ? shelterStore.plansOfPort(portId.value) : []));
const activePlan = computed(() => (portId.value ? shelterStore.activePlanOfPort(portId.value) : undefined));

function loadDrafts(): void {
  drafts.cooperative = portId.value ? shelterStore.readDraft(portId.value, 'cooperative') : null;
  drafts.duty = portId.value ? shelterStore.readDraft(portId.value, 'duty') : null;
  mergedEntries.value = null;
}

onMounted(async () => {
  if (!portStore.ports.length) await portStore.loadAll();
  if (!vesselStore.vessels.length) await vesselStore.loadAll();
  if (!shelterStore.plans.length) await shelterStore.loadAll();
  portId.value = portStore.ports[0]?.id ?? '';
  loadDrafts();
});

watch(portId, loadDrafts);

function autoSchedule(side: ShelterSide): void {
  if (!portId.value) {
    ElMessage.warning('请先选择渔港');
    return;
  }
  if (!windowStart.value || !windowEnd.value) {
    ElMessage.warning('请先设置预排时段');
    return;
  }
  if (new Date(windowStart.value).getTime() >= new Date(windowEnd.value).getTime()) {
    ElMessage.warning('预排时段的开始时间必须早于结束时间');
    return;
  }
  const draft = shelterStore.autoSchedule(portId.value, side, typhoonNo.value, {
    start: new Date(windowStart.value).toISOString(),
    end: new Date(windowEnd.value).toISOString(),
  });
  drafts[side] = draft;
  mergedEntries.value = null;
  const counts = planCounts(draft.entries);
  ElMessage.success(
    `${sideLabel(side)}离线预排完成：已排 ${counts.scheduled} 艘，待排 ${counts.pending} 艘（草稿已保存在本机）`,
  );
}

/** 某条预排条目可选择的泊位：非维修且水深适配吃水 */
function compatibleBerths(entry: ShelterEntry) {
  return portBerths.value
    .filter((b) => b.status !== '维修' && isDepthCompatible(b, entry.draft))
    .sort((a, b) => a.designDepth - b.designDepth);
}

function onBerthChange(side: ShelterSide, entry: ShelterEntry, berthId: string): void {
  if (!berthId) {
    const draft = shelterStore.updateDraftEntry(portId.value, side, entry.id, {
      berthId: null,
      berthNo: null,
      status: 'pending',
      note: '人工调整为待排',
    });
    if (draft) drafts[side] = draft;
    return;
  }
  const berth = portBerths.value.find((b) => b.id === berthId);
  const draft = shelterStore.updateDraftEntry(portId.value, side, entry.id, {
    berthId,
    berthNo: berth?.berthNo ?? null,
    status: 'scheduled',
    note: undefined,
  });
  if (draft) drafts[side] = draft;
}

function draftCounts(side: ShelterSide) {
  const draft = drafts[side];
  return draft ? planCounts(draft.entries) : { scheduled: 0, pending: 0, invalidated: 0 };
}

function merge(): void {
  if (!drafts.cooperative || !drafts.duty) {
    ElMessage.warning('两边离线草稿都需要先预排保存');
    return;
  }
  merging.value = true;
  try {
    const outcome = shelterStore.mergeDrafts(portId.value);
    if (!outcome.ok) {
      if (outcome.conflicts?.length) {
        conflicts.value = outcome.conflicts;
        for (const c of outcome.conflicts) resolutions[c.entryId] = 'base';
        conflictVisible.value = true;
      } else {
        ElMessage.error(`合并失败，已恢复原草稿：${outcome.error ?? outcome.problems?.join('；') ?? '未知错误'}`);
      }
      return;
    }
    mergedEntries.value = outcome.entries ?? [];
    ElMessage.success('两边草稿合并完成，可整份覆盖为正式安排');
  } finally {
    merging.value = false;
  }
}

function confirmConflicts(): void {
  const outcome = shelterStore.mergeDrafts(portId.value, { ...resolutions });
  if (!outcome.ok) {
    ElMessage.error(`合并失败，已恢复原草稿：${outcome.problems?.join('；') ?? outcome.error ?? '未知错误'}`);
    return;
  }
  conflictVisible.value = false;
  mergedEntries.value = outcome.entries ?? [];
  ElMessage.success('冲突已消解，两边草稿合并完成');
}

async function applyPlan(): Promise<void> {
  if (!mergedEntries.value) return;
  const plan = await shelterStore.applyPlan(portId.value, typhoonNo.value, mergedEntries.value);
  ElMessage.success(`已整份覆盖为正式避风安排（台风 ${plan.typhoonNo}），旧安排已留存历史`);
  mergedEntries.value = null;
  loadDrafts();
}

function entryTagType(entry: ShelterEntry): 'success' | 'info' | 'danger' {
  if (entry.status === 'scheduled') return 'success';
  if (entry.status === 'invalidated') return 'danger';
  return 'info';
}

function planTagType(status: ShelterPlanStatus): 'success' | 'danger' | 'info' {
  if (status === 'active') return 'success';
  if (status === 'invalidated') return 'danger';
  return 'info';
}
</script>

<template>
  <section class="page" data-testid="shelter-page">
    <header class="page__head">
      <div>
        <h1>避风预排</h1>
        <p class="page__sub">
          台风警报拉响后，合作社与值班室各用一台电脑断网预排避风泊位；回到港区时两边草稿按稳定编号合并，安排只能整份覆盖
        </p>
      </div>
    </header>

    <el-alert type="warning" show-icon :closable="false" class="flow-alert">
      <template #title>
        断网单机预排 → 回港合并：两边各排各的，合并时不同条目直接并入；同一泊位时段两边都改过则列出冲突；泊位容量不足时留下已排船只与待排数量。
      </template>
    </el-alert>

    <el-card shadow="never" class="detail-card">
      <template #header><span class="card-title">预排设置</span></template>
      <el-form label-width="110px" class="setting-form">
        <el-form-item label="渔港">
          <el-select
            id="shelter-port"
            v-model="portId"
            placeholder="选择渔港"
            style="width: 260px"
            data-testid="shelter-port-select"
          >
            <el-option v-for="p in portStore.ports" :key="p.id" :label="`${p.name}（水深 ${formatNumber(p.berthDepth)}m）`" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="台风编号">
          <el-input id="shelter-typhoon" v-model="typhoonNo" placeholder="如：台风202601号" style="width: 220px" data-testid="shelter-typhoon-input" />
        </el-form-item>
        <el-form-item label="预排时段">
          <el-date-picker
            id="shelter-window-start"
            v-model="windowStart"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            placeholder="开始时间"
            data-testid="shelter-window-start"
          />
          <span class="range-sep">~</span>
          <el-date-picker
            id="shelter-window-end"
            v-model="windowEnd"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            placeholder="结束时间"
            data-testid="shelter-window-end"
          />
        </el-form-item>
      </el-form>
    </el-card>

    <el-row :gutter="16">
      <el-col :lg="12" :md="24">
        <el-card shadow="never" class="detail-card draft-card" data-testid="shelter-draft-cooperative">
          <template #header>
            <div class="draft-head">
              <span class="card-title">合作社离线草稿</span>
              <el-tag size="small" :type="drafts.cooperative ? 'success' : 'info'" effect="plain">
                {{ drafts.cooperative ? `已保存 ${formatDateTime(drafts.cooperative.savedAt)}` : '本机未保存草稿' }}
              </el-tag>
            </div>
          </template>
          <div class="draft-actions">
            <el-button type="primary" data-testid="shelter-auto-coop" @click="autoSchedule('cooperative')">
              断网自动预排
            </el-button>
            <span class="draft-counts">
              已排 <b>{{ draftCounts('cooperative').scheduled }}</b> 艘 · 待排
              <b>{{ draftCounts('cooperative').pending }}</b> 艘
            </span>
          </div>
          <el-table :data="drafts.cooperative?.entries ?? []" size="small" border empty-text="尚未预排" max-height="420">
            <el-table-column prop="vesselName" label="船名" min-width="120" />
            <el-table-column label="吃水" width="76">
              <template #default="scope">{{ formatNumber(scope.row.draft) }}m</template>
            </el-table-column>
            <el-table-column label="预排泊位" min-width="150">
              <template #default="scope">
                <el-select
                  :model-value="scope.row.berthId ?? ''"
                  size="small"
                  placeholder="待排"
                  :data-testid="`coop-berth-${scope.row.vesselId}`"
                  @change="(val: string) => onBerthChange('cooperative', scope.row, val)"
                >
                  <el-option label="待排（容量不足）" value="" />
                  <el-option
                    v-for="b in compatibleBerths(scope.row)"
                    :key="b.id"
                    :label="`${b.berthNo}（水深 ${formatNumber(b.designDepth)}m）`"
                    :value="b.id"
                  />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="76">
              <template #default="scope">
                <el-tag size="small" :type="entryTagType(scope.row)">{{ scope.row.status === 'scheduled' ? '已排' : '待排' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="note" label="说明" min-width="120">
              <template #default="scope">
                <span class="entry-note">{{ scope.row.note ?? '—' }}</span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :lg="12" :md="24">
        <el-card shadow="never" class="detail-card draft-card" data-testid="shelter-draft-duty">
          <template #header>
            <div class="draft-head">
              <span class="card-title">值班室离线草稿</span>
              <el-tag size="small" :type="drafts.duty ? 'success' : 'info'" effect="plain">
                {{ drafts.duty ? `已保存 ${formatDateTime(drafts.duty.savedAt)}` : '本机未保存草稿' }}
              </el-tag>
            </div>
          </template>
          <div class="draft-actions">
            <el-button type="primary" data-testid="shelter-auto-duty" @click="autoSchedule('duty')">
              断网自动预排
            </el-button>
            <span class="draft-counts">
              已排 <b>{{ draftCounts('duty').scheduled }}</b> 艘 · 待排
              <b>{{ draftCounts('duty').pending }}</b> 艘
            </span>
          </div>
          <el-table :data="drafts.duty?.entries ?? []" size="small" border empty-text="尚未预排" max-height="420">
            <el-table-column prop="vesselName" label="船名" min-width="120" />
            <el-table-column label="吃水" width="76">
              <template #default="scope">{{ formatNumber(scope.row.draft) }}m</template>
            </el-table-column>
            <el-table-column label="预排泊位" min-width="150">
              <template #default="scope">
                <el-select
                  :model-value="scope.row.berthId ?? ''"
                  size="small"
                  placeholder="待排"
                  :data-testid="`duty-berth-${scope.row.vesselId}`"
                  @change="(val: string) => onBerthChange('duty', scope.row, val)"
                >
                  <el-option label="待排（容量不足）" value="" />
                  <el-option
                    v-for="b in compatibleBerths(scope.row)"
                    :key="b.id"
                    :label="`${b.berthNo}（水深 ${formatNumber(b.designDepth)}m）`"
                    :value="b.id"
                  />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="76">
              <template #default="scope">
                <el-tag size="small" :type="entryTagType(scope.row)">{{ scope.row.status === 'scheduled' ? '已排' : '待排' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="note" label="说明" min-width="120">
              <template #default="scope">
                <span class="entry-note">{{ scope.row.note ?? '—' }}</span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="detail-card merge-card">
      <template #header><span class="card-title">回到港区 · 合并两边离线安排</span></template>
      <div class="merge-row">
        <el-button type="success" :loading="merging" data-testid="shelter-merge-btn" @click="merge">
          合并两边草稿
        </el-button>
        <el-button v-if="mergedEntries" type="primary" data-testid="shelter-apply-btn" @click="applyPlan">
          应用安排（整份覆盖）
        </el-button>
        <span v-if="mergedEntries" class="merge-hint">
          合并结果 {{ planCounts(mergedEntries).scheduled }} 艘已排 · {{ planCounts(mergedEntries).pending }} 艘待排，应用后整份覆盖该渔港当前安排
        </span>
      </div>
      <p class="merge-rule">
        合并规则：按稳定编号（se-渔船id）对齐；仅一方有的条目直接并入；泊位或时段不一致列为冲突；合并后校验水深适配、时段不重叠与现有占用，失败则原样恢复两边草稿。
      </p>
    </el-card>

    <el-card shadow="never" class="detail-card" data-testid="shelter-history">
      <template #header><span class="card-title">避风安排历史{{ port ? ` · ${port.name}` : '' }}</span></template>
      <el-table :data="history" size="small" border empty-text="暂无避风安排" row-key="id">
        <el-table-column label="台风编号" min-width="140">
          <template #default="scope">{{ scope.row.typhoonNo }}</template>
        </el-table-column>
        <el-table-column label="预排时段" min-width="260">
          <template #default="scope">
            {{ formatDateTime(scope.row.window.start) }} ~ {{ formatDateTime(scope.row.window.end) }}
          </template>
        </el-table-column>
        <el-table-column label="已排 / 待排 / 失效" width="150">
          <template #default="scope">
            {{ planCounts(scope.row.entries).scheduled }} / {{ planCounts(scope.row.entries).pending }} /
            {{ planCounts(scope.row.entries).invalidated }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="scope">
            <el-tag size="small" :type="planTagType(scope.row.status)">
              {{ scope.row.status === 'active' ? '生效中' : scope.row.status === 'invalidated' ? '已失效' : '已覆盖' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="合并时间" min-width="160">
          <template #default="scope">{{ formatDateTime(scope.row.mergedAt) }}</template>
        </el-table-column>
        <el-table-column type="expand">
          <template #default="scope">
            <el-table :data="scope.row.entries" size="small" border>
              <el-table-column prop="vesselName" label="船名" min-width="120" />
              <el-table-column label="吃水" width="80">
                <template #default="scope">{{ formatNumber(scope.row.draft) }}m</template>
              </el-table-column>
              <el-table-column label="泊位号" width="90">
                <template #default="scope">{{ scope.row.berthNo ?? '待排' }}</template>
              </el-table-column>
              <el-table-column label="状态" width="90">
                <template #default="scope">
                  <el-tag size="small" :type="entryTagType(scope.row)">
                    {{ scope.row.status === 'scheduled' ? '已排' : scope.row.status === 'pending' ? '待排' : '失效' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="invalidatedReason" label="失效原因 / 说明" min-width="220">
                <template #default="scope">
                  <span class="entry-note">{{ scope.row.invalidatedReason ?? scope.row.note ?? '—' }}</span>
                </template>
              </el-table-column>
            </el-table>
          </template>
        </el-table-column>
      </el-table>
      <p v-if="activePlan" class="history-active-hint">
        当前生效：台风 {{ activePlan.typhoonNo }} · 已排 {{ planCounts(activePlan.entries).scheduled }} 艘 ·
        待排 {{ planCounts(activePlan.entries).pending }} 艘
      </p>
    </el-card>

    <EmptyState v-if="!portStore.ports.length" title="暂无渔港" description="请先在渔港一览登记渔港后再预排避风泊位。" />

    <el-dialog
      v-model="conflictVisible"
      title="合并冲突：同一泊位时段两边都改过"
      width="720px"
      data-testid="shelter-conflict-dialog"
    >
      <el-alert type="warning" show-icon :closable="false" class="conflict-alert">
        以下渔船在两边草稿中都被调整过且泊位 / 时段不一致，请选择采用哪一边的方案；未消解的冲突会导致合并失败并恢复原草稿。
      </el-alert>
      <el-table :data="conflicts" size="small" border>
        <el-table-column prop="vesselName" label="渔船" min-width="120" />
        <el-table-column label="合作社方案" min-width="180">
          <template #default="scope">
            <div class="conflict-side">
              泊位 {{ scope.row.base?.berthNo ?? '待排' }} · {{ formatDateTime(scope.row.base?.start) }} ~
              {{ formatDateTime(scope.row.base?.end) }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="值班室方案" min-width="180">
          <template #default="scope">
            <div class="conflict-side">
              泊位 {{ scope.row.incoming?.berthNo ?? '待排' }} · {{ formatDateTime(scope.row.incoming?.start) }} ~
              {{ formatDateTime(scope.row.incoming?.end) }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="采用" width="180">
          <template #default="scope">
            <el-radio-group v-model="resolutions[scope.row.entryId]">
              <el-radio value="base">合作社</el-radio>
              <el-radio value="incoming">值班室</el-radio>
            </el-radio-group>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="conflictVisible = false">取消（恢复原草稿）</el-button>
        <el-button type="primary" data-testid="shelter-conflict-confirm" @click="confirmConflicts">
          确认消解并合并
        </el-button>
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
.detail-card {
  border-radius: 10px;
  margin-bottom: 0;
}
.card-title {
  font-weight: 600;
  color: #17324d;
}
.flow-alert {
  border-radius: 10px;
}
.setting-form :deep(.el-form-item) {
  margin-bottom: 12px;
}
.range-sep {
  margin: 0 8px;
  color: #97a6b4;
}
.draft-card :deep(.el-card__header) {
  padding: 12px 16px;
}
.draft-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.draft-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.draft-counts {
  font-size: 13px;
  color: #5b6b7b;
}
.draft-counts b {
  color: #17324d;
}
.entry-note {
  font-size: 12px;
  color: #7b8a99;
}
.merge-card {
  border-left: 4px solid #67c23a;
}
.merge-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.merge-hint {
  font-size: 13px;
  color: #5b6b7b;
}
.merge-rule {
  margin: 10px 0 0;
  font-size: 12px;
  color: #8592a0;
}
.conflict-alert {
  margin-bottom: 12px;
}
.conflict-side {
  font-size: 12px;
  color: #3d5670;
}
.history-active-hint {
  margin: 12px 0 0;
  font-size: 13px;
  color: #5b6b7b;
}
</style>
