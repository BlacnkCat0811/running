import type { PrivacyZonesResponse, ShareCardResponse } from "@rai/api-contracts";
import { useState } from "react";

import { api, readApiToken } from "../api.js";
import { useRemote } from "../hooks.js";
import { ErrorBlock, LoadingBlock } from "./Feedback.js";
import { DownloadSimple, MapPinLine, Plus, Trash } from "../icons.js";

/**
 * Privacy zones (docs/DECISIONS.md D9).
 *
 * The zones decide what a **shared** card shows; the app itself keeps drawing the
 * full route, because that is the runner's own data on their own screen. Keeping
 * that distinction visible is the point of the copy below: a runner who thinks the
 * zone hides their warm-up loop in the app will not check what the card contains.
 *
 * Coordinates are entered by hand rather than picked on a map. The desktop route
 * plot has no basemap (it is a bare SVG polyline), so a map picker would mean
 * pulling in a tile provider — and sending the runner's home coordinates to it.
 */

interface ZoneDraft {
  id: string;
  label: string;
  latitude: string;
  longitude: string;
  radiusMeters: string;
}

const newZone = (): ZoneDraft => ({
  id: `zone_${Math.random().toString(36).slice(2, 10)}`,
  label: "",
  latitude: "",
  longitude: "",
  radiusMeters: "300"
});

const toDraft = (zone: PrivacyZonesResponse["zones"][number]): ZoneDraft => ({
  id: zone.id,
  label: zone.label,
  latitude: String(zone.centerLatitude),
  longitude: String(zone.centerLongitude),
  radiusMeters: String(zone.radiusMeters)
});

export function PrivacyZoneEditor() {
  /**
   * Fetch only after the runner opens the editor.
   *
   * Two reasons, both learned from the desktop suite: a settings page that fires a
   * request on mount turns "database is mid-replacement" into a console error on
   * every first run, and the browser logs the 409 regardless of how the component
   * renders it. Privacy zones are also edited once and then never again, so a
   * collapsed panel costs nothing.
   */
  const [opened, setOpened] = useState(false);
  const [token] = useState(() => readApiToken());
  const remote = useRemote<PrivacyZonesResponse>("/v1/privacy-zones", opened && token.length > 0);
  const [drafts, setDrafts] = useState<ZoneDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!opened) {
    return (
      <section className="panel privacy-zone-panel">
        <div className="panel-heading">
          <div>
            <h2>隐私区</h2>
            <p>分享卡片会隐藏落在这些圆内的坐标，并把穿越圆的路段切断；App 内仍然显示完整轨迹。</p>
          </div>
          <button type="button" className="button" onClick={() => setOpened(true)}><MapPinLine size={16} />编辑隐私区</button>
        </div>
      </section>
    );
  }
  if (token.length === 0) {
    return (
      <section className="panel privacy-zone-panel">
        <div className="panel-heading"><div><h2>隐私区</h2><p>隐私区读取需要令牌：请先在上面的连接设置中保存令牌。</p></div></div>
      </section>
    );
  }
  if (remote.loading && !remote.data) return <LoadingBlock label="正在读取隐私区" />;
  if (remote.error || !remote.data) {
    return <ErrorBlock message={remote.error ?? "无法读取隐私区（需要令牌）"} onRetry={() => void remote.reload()} />;
  }

  const current = drafts ?? remote.data.zones.map(toDraft);
  const update = (index: number, patch: Partial<ZoneDraft>): void => {
    setSaved(null);
    setDrafts(current.map((zone, position) => (position === index ? { ...zone, ...patch } : zone)));
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setSaved(null);
    const zones = current.map((zone) => ({
      id: zone.id,
      label: zone.label.trim(),
      centerLatitude: Number(zone.latitude),
      centerLongitude: Number(zone.longitude),
      radiusMeters: Number(zone.radiusMeters),
      createdAt: new Date().toISOString()
    }));
    try {
      const result = await api<PrivacyZonesResponse>("/v1/privacy-zones", {
        method: "PUT",
        body: JSON.stringify({ revision: remote.data!.revision, zones })
      });
      setDrafts(null);
      setSaved(`已保存 ${result.zones.length} 个隐私区（revision ${result.revision}）`);
      await remote.reload();
    } catch (caught) {
      // A 409 means somebody else wrote first: keep the draft and force a re-read
      // rather than overwriting the newer list with a stale one.
      setError(caught instanceof Error ? caught.message : "保存隐私区失败");
      await remote.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel privacy-zone-panel">
      <div className="panel-heading">
        <div>
          <h2>隐私区</h2>
          <p>分享卡片会隐藏落在这些圆内的坐标，并把穿越圆的路段切断；App 内仍然显示完整轨迹。</p>
        </div>
        <code>revision {remote.data.revision}</code>
      </div>
      {current.length === 0 ? (
        <p className="privacy-zone-empty">没有隐私区：分享卡片会显示完整轨迹。</p>
      ) : (
        <div className="privacy-zone-list">
          {current.map((zone, index) => (
            <div className="privacy-zone-row" key={zone.id}>
              <label><span>名称</span><input value={zone.label} onChange={(event) => update(index, { label: event.target.value })} placeholder="家" /></label>
              <label><span>纬度</span><input inputMode="decimal" value={zone.latitude} onChange={(event) => update(index, { latitude: event.target.value })} placeholder="31.2304" /></label>
              <label><span>经度</span><input inputMode="decimal" value={zone.longitude} onChange={(event) => update(index, { longitude: event.target.value })} placeholder="121.4737" /></label>
              <label><span>半径 m</span><input inputMode="numeric" value={zone.radiusMeters} onChange={(event) => update(index, { radiusMeters: event.target.value })} placeholder="300" /></label>
              <button type="button" className="text-button" onClick={() => { setSaved(null); setDrafts(current.filter((_, position) => position !== index)); }} aria-label={`删除隐私区 ${zone.label || index + 1}`}><Trash size={16} /></button>
            </div>
          ))}
        </div>
      )}
      <div className="privacy-zone-actions">
        <button type="button" className="button" onClick={() => { setSaved(null); setDrafts([...current, newZone()]); }}><Plus size={16} />添加隐私区</button>
        <button type="button" className="button primary" disabled={busy} onClick={() => void save()}><MapPinLine size={16} />保存</button>
      </div>
      {error ? <p className="zone-setting-refresh-error" role="alert">{error}<button type="button" className="text-button" onClick={() => void remote.reload().then(() => setError(null))}>重新加载</button></p> : null}
      {saved ? <p className="privacy-zone-saved" role="status">{saved}</p> : null}
    </section>
  );
}

/**
 * Share card for one run.
 *
 * The payload is already trimmed on the server: this component draws `polylines`
 * and never sees the removed coordinates. It cannot re-join the line across a cut
 * because each surviving piece is its own array element.
 */
export function ShareCardPanel({ trainingSessionId }: { trainingSessionId: string }) {
  // Built on demand: a card is something the runner decides to make, and fetching a
  // route on every detail-page load would also turn "database is being replaced"
  // into a console error on pages that never needed the card.
  const [opened, setOpened] = useState(false);
  const [token] = useState(() => readApiToken());
  const remote = useRemote<ShareCardResponse>(
    `/v1/workouts/${trainingSessionId}/share-card`,
    opened && token.length > 0,
    false
  );
  const [status, setStatus] = useState<string | null>(null);
  if (!opened) {
    return (
      <section className="panel share-card-panel">
        <div className="panel-heading">
          <div>
            <h2>分享卡片</h2>
            <p>按隐私区裁剪后生成一张可以发出去的图片；轨迹在服务端裁剪，客户端拿不到被隐藏的坐标。</p>
          </div>
          <button type="button" className="button" onClick={() => setOpened(true)}><DownloadSimple size={16} />生成分享卡片</button>
        </div>
      </section>
    );
  }
  if (token.length === 0) {
    return (
      <section className="panel share-card-panel">
        <div className="panel-heading"><div><h2>分享卡片</h2><p>分享卡片包含轨迹几何，需要令牌：请先在设置中保存令牌。</p></div></div>
      </section>
    );
  }
  if (remote.loading && !remote.data) return <LoadingBlock label="正在生成分享卡片" />;
  if (remote.error || !remote.data) {
    return <ErrorBlock message={remote.error ?? "无法生成分享卡片（需要令牌）"} onRetry={() => void remote.reload()} />;
  }
  const card = remote.data;
  const bounds = card.polylines.flat();
  const box = bounds.length === 0 ? null : bounds.reduce(
    (accumulator, point) => ({
      minLat: Math.min(accumulator.minLat, point.latitude),
      maxLat: Math.max(accumulator.maxLat, point.latitude),
      minLon: Math.min(accumulator.minLon, point.longitude),
      maxLon: Math.max(accumulator.maxLon, point.longitude)
    }),
    { minLat: bounds[0]!.latitude, maxLat: bounds[0]!.latitude, minLon: bounds[0]!.longitude, maxLon: bounds[0]!.longitude }
  );

  const pathFor = (line: ShareCardResponse["polylines"][number]): string => {
    if (box === null) return "";
    const width = Math.max(box.maxLon - box.minLon, 1e-6);
    const height = Math.max(box.maxLat - box.minLat, 1e-6);
    return line
      .map((point, index) => {
        const x = 24 + ((point.longitude - box.minLon) / width) * 352;
        const y = 24 + (1 - (point.latitude - box.minLat) / height) * 152;
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  };

  const download = async (): Promise<void> => {
    setStatus(null);
    const svg = document.getElementById(`share-card-${trainingSessionId}`);
    if (!(svg instanceof SVGSVGElement)) { setStatus("卡片尚未渲染"); return; }
    const serialized = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("卡片渲染失败"));
        image.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = 800;
      canvas.height = 420;
      const context = canvas.getContext("2d");
      if (!context) { setStatus("当前浏览器不支持导出图片"); return; }
      context.fillStyle = "#f3f5f2";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!png) { setStatus("导出 PNG 失败"); return; }
      const link = document.createElement("a");
      link.href = URL.createObjectURL(png);
      link.download = `rai-${card.workout.startedAt.slice(0, 10)}.png`;
      link.click();
      URL.revokeObjectURL(link.href);
      setStatus("已下载分享图片");
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : "导出失败");
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  return (
    <section className="panel share-card-panel">
      <div className="panel-heading">
        <div>
          <h2>分享卡片</h2>
          <p>{card.note ?? "卡片只包含服务端允许的坐标。"}</p>
        </div>
        <button type="button" className="button primary" onClick={() => void download()}><DownloadSimple size={16} />下载图片</button>
      </div>
      <svg id={`share-card-${trainingSessionId}`} className="share-card" viewBox="0 0 400 200" role="img" aria-label="分享卡片预览">
        <rect x="0" y="0" width="400" height="200" fill="#f3f5f2" />
        {card.polylines.map((line, index) => (
          <path key={index} d={pathFor(line)} fill="none" stroke="#199bd3" strokeWidth="2.4" strokeLinecap="round" />
        ))}
        <text x="24" y="186" fontSize="11" fill="#6d786f">{card.workout.startedAt.slice(0, 10)} · {(card.workout.distanceKm ?? 0).toFixed(2)} km · {card.workout.sessionType}</text>
      </svg>
      <dl className="share-card-stats">
        <div><dt>距离</dt><dd>{card.workout.distanceKm === null ? "--" : `${card.workout.distanceKm.toFixed(2)} km`}</dd></div>
        <div><dt>用时</dt><dd>{Math.round(card.workout.durationSeconds / 60)} 分</dd></div>
        <div><dt>隐私区</dt><dd>{card.privacy.unfiltered ? "未配置" : `${card.privacy.zonesApplied} 个 · 隐藏 ${card.privacy.redactedPoints} 点`}</dd></div>
        <div><dt>断点</dt><dd>{card.privacy.gaps}</dd></div>
      </dl>
      {status ? <p className="share-card-status" role="status">{status}</p> : null}
    </section>
  );
}
