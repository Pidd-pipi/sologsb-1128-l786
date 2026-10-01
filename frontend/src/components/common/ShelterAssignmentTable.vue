<script setup lang="ts">
import { computed } from 'vue';
import type { BerthAssignment } from '../../types/shelter';
import { formatDateTime, formatNumber } from '../../utils/format';

const props = withDefaults(
  defineProps<{
    assignments: BerthAssignment[];
    /** 是否展示渔港名列（跨港视图时开启） */
    portNames?: Map<string, string>;
    emptyText?: string;
    dense?: boolean;
  }>(),
  { portNames: () => new Map(), emptyText: '暂无避风靠泊安排', dense: false },
);

const rows = computed(() =>
  [...props.assignments].sort((a, b) =>
    `${new Date(a.startAt).getTime()}|${a.berthNo}`.localeCompare(`${new Date(b.startAt).getTime()}|${b.berthNo}`),
  ),
);

const showPort = computed(() => props.portNames.size > 0);

function statusType(status: BerthAssignment['status']): 'success' | 'info' | 'warning' {
  if (status === '已落实') return 'success';
  if (status === '已失效') return 'info';
  return 'warning';
}
</script>

<template>
  <el-table
    :data="rows"
    :size="dense ? 'small' : 'default'"
    border
    :empty-text="emptyText"
    data-testid="shelter-assignment-table"
  >
    <el-table-column v-if="showPort" label="渔港" min-width="130">
      <template #default="scope">{{ portNames.get(scope.row.portId) ?? scope.row.portId }}</template>
    </el-table-column>
    <el-table-column prop="slotLabel" label="靠泊时段" min-width="160" />
    <el-table-column prop="berthNo" label="泊位" width="80" />
    <el-table-column prop="vesselName" label="渔船" min-width="130" />
    <el-table-column label="吃水 / 水深" min-width="120">
      <template #default="scope">
        {{ formatNumber(scope.row.vesselDraft) }} / {{ formatNumber(scope.row.berthDepth) }} m
      </template>
    </el-table-column>
    <el-table-column label="靠泊" min-width="140">
      <template #default="scope">{{ formatDateTime(scope.row.startAt) }}</template>
    </el-table-column>
    <el-table-column label="离泊" min-width="140">
      <template #default="scope">{{ formatDateTime(scope.row.endAt) }}</template>
    </el-table-column>
    <el-table-column label="状态" width="92">
      <template #default="scope">
        <el-tag size="small" :type="statusType(scope.row.status)" effect="plain">{{ scope.row.status }}</el-tag>
      </template>
    </el-table-column>
    <el-table-column v-if="!dense" label="来源 / 失效原因" min-width="150">
      <template #default="scope">
        <span v-if="scope.row.status === '已失效' && scope.row.voidReason" class="shelter-table__void">
          {{ scope.row.voidReason }}
        </span>
        <el-tag v-else size="small" effect="plain" :type="scope.row.source === 'coop' ? 'primary' : 'success'">
          {{ scope.row.source === 'coop' ? '合作社' : '值班室' }}
        </el-tag>
      </template>
    </el-table-column>
  </el-table>
</template>

<style scoped>
.shelter-table__void {
  font-size: 12px;
  color: #909399;
}
</style>
