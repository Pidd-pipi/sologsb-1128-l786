/**
 * 避风预排数据模型：台风警报期间，合作社与值班室各自断网在单机上预排避风泊位，
 * 回到港区后把两边草稿按稳定编号合并，整份覆盖为正式避风安排。
 */

/** 离线预排方：合作社 / 值班室 */
export type ShelterSide = 'cooperative' | 'duty';

export const SHELTER_SIDES: Array<{ value: ShelterSide; label: string }> = [
  { value: 'cooperative', label: '合作社' },
  { value: 'duty', label: '值班室' },
];

export function sideLabel(side: ShelterSide): string {
  return SHELTER_SIDES.find((s) => s.value === side)?.label ?? side;
}

/** 预排条目状态：已排 / 待排（容量不足）/ 已失效（实际进出港导致安排作废） */
export type ShelterEntryStatus = 'scheduled' | 'pending' | 'invalidated';

/** 稳定编号：同一艘渔船在两边草稿中的条目共用此 id，是合并的锚点 */
export function shelterEntryId(vesselId: string): string {
  return `se-${vesselId}`;
}

/** 一条避风安排：某船在某泊位、某时段避风；泊位为空表示待排 */
export interface ShelterEntry {
  /** 稳定编号 se-<vesselId>，两边草稿一致 */
  id: string;
  vesselId: string;
  vesselName: string;
  /** 渔船吃水 m */
  draft: number;
  berthId: string | null;
  berthNo: string | null;
  /** 避风时段（ISO 字符串） */
  start: string;
  end: string;
  status: ShelterEntryStatus;
  /** 待排原因 / 说明 */
  note?: string;
  /** 失效原因（实际进出港与预排不符时回填） */
  invalidatedReason?: string;
}

/** 避风时段窗口 */
export interface ShelterWindow {
  start: string;
  end: string;
}

/** 一方离线草稿：断网单机上保存的预排结果 */
export interface ShelterDraft {
  portId: string;
  typhoonNo: string;
  side: ShelterSide;
  window: ShelterWindow;
  entries: ShelterEntry[];
  savedAt: string;
}

/** 正式避风安排（合并后整份覆盖，历史安排保留不删） */
export type ShelterPlanStatus = 'active' | 'invalidated' | 'superseded';

export interface ShelterPlan {
  id: string;
  portId: string;
  typhoonNo: string;
  window: ShelterWindow;
  entries: ShelterEntry[];
  status: ShelterPlanStatus;
  mergedAt: string;
  createdAt: string;
}

/** 合并冲突：同一稳定编号两边都改过且内容不一致 */
export interface ShelterConflict {
  entryId: string;
  vesselId: string;
  vesselName: string;
  base: ShelterEntry | null;
  incoming: ShelterEntry | null;
}

/** 两边草稿合并结果 */
export interface ShelterMergeResult {
  entries: ShelterEntry[];
  conflicts: ShelterConflict[];
}

/** 容量校验问题（合并失败 → 恢复原草稿） */
export interface ShelterProblem {
  entryId: string;
  vesselName: string;
  message: string;
}
