/**
 * 避风预排模型。
 *
 * 台风警报拉响后，合作社与值班室各用一台电脑断网离线排泊，回港后按
 * 「稳定编号」整份合并：不同时段直接并入，同一时段两边都改则列出冲突。
 */

/** 离线排泊的两台电脑：合作社 / 值班室 */
export type PlanSide = 'coop' | 'duty';

export const PLAN_SIDE_LABEL: Record<PlanSide, string> = {
  coop: '合作社',
  duty: '值班室',
};

export const PLAN_SIDES: PlanSide[] = ['coop', 'duty'];

/** 方案合并状态 */
export type PlanStatus = '草稿' | '已合并';

/** 单条靠泊安排的落实状态 */
export type AssignmentStatus = '待落实' | '已落实' | '已失效';

export const ASSIGNMENT_STATUSES: AssignmentStatus[] = ['待落实', '已落实', '已失效'];

/** 避风靠泊时段 */
export interface ArrangeSlot {
  /** 时段名，如「第一批 08:00-14:00」 */
  label: string;
  /** 计划靠泊时间 ISO */
  startAt: string;
  /** 计划离泊时间 ISO */
  endAt: string;
}

/**
 * 单条避风靠泊安排。
 * 稳定编号 key = `港口id|泊位号|靠泊时间ISO`，两台离线电脑对同一泊位同一时段
 * 生成的编号完全一致，作为合并主键。
 */
export interface BerthAssignment {
  /** 稳定编号 */
  key: string;
  portId: string;
  /** 泊位号 */
  berthNo: string;
  /** 泊位设计水深 m（适配校验冗余） */
  berthDepth: number;
  vesselId: string;
  vesselName: string;
  /** 渔船吃水 m（适配校验冗余） */
  vesselDraft: number;
  startAt: string;
  endAt: string;
  slotLabel: string;
  /** 由哪台离线电脑排入 */
  source: PlanSide;
  status: AssignmentStatus;
  /** 失效原因（实际进出港时间 / 泊位变化等） */
  voidReason?: string;
  updatedAt: string;
}

/** 一台离线电脑的草稿 */
export interface SideDraft {
  side: PlanSide;
  assignments: BerthAssignment[];
  /** 容量不足、本侧未能排入的渔船 id */
  pendingVesselIds: string[];
  savedAt: string;
}

/** 同一稳定编号两边都改过且不一致时的冲突 */
export interface MergeConflict {
  key: string;
  berthNo: string;
  slotLabel: string;
  startAt: string;
  coop: BerthAssignment | null;
  duty: BerthAssignment | null;
  /** 冲突说明 */
  detail: string;
}

/** 落实 / 失效留痕，安排可失效但历史不丢 */
export interface AssignmentHistory {
  id: string;
  assignmentKey: string;
  vesselId: string;
  vesselName: string;
  portId: string;
  berthNo: string;
  slotLabel: string;
  plannedStartAt: string;
  plannedEndAt: string;
  actualCallId?: string;
  actualTime?: string;
  actualBerthNo?: string;
  result: AssignmentStatus;
  reason: string;
  at: string;
}

/** 一次避风警报的完整预排方案（含两侧离线草稿与合并结果） */
export interface ShelterPlan {
  id: string;
  portId: string;
  /** 台风警报名称 */
  typhoonName: string;
  /** 警报拉响时间 ISO */
  alertAt: string;
  /** 避风靠泊时段骨架（两台离线电脑共用同一套稳定时段） */
  slots: ArrangeSlot[];
  coop: SideDraft;
  duty: SideDraft;
  /** 最近一次成功合并的安排（权威结果） */
  merged: BerthAssignment[];
  /** 合并后仍待排的渔船 id（容量 / 水深不足） */
  pendingVesselIds: string[];
  mergedAt: string | null;
  /** 合并修订号，每次成功合并 +1 */
  revision: number;
  /** 最近一次合并的冲突清单（失败时供查看，成功时清空） */
  conflicts: MergeConflict[];
  /** 最近一次合并的硬性违反项（时段重叠 / 水深不足等） */
  violations: string[];
  lastMergeOk: boolean | null;
  history: AssignmentHistory[];
  createdAt: string;
  updatedAt: string;
}

export function emptySideDraft(side: PlanSide): SideDraft {
  return { side, assignments: [], pendingVesselIds: [], savedAt: '' };
}

/** 合并后按泊位号 + 靠泊时间生成的稳定编号 */
export function buildAssignmentKey(portId: string, berthNo: string, startAtIso: string): string {
  return `${portId}|${berthNo}|${startAtIso}`;
}
