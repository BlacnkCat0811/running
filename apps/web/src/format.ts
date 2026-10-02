const sessionLabels: Record<string, string> = {
  easy: "轻松跑",
  tempo: "节奏跑",
  interval: "间歇跑",
  steady: "稳态跑",
  long_run: "长距离",
  race: "比赛",
  recovery: "恢复跑",
  unknown: "未分类"
};

const statusLabels: Record<string, string> = {
  eligible: "有效",
  trial: "试算",
  excluded: "排除",
  calibrating: "校准中",
  queued: "排队中",
  running: "训练中",
  validating: "验证中",
  succeeded: "已通过",
  rejected: "未通过门槛",
  failed: "失败",
  cancelled: "已取消"
};

export const number = (value: number | null, digits = 2): string =>
  value === null ? "--" : value.toFixed(digits);

export const duration = (seconds: number): string => {
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const rest = rounded % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${rest.toString().padStart(2, "0")}`
    : `${minutes}:${rest.toString().padStart(2, "0")}`;
};

export const sleepDuration = (minutes: number | null): string => {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return "--";
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return `${hours}h${rest.toString().padStart(2, "0")}min`;
};

export const pace = (seconds: number | null): string => {
  if (seconds === null) return "--";
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}'${(rounded % 60).toString().padStart(2, "0")}"`;
};

export const date = (value: string, withTime = false): string =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {})
  }).format(new Date(value));

export const shortDate = (value: string): string =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));

const sessionKindLabels: Record<string, string> = {
  rest: "休息",
  recovery: "恢复跑",
  easy: "轻松跑",
  long_run: "长距离",
  tempo: "节奏跑",
  interval: "间歇跑"
};

const raceDistanceLabels: Record<string, string> = {
  five_k: "5 公里",
  ten_k: "10 公里",
  half_marathon: "半程马拉松"
};

export const sessionType = (value: string): string => sessionLabels[value] ?? value;
export const sessionKind = (value: string): string => sessionKindLabels[value] ?? sessionType(value);
export const raceDistance = (value: string): string => raceDistanceLabels[value] ?? value;
export const status = (value: string | null): string => (value ? statusLabels[value] ?? value : "--");

const stimulusLabels: Record<string, string> = {
  recovery: "恢复训练",
  aerobic_base: "有氧基础训练",
  marathon_pace: "马拉松配速训练",
  lactate_threshold: "乳酸阈值训练",
  vo2max: "最大摄氧量训练",
  anaerobic_endurance: "无氧耐力训练",
  unclassified: "未识别刺激"
};

const heartRateZoneLabels: Record<string, string> = {
  recovery: "恢复区",
  aerobic_base: "有氧基础区",
  aerobic_power: "有氧动力区",
  lactate_threshold: "乳酸阈值区",
  anaerobic: "无氧区间"
};

const paceZoneLabels: Record<string, string> = {
  easy: "轻松跑区",
  marathon: "马拉松配速区",
  lactate_threshold: "乳酸阈区",
  anaerobic_endurance: "无氧耐力区",
  sprint: "冲刺区"
};

export const stimulusType = (value: string): string => stimulusLabels[value] ?? value;
export const heartRateZone = (value: string): string => heartRateZoneLabels[value] ?? value;
export const paceZone = (value: string): string => paceZoneLabels[value] ?? value;
export const zoneSource = (value: string): string => ({
  automatic: "自动估计",
  manual: "手动锁定",
  fallback: "低置信兜底",
  carried_forward: "沿用上一快照"
}[value] ?? value);
export const zoneStatus = (value: string): string => ({
  stable: "稳定",
  provisional: "低置信试算",
  fallback: "兜底"
}[value] ?? value);

const sourceLabels: Record<string, string> = {
  apple_watch: "Apple Watch",
  coros: "COROS",
  huawei: "华为",
  connect: "第三方同步",
  manual: "手工记录",
  unknown: "未知来源"
};

const missingReasonLabels: Record<string, string> = {
  session_ambiguous: "训练归并存在歧义",
  distance_missing: "缺少距离",
  distance_below_1km: "距离不足 1 km",
  duration_below_8min: "时长不足 8 分钟",
  indoor_workout: "室内跑暂不进入正式模型",
  indoor_status_unknown: "室内/户外状态未知",
  implausible_average_pace: "平均配速异常",
  heart_rate_missing: "缺少心率",
  heart_rate_coverage_low: "心率覆盖不足",
  route_missing: "没有路线",
  route_quality_low: "路线质量偏低",
  recovery_data_missing: "缺少恢复上下文",
  user_excluded: "已由用户排除"
};

export const source = (value: string): string => sourceLabels[value] ?? value;
export const environment = (value: boolean | null): string => value === true ? "室内" : value === false ? "户外" : "环境未知";
export const missingReason = (value: string): string => missingReasonLabels[value] ?? value;
export const confidenceLevel = (value: number | null): string => value === null ? "不可用" : value >= 0.8 ? "高" : value >= 0.6 ? "中" : "低";

/**
 * Environment read-out wording (docs/ALGORITHM.md §5).
 *
 * The three states must stay distinguishable in the UI: "we corrected for 30 °C"
 * and "we have no weather for this run" are different facts, and the failure this
 * contract exists to prevent is both of them rendering as "no adjustment".
 */
const environmentStatusLabels: Record<string, string> = {
  applied: "已按环境条件修正",
  not_needed: "参考条件，无需修正",
  unavailable: "环境数据不足，未修正"
};

const environmentReasonLabels: Record<string, string> = {
  temperature_missing: "缺少温度",
  humidity_missing: "缺少湿度",
  elevation_missing: "缺少爬升",
  heat_humidity_adjustment: "含高温/高湿修正",
  elevation_adjustment: "含爬升修正",
  reference_conditions: "处于参考条件内",
  elevation_samples_insufficient: "该段没有足够的海拔采样",
  split_too_short_for_grade: "分段过短，无法计算坡度",
  grade_implausible_for_split: "坡度超出可信范围",
  grade_clamped_to_cost_model_domain: "坡度超出成本模型适用范围，已按边界处理",
  no_split_with_elevation: "没有任何分段带海拔数据",
  partial_elevation_coverage: "仅部分分段带海拔数据",
  no_splits: "没有可用的公里分段"
};

export const environmentStatus = (value: string): string => environmentStatusLabels[value] ?? value;
export const environmentReason = (value: string): string => environmentReasonLabels[value] ?? value;

const explanationLabels: Record<string, string> = {
  efficiency_below_baseline: "心率效率低于个人基线",
  efficiency_above_baseline: "心率效率高于个人基线",
  pace_below_baseline: "配速输出低于个人基线",
  pace_above_baseline: "配速输出高于个人基线",
  stability_below_baseline: "配速与心率稳定性偏低",
  stability_above_baseline: "整次训练保持稳定",
  recovery_low: "恢复状态偏低",
  recovery_good: "恢复状态良好",
  fatigue_protected_negative_update: "负向更新已启用疲劳保护",
  low_confidence: "数据置信度偏低"
  ,heart_rate_average_fallback: "心率序列不足，使用平均心率近似"
  ,pace_average_fallback: "配速序列不足，使用平均配速近似"
  ,zone_profile_provisional: "本次使用低置信分区快照"
  ,heart_rate_pace_conflict: "心率与配速在超过 30% 的时间内相差两个以上区间"
  ,stimulus_low_confidence: "未达到标准剂量，显示最接近的低置信刺激"
  ,stimulus_unclassified: "有效数据不足，未强制推断训练刺激"
};

export const explanation = (code: string): string => explanationLabels[code] ?? code;
