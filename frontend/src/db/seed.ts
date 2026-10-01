import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { PortCall } from '../types/call';
import type { ArrangeSlot, BerthAssignment, ShelterPlan } from '../types/shelter';
import { buildAssignmentKey, emptySideDraft } from '../types/shelter';
import { toPlain } from '../utils/format';
import { db } from './index';
import { buildBerthRecords } from './berth';

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

/** 初始渔港 */
export const SEED_PORTS: FishingPort[] = [
  {
    id: 'p-1001',
    name: '石浦中心渔港',
    level: '中心渔港',
    longitude: 121.9437,
    latitude: 29.2119,
    berthCount: 6,
    berthDepth: 5.5,
    wharfLength: 420,
    shelterLevel: 12,
    supply: { fuel: true, ice: true, water: true },
    manager: '象山县渔港管理站',
    createdAt: daysAgo(420),
  },
  {
    id: 'p-1002',
    name: '沈家门中心渔港',
    level: '中心渔港',
    longitude: 122.2979,
    latitude: 29.9447,
    berthCount: 8,
    berthDepth: 6.2,
    wharfLength: 680,
    shelterLevel: 11,
    supply: { fuel: true, ice: true, water: false },
    manager: '普陀区渔港服务中心',
    createdAt: daysAgo(365),
  },
  {
    id: 'p-1003',
    name: '岱山高亭渔港',
    level: '一级渔港',
    longitude: 122.2031,
    latitude: 30.2567,
    berthCount: 5,
    berthDepth: 4.8,
    wharfLength: 300,
    shelterLevel: 10,
    supply: { fuel: false, ice: true, water: true },
    manager: '岱山县渔业合作社',
    createdAt: daysAgo(280),
  },
  {
    id: 'p-1004',
    name: '温岭石塘渔港',
    level: '二级渔港',
    longitude: 121.6612,
    latitude: 28.3407,
    berthCount: 4,
    berthDepth: 3.9,
    wharfLength: 210,
    shelterLevel: 9,
    supply: { fuel: false, ice: false, water: true },
    manager: '温岭市石塘镇渔业服务站',
    createdAt: daysAgo(150),
  },
];

/** 初始渔船档案 */
export const SEED_VESSELS: FishingVessel[] = [
  {
    id: 'v-2001',
    name: '浙象渔05123',
    vesselNo: 'ZXY05123',
    homePort: '石浦',
    length: 32.5,
    beam: 6.4,
    draftDepth: 4.0,
    grossTonnage: 168,
    enginePower: 268,
    operationType: '拖网',
    hullMaterial: '钢质',
    owner: '林海平',
    certificateExpiry: '2027-06-30',
    createdAt: daysAgo(300),
  },
  {
    id: 'v-2002',
    name: '浙普渔13208',
    vesselNo: 'ZPY13208',
    homePort: '沈家门',
    length: 28.6,
    beam: 5.8,
    draftDepth: 3.5,
    grossTonnage: 120,
    enginePower: 202,
    operationType: '围网',
    hullMaterial: '钢质',
    owner: '王阿明',
    certificateExpiry: '2026-11-15',
    createdAt: daysAgo(260),
  },
  {
    id: 'v-2003',
    name: '浙岱渔07156',
    vesselNo: 'ZDY07156',
    homePort: '高亭',
    length: 24.2,
    beam: 5.1,
    draftDepth: 2.8,
    grossTonnage: 88,
    enginePower: 158,
    operationType: '刺网',
    hullMaterial: '木质',
    owner: '郑友良',
    certificateExpiry: '2026-02-28',
    createdAt: daysAgo(210),
  },
  {
    id: 'v-2004',
    name: '浙岭渔09342',
    vesselNo: 'ZLY09342',
    homePort: '石塘',
    length: 19.8,
    beam: 4.6,
    draftDepth: 2.2,
    grossTonnage: 56,
    enginePower: 96,
    operationType: '钓具',
    hullMaterial: '玻璃钢',
    owner: '陈小军',
    certificateExpiry: '2027-03-20',
    createdAt: daysAgo(180),
  },
  {
    id: 'v-2005',
    name: '浙象渔05288',
    vesselNo: 'ZXY05288',
    homePort: '石浦',
    length: 35.0,
    beam: 6.8,
    draftDepth: 4.5,
    grossTonnage: 196,
    enginePower: 330,
    operationType: '拖网',
    hullMaterial: '钢质',
    owner: '张卫国',
    certificateExpiry: '2028-01-10',
    createdAt: daysAgo(120),
  },
  {
    id: 'v-2006',
    name: '浙普渔13566',
    vesselNo: 'ZPY13566',
    homePort: '沈家门',
    length: 21.5,
    beam: 4.9,
    draftDepth: 2.5,
    grossTonnage: 72,
    enginePower: 132,
    operationType: '围网',
    hullMaterial: '铝合金',
    owner: '刘建军',
    certificateExpiry: '2026-08-05',
    createdAt: daysAgo(90),
  },
];

/** 初始进出港流水 */
export const SEED_CALLS: PortCall[] = [
  {
    id: 'c-3001',
    vesselId: 'v-2001',
    vesselName: '浙象渔05123',
    type: '进港',
    time: hoursAgo(5),
    berthNo: 'B01',
    iceKg: 1200,
    fuelL: 800,
    unloadKg: 8600,
    visaStatus: '已签证',
    createdAt: hoursAgo(5),
  },
  {
    id: 'c-3002',
    vesselId: 'v-2005',
    vesselName: '浙象渔05288',
    type: '进港',
    time: hoursAgo(3),
    berthNo: 'B02',
    iceKg: 900,
    fuelL: 1200,
    unloadKg: 12400,
    visaStatus: '已签证',
    createdAt: hoursAgo(3),
  },
  {
    id: 'c-3003',
    vesselId: 'v-2002',
    vesselName: '浙普渔13208',
    type: '进港',
    time: hoursAgo(2),
    berthNo: 'B01',
    iceKg: 600,
    fuelL: 0,
    unloadKg: 5200,
    visaStatus: '待签证',
    createdAt: hoursAgo(2),
  },
  {
    id: 'c-3004',
    vesselId: 'v-2003',
    vesselName: '浙岱渔07156',
    type: '进港',
    time: hoursAgo(1),
    berthNo: 'B01',
    iceKg: 300,
    fuelL: 260,
    unloadKg: 2100,
    visaStatus: '免签',
    createdAt: hoursAgo(1),
  },
  {
    id: 'c-3005',
    vesselId: 'v-2004',
    vesselName: '浙岭渔09342',
    type: '出港',
    time: daysAgo(1),
    berthNo: 'B02',
    iceKg: 0,
    fuelL: 420,
    unloadKg: 0,
    visaStatus: '已签证',
    createdAt: daysAgo(1),
  },
  {
    id: 'c-3006',
    vesselId: 'v-2006',
    vesselName: '浙普渔13566',
    type: '进港',
    time: daysAgo(1),
    berthNo: 'B02',
    iceKg: 480,
    fuelL: 300,
    unloadKg: 3600,
    visaStatus: '已签证',
    createdAt: daysAgo(1),
  },
  {
    id: 'c-3007',
    vesselId: 'v-2001',
    vesselName: '浙象渔05123',
    type: '出港',
    time: daysAgo(2),
    berthNo: 'B01',
    iceKg: 0,
    fuelL: 950,
    unloadKg: 0,
    visaStatus: '已签证',
    createdAt: daysAgo(2),
  },
  {
    id: 'c-3008',
    vesselId: 'v-2002',
    vesselName: '浙普渔13208',
    type: '出港',
    time: daysAgo(4),
    berthNo: 'B03',
    iceKg: 200,
    fuelL: 540,
    unloadKg: 0,
    visaStatus: '待签证',
    createdAt: daysAgo(4),
  },
];

function hoursAhead(hours: number): string {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

interface SeedAssignmentSpec {
  berthNo: string;
  vesselId: string;
  slotLabel: string;
  startHours: number;
  endHours: number;
}

/** 构造一条避风靠泊安排（合作社 / 值班室两侧共用同一份已合并种子） */
function seedAssignment(
  portId: string,
  berthDepth: number,
  vessel: FishingVessel,
  spec: SeedAssignmentSpec,
): BerthAssignment {
  const startAt = hoursAhead(spec.startHours);
  return {
    key: buildAssignmentKey(portId, spec.berthNo, startAt),
    portId,
    berthNo: spec.berthNo,
    berthDepth,
    vesselId: vessel.id,
    vesselName: vessel.name,
    vesselDraft: vessel.draftDepth,
    startAt,
    endAt: hoursAhead(spec.endHours),
    slotLabel: spec.slotLabel,
    source: 'coop',
    status: '待落实',
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 演示避风预排方案：
 * - 石浦中心渔港（深、6 泊位，已有 2 占用 + 1 维修）：第一批 3 艘，第二批 2 艘，
 *   另留 1 艘待排，演示容量不足统计；
 * - 温岭石塘渔港（浅、水深 3.9m）：小渔船排入，深吃水船因水深不足待排。
 */
export function buildSeedShelterPlans(ports: FishingPort[], vessels: FishingVessel[]): ShelterPlan[] {
  const vesselMap = new Map(vessels.map((v) => [v.id, v]));
  const plans: ShelterPlan[] = [];
  const now = new Date().toISOString();

  const build = (
    id: string,
    port: FishingPort,
    typhoonName: string,
    slots: ArrangeSlot[],
    specs: SeedAssignmentSpec[],
    pendingIds: string[],
  ): ShelterPlan | null => {
    const assignments = specs
      .map((spec) => {
        const vessel = vesselMap.get(spec.vesselId);
        return vessel ? seedAssignment(port.id, port.berthDepth, vessel, spec) : null;
      })
      .filter((a): a is BerthAssignment => a !== null);
    if (!assignments.length) return null;
    const coop = { ...emptySideDraft('coop'), assignments, pendingVesselIds: pendingIds, savedAt: now };
    const duty = { ...emptySideDraft('duty'), assignments: toPlain(assignments), pendingVesselIds: pendingIds, savedAt: now };
    return {
      id,
      portId: port.id,
      typhoonName,
      alertAt: now,
      slots,
      coop,
      duty,
      merged: toPlain(assignments),
      pendingVesselIds: pendingIds,
      mergedAt: now,
      revision: 1,
      conflicts: [],
      violations: [],
      lastMergeOk: true,
      history: [],
      createdAt: now,
      updatedAt: now,
    };
  };

  const shipu = ports.find((p) => p.id === 'p-1001');
  if (shipu) {
    const plan = build(
      'sp-4001',
      shipu,
      '18号台风「海燕」',
      [
        { label: '第一批 08:00-14:00', startAt: hoursAhead(8), endAt: hoursAhead(14) },
        { label: '第二批 14:00-20:00', startAt: hoursAhead(14), endAt: hoursAhead(20) },
      ],
      [
        { berthNo: 'B03', vesselId: 'v-2003', slotLabel: '第一批 08:00-14:00', startHours: 8, endHours: 14 },
        { berthNo: 'B05', vesselId: 'v-2004', slotLabel: '第一批 08:00-14:00', startHours: 8, endHours: 14 },
        { berthNo: 'B06', vesselId: 'v-2006', slotLabel: '第一批 08:00-14:00', startHours: 8, endHours: 14 },
        { berthNo: 'B03', vesselId: 'v-2003', slotLabel: '第二批 14:00-20:00', startHours: 14, endHours: 20 },
        { berthNo: 'B05', vesselId: 'v-2006', slotLabel: '第二批 14:00-20:00', startHours: 14, endHours: 20 },
      ],
      // v-2001（浙象渔05123）本港在泊避风，无需重复排；v-2005 第二批暂无空闲深泊位，留待排
      ['v-2005'],
    );
    if (plan) plans.push(plan);
  }

  const shitang = ports.find((p) => p.id === 'p-1004');
  if (shitang) {
    const plan = build(
      'sp-4002',
      shitang,
      '18号台风「海燕」',
      [{ label: '第一批 09:00-15:00', startAt: hoursAhead(9), endAt: hoursAhead(15) }],
      [
        { berthNo: 'B01', vesselId: 'v-2004', slotLabel: '第一批 09:00-15:00', startHours: 9, endHours: 15 },
      ],
      // v-2003 吃水 2.8m 可进；v-2005 吃水 4.5m 超过港内水深 3.9m，待排
      ['v-2003', 'v-2005'],
    );
    if (plan) plans.push(plan);
  }

  return plans;
}

/**
 * 首次进入时写入演示数据，并为缺少泊位记录的渔港补齐泊位。
 * 写库前统一 toPlain 脱代理，避免 DataCloneError。
 */
export async function ensureSeedData(): Promise<void> {
  const portCount = await db.ports.count();
  if (portCount === 0) {
    await db.ports.bulkPut(toPlain(SEED_PORTS));
    await db.vessels.bulkPut(toPlain(SEED_VESSELS));
    await db.calls.bulkPut(toPlain(SEED_CALLS));
  }
  const ports = await db.ports.toArray();
  for (const port of ports) {
    const existing = await db.berths.where('portId').equals(port.id).count();
    if (existing === 0) {
      await db.berths.bulkPut(toPlain(buildBerthRecords(port)));
    }
  }
  // 避风预排演示方案（与建港一致：缺则补一份，不覆盖用户方案）
  const [planCount, vessels] = await Promise.all([db.shelterPlans.count(), db.vessels.toArray()]);
  if (planCount === 0 && ports.length && vessels.length) {
    await db.shelterPlans.bulkPut(toPlain(buildSeedShelterPlans(ports, vessels)));
  }
}
