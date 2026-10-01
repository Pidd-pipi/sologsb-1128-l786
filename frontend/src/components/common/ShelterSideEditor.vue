<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { FishingVessel } from '../../types/vessel';
import type { Berth } from '../../types/berth';
import type { ArrangeSlot, BerthAssignment, PlanSide, ShelterPlan, SideDraft } from '../../types/shelter';
import { PLAN_SIDE_LABEL } from '../../types/shelter';
import { formatDateTime, formatNumber } from '../../utils/format';

const props = defineProps<{
  plan: ShelterPlan;
  side: PlanSide;
  draft: SideDraft;
  vessels: FishingVessel[];
  berths: Berth[];
}>();

const emit = defineEmits<{
  (e: 'auto-arrange', side: PlanSide, slot: ArrangeSlot, vesselIds: string[]): void;
  (e: 'add-assignment', side: PlanSide, slot: ArrangeSlot, berthNo: string, vesselId: string): void;
  (e: 'remove-assignment', side: PlanSide, key: string): void;
}>();

const sideName = computed(() => PLAN_SIDE_LABEL[props.side]);

const manualSlotIndex = ref(0);
const manualBerthNo = ref('');
const manualVesselId = ref('');

function vesselById(id: string): FishingVessel | undefined {
  return props.vessels.find((v) => v.id === id);
}

/** 各时段勾选的避风渔船 id（reactive 对象，键为时段开始 ISO） */
const selectedBySlot = reactive<Record<string, string[]>>({});

/** 默认候选：尚未在本侧重叠时段排泊的船 */
function defaultVesselIds(slot: ArrangeSlot): string[] {
  const s = new Date(slot.startAt).getTime();
  const e = new Date(slot.endAt).getTime();
  const busy = new Set(
    props.draft.assignments
      .filter((a) => {
        const as = new Date(a.startAt).getTime();
        const ae = new Date(a.endAt).getTime();
        return s < ae && as < e;
      })
      .map((a) => a.vesselId),
  );
  return props.vessels.filter((v) => !busy.has(v.id)).map((v) => v.id);
}

/** 渲染行：时段 + 已排安排 + 已勾选渔船，切换方案 / 侧 / 排泊后重算并补齐选择键 */
const slotRows = computed(() =>
  props.plan.slots.map((slot) => {
    if (!selectedBySlot[slot.startAt]) selectedBySlot[slot.startAt] = defaultVesselIds(slot);
    return {
      slot,
      items: props.draft.assignments
        .filter((a) => a.startAt === slot.startAt)
        .sort((a, b) => a.berthNo.localeCompare(b.berthNo)),
      selected: selectedBySlot[slot.startAt],
    };
  }),
);

function runAuto(slot: ArrangeSlot, selected: string[]): void {
  if (!selected.length) {
    ElMessage.warning('请先勾选需要避风排泊的渔船');
    return;
  }
  emit('auto-arrange', props.side, slot, selected);
}

// 切方案 / 切侧时清空旧时段的勾选，由 slotRows 按新方案重新初始化
watch(
  () => `${props.plan.id}|${props.side}`,
  () => {
    for (const key of Object.keys(selectedBySlot)) delete selectedBySlot[key];
  },
);

/** 可选渔船：吃水、编号展示 */
const vesselLabel = (v: FishingVessel): string => `${v.name}（吃水 ${formatNumber(v.draftDepth)}m）`;

/** 可选泊位：按水深标注是否满足选中渔船 */
const berthOptions = computed(() =>
  props.berths
    .map((b) => {
      const vessel = manualVesselId.value ? vesselById(manualVesselId.value) : undefined;
      const tooShallow = vessel ? Number(b.designDepth) < Number(vessel.draftDepth) : false;
      return {
        berthNo: b.berthNo,
        designDepth: b.designDepth,
        status: b.status,
        disabled: b.status === '维修' || tooShallow,
        label: `${b.berthNo} · 水深 ${formatNumber(b.designDepth)}m${b.status === '维修' ? ' · 维修' : tooShallow ? ' · 水浅' : b.status === '占用' ? ' · 在泊' : ''}`,
      };
    })
    .sort((a, b) => a.berthNo.localeCompare(b.berthNo)),
);

function submitManual(): void {
  const slot = props.plan.slots[manualSlotIndex.value];
  if (!slot) {
    ElMessage.warning('请先在警报中建立靠泊时段');
    return;
  }
  if (!manualBerthNo.value) {
    ElMessage.warning('请选择泊位');
    return;
  }
  if (!manualVesselId.value) {
    ElMessage.warning('请选择渔船');
    return;
  }
  emit('add-assignment', props.side, slot, manualBerthNo.value, manualVesselId.value);
  manualBerthNo.value = '';
  manualVesselId.value = '';
}

const pendingVessels = computed(() =>
  props.draft.pendingVesselIds
    .map((id) => vesselById(id))
    .filter((v): v is FishingVessel => Boolean(v)),
);
</script>

<template>
  <div class="side-editor" :data-testid="`side-editor-${side}`">
    <div class="side-editor__head">
      <el-tag :type="side === 'coop' ? 'primary' : 'success'" effect="dark" size="small">
        {{ sideName }}离线草稿
      </el-tag>
      <span class="side-editor__saved">最近整份保存：{{ formatDateTime(draft.savedAt) }}</span>
    </div>

    <el-alert type="info" :closable="false" show-icon class="side-editor__tip">
      <template #title>断网排泊，改动随时整份存到本机 IndexedDB；回港后与另一台电脑按稳定编号合并。</template>
    </el-alert>

    <div v-for="(row, sIndex) in slotRows" :key="row.slot.startAt" class="side-editor__slot" :data-testid="`side-slot-${side}-${sIndex}`">
      <div class="side-editor__slot-head">
        <b>{{ row.slot.label }}</b>
        <span class="side-editor__slot-time">{{ formatDateTime(row.slot.startAt) }} ~ {{ formatDateTime(row.slot.endAt) }}</span>
      </div>

      <el-table :data="row.items" size="small" border :empty-text="`${sideName}在本时段尚未排泊`">
        <el-table-column prop="berthNo" label="泊位" width="78" />
        <el-table-column prop="vesselName" label="渔船" min-width="120" />
        <el-table-column label="吃水/水深" width="110">
          <template #default="scope">{{ formatNumber(scope.row.vesselDraft) }}/{{ formatNumber(scope.row.berthDepth) }}m</template>
        </el-table-column>
        <el-table-column label="操作" width="70" align="center">
          <template #default="scope">
            <el-button text type="danger" size="small" :data-testid="`remove-assign-${side}-${scope.row.berthNo}`" @click="emit('remove-assignment', side, scope.row.key)">
              移除
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="side-editor__auto">
        <el-select
          v-model="row.selected"
          multiple
          collapse-tags
          collapse-tags-tooltip
          placeholder="勾选避风渔船"
          size="small"
          style="flex: 1"
          :data-testid="`auto-vessel-picker-${side}-${sIndex}`"
        >
          <el-option v-for="v in vessels" :key="v.id" :label="vesselLabel(v)" :value="v.id" />
        </el-select>
        <el-button
          type="primary"
          size="small"
          plain
          :data-testid="`auto-arrange-${side}-${sIndex}`"
          @click="runAuto(row.slot, row.selected)"
        >
          按吃水自动排泊
        </el-button>
      </div>
    </div>

    <el-divider content-position="left">手动指定一条安排</el-divider>
    <div class="side-editor__manual">
      <el-select v-model="manualSlotIndex" size="small" style="width: 150px" data-testid="manual-slot">
        <el-option v-for="(slot, i) in plan.slots" :key="slot.startAt" :label="slot.label" :value="i" />
      </el-select>
      <el-select v-model="manualBerthNo" size="small" filterable placeholder="选择泊位" style="width: 150px" data-testid="manual-berth">
        <el-option v-for="opt in berthOptions" :key="opt.berthNo" :label="opt.label" :value="opt.berthNo" :disabled="opt.disabled" />
      </el-select>
      <el-select v-model="manualVesselId" size="small" filterable placeholder="选择渔船" style="flex: 1" data-testid="manual-vessel">
        <el-option v-for="v in vessels" :key="v.id" :label="vesselLabel(v)" :value="v.id" />
      </el-select>
      <el-button type="primary" size="small" data-testid="manual-add" @click="submitManual">排入</el-button>
    </div>
    <p class="side-editor__hint">
      维修泊位与水深不足泊位自动置灰；港内已有占用与本侧时段重叠的泊位在自动排泊时跳过。
    </p>

    <div v-if="pendingVessels.length" class="side-editor__pending" data-testid="side-pending">
      <el-alert type="warning" :closable="false" show-icon>
        <template #title>
          容量 / 水深不足，本侧待排 {{ pendingVessels.length }} 艘
        </template>
        <div class="side-editor__pending-list">
          <el-tag v-for="v in pendingVessels" :key="v.id" size="small" type="warning" effect="plain">
            {{ v.name }}（吃水 {{ formatNumber(v.draftDepth) }}m）
          </el-tag>
        </div>
      </el-alert>
    </div>
  </div>
</template>

<style scoped>
.side-editor__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.side-editor__saved {
  font-size: 12px;
  color: #8592a0;
}
.side-editor__tip {
  margin-bottom: 12px;
}
.side-editor__slot {
  border: 1px solid #e7eef5;
  border-radius: 8px;
  padding: 10px;
  margin-bottom: 12px;
  background: #fbfdff;
}
.side-editor__slot-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
  color: #17324d;
}
.side-editor__slot-time {
  font-size: 12px;
  color: #8592a0;
}
.side-editor__auto {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.side-editor__manual {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.side-editor__hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: #8592a0;
}
.side-editor__pending {
  margin-top: 12px;
}
.side-editor__pending-list {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
}
</style>
