import { useEffect, useRef, useState } from "react";
import type { OverrideWorkoutInput, WorkoutDetailResponse } from "@rai/api-contracts";

import { api } from "../api.js";
import { submitFeedbackCommand, FeedbackSubmissionRejected, FeedbackCredentialsChanged, FeedbackAuthenticationRequired, type FeedbackSubmission } from "../feedback-command.js";

const types = ["easy", "steady", "tempo", "interval", "long_run", "race", "recovery", "unknown"] as const;
const labels: Record<(typeof types)[number], string> = {
  easy: "轻松跑", steady: "稳态跑", tempo: "节奏跑", interval: "间歇跑", long_run: "长距离", race: "比赛", recovery: "恢复跑", unknown: "未分类"
};
const protocols = [
  "five_k_time_trial",
  "ten_k_time_trial",
  "thirty_min_threshold",
  "half_marathon_race",
  "other_race"
] as const;
const protocolLabels: Record<(typeof protocols)[number], string> = {
  five_k_time_trial: "5 km 标准计时跑",
  ten_k_time_trial: "10 km 标准计时跑",
  thirty_min_threshold: "30 分钟乳酸阈值测试",
  half_marathon_race: "半程马拉松比赛",
  other_race: "其他正式比赛"
};

export function OverrideDrawer({ detail, onClose, onSaved }: {
  detail: WorkoutDetailResponse;
  onClose: () => void;
  onSaved: (jobId: string | null) => void;
}) {
  const [previous, setPrevious] = useState(detail.override);
  const [pending, setPending] = useState<FeedbackSubmission | null>(null);
  const [latest, setLatest] = useState<WorkoutDetailResponse | null>(null);
  const [eligibility, setEligibility] = useState<"include" | "exclude" | "">(previous?.eligibilityOverride ?? "");
  const [statisticsParticipation, setStatisticsParticipation] = useState<"include" | "exclude" | "">(previous?.statisticsParticipation ?? "");
  const [type, setType] = useState<OverrideWorkoutInput["sessionType"]>((previous?.sessionType as OverrideWorkoutInput["sessionType"]) ?? null);
  const [performanceProtocol, setPerformanceProtocol] = useState<OverrideWorkoutInput["performanceProtocol"]>(previous?.performanceProtocol ?? null);
  const [rpe, setRpe] = useState(previous?.rpe?.toString() ?? "");
  const [tags, setTags] = useState(previous?.conditionTags.join("，") ?? "");
  const [note, setNote] = useState(previous?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const savingRef = useRef(saving);
  const onCloseRef = useRef(onClose);
  savingRef.current = saving;
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawer = drawerRef.current;
    const focusable = (): HTMLElement[] => drawer
      ? [...drawer.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      : [];
    focusable()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!savingRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  const submit = async () => {
    const parsedRpe = rpe.trim() === "" ? null : Number(rpe);
    if (parsedRpe !== null && (!Number.isInteger(parsedRpe) || parsedRpe < 1 || parsedRpe > 10)) {
      setError("RPE 必须是 1–10 之间的整数");
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    if (note.length > 2000) { setError("备注最多 2000 个字符"); return; }
    const conditionTags = [...new Set(tags.split(/[，,]/).map(value => value.trim()).filter(Boolean))];
    if (conditionTags.length > 20 || conditionTags.some(tag => tag.length > 80)) {
      setError("最多 20 个状态标签，每个最多 80 字符"); return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: OverrideWorkoutInput = {
        expectedRevision: previous?.revision ?? 0,
        eligibilityOverride: eligibility || null,
        statisticsParticipation: statisticsParticipation || null,
        sessionType: type,
        performanceProtocol,
        rpe: parsedRpe,
        conditionTags,
        note: note.trim() || null
      };
      const submission = pending ?? { idempotencyKey: crypto.randomUUID(), kind: "workout_override" as const,
        payload: { ...body, trainingSessionId: detail.workout.id } };
      setPending(submission);
      const result = await submitFeedbackCommand(submission);
      if (result.status === "succeeded") {
        setPending(null);
        onSaved((result.result as { jobId?: string | null } | undefined)?.jobId ?? null);
      } else if (result.status === "failed" || result.status === "cancelled") {
        setPending(null);
        setError(result.error?.message ?? "保存未完成，你的输入仍保留。");
      } else {
        setError("正在保存，请稍后检查结果；不要重复填写。");
      }
    } catch (caught) {
      if (caught instanceof FeedbackSubmissionRejected) {
        setPending(null);
        setError(caught.message + "；本次请求被拒绝，输入已保留，可修改后重新提交。若先前提交结果不明，请先查看最新记录。");
      } else if (caught instanceof FeedbackCredentialsChanged || caught instanceof FeedbackAuthenticationRequired) {
        setError(caught.message + "；前次结果尚未确认，原操作标识已保留，请先恢复连接，不要创建新的保存。");
      } else {
        setError((caught instanceof Error ? caught.message : "暂未确认保存结果") + "；输入仍保留，稍后检查结果将使用同一次操作。");
      }
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="drawer-backdrop" onMouseDown={() => { if (!saving) onClose(); }}>
      <aside ref={drawerRef} className="drawer" role="dialog" aria-modal="true" aria-busy={saving} aria-describedby={error ? "override-save-error" : undefined} onMouseDown={(event) => event.stopPropagation()} aria-label="编辑训练覆盖">
        <header><div><h2>编辑训练覆盖</h2><p>反馈保存后更新分析；排除模型评估与排除统计互相独立，不删除原始记录。</p></div><button className="icon-button" disabled={saving} onClick={onClose} aria-label="关闭">×</button></header>
        <fieldset className="drawer-body drawer-fields" disabled={saving || pending !== null}>
          <label className="field"><span>是否用于 RAI</span><select value={eligibility} onChange={(event) => setEligibility(event.target.value as typeof eligibility)}><option value="">遵循模型判断</option><option value="include">强制包含</option><option value="exclude">排除训练</option></select></label>
          <label className="field"><span>是否计入运动统计</span><select value={statisticsParticipation} onChange={(event) => setStatisticsParticipation(event.target.value as typeof statisticsParticipation)}><option value="">计入统计（默认）</option><option value="include">明确计入</option><option value="exclude">不计入跑量与负荷</option></select><small>与“是否用于 RAI”相互独立；仅用于排除误记录或不属于你的训练。</small></label>
          <label className="field"><span>训练类型</span><select value={type ?? ""} onChange={(event) => setType((event.target.value || null) as OverrideWorkoutInput["sessionType"])}><option value="">不覆盖</option>{types.map((item) => <option key={item} value={item}>{labels[item]}</option>)}</select></label>
          <label className="field"><span>标准测试 / 比赛</span><select value={performanceProtocol ?? ""} onChange={(event) => setPerformanceProtocol((event.target.value || null) as OverrideWorkoutInput["performanceProtocol"])}><option value="">不是标准测试</option>{protocols.map((item) => <option key={item} value={item}>{protocolLabels[item]}</option>)}</select><small>只有全力或按协议完成的测试才应标记，用于校准 VO₂max、VDOT 和成绩预测。</small></label>
          <label className="field"><span>RPE</span><input type="number" min="1" max="10" step="1" value={rpe} aria-invalid={error?.startsWith("RPE ") || undefined} onChange={(event) => { setRpe(event.target.value); if (error?.startsWith("RPE ")) setError(null); }} /><small>主观用力程度，1-10。</small></label>
          <label className="field"><span>状态标签</span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="例如：睡眠不足，天气炎热" /></label>
          <label className="field"><span>备注</span><textarea rows={5} value={note} onChange={(event) => setNote(event.target.value)} /></label>
          {error ? <p ref={errorRef} id="override-save-error" className="form-error" role="alert" tabIndex={-1}>{error}</p> : null}
        </fieldset>
        {!pending && <div className="drawer-body">
          <button className="button secondary" disabled={saving} onClick={() => {
            void api<WorkoutDetailResponse>(`/v1/workouts/${encodeURIComponent(detail.workout.id)}`)
              .then(setLatest).catch(e => setError(e instanceof Error ? e.message : "读取失败"));
          }}>查看最新记录（保留输入）</button>
          {latest && <div><p>最新 RPE：{latest.override?.rpe ?? "未填写"}；备注：{latest.override?.note ?? "无"}</p>
            <button className="button secondary" onClick={() => {
              const value = latest.override;
              setPrevious(value); setEligibility(value?.eligibilityOverride ?? "");
              setStatisticsParticipation(value?.statisticsParticipation ?? "");
              setType((value?.sessionType as OverrideWorkoutInput["sessionType"]) ?? null);
              setPerformanceProtocol(value?.performanceProtocol ?? null);
              setRpe(value?.rpe?.toString() ?? ""); setTags(value?.conditionTags.join("，") ?? "");
              setNote(value?.note ?? ""); setLatest(null); setError(null);
            }}>放弃当前输入，使用最新记录重新编辑</button></div>}
        </div>}
        {pending && <p className="drawer-body">关闭窗口不会撤销已提交的保存；结果不确定时请先检查结果。</p>}
        <footer><button className="button secondary" disabled={saving} onClick={onClose}>取消</button><button className="button primary" disabled={saving} onClick={() => void submit()}>{saving ? "正在保存" : pending ? "检查保存结果" : "保存并重算"}</button></footer>
      </aside>
    </div>
  );
}
