// 真实波形：服务端算好的峰值（0–1000），这里只负责按主题变量着色。已播放部分用强调色。
import React, {useMemo} from 'react';

function downsample(peaks: number[], bars: number) {
  if (peaks.length <= bars) return peaks;
  const out: number[] = [], per = peaks.length / bars;
  for (let i = 0; i < bars; i++) {
    let max = 0;
    for (let j = Math.floor(i * per); j < Math.floor((i + 1) * per); j++) max = Math.max(max, peaks[j]);
    out.push(max);
  }
  return out;
}

export function Waveform({peaks, bars = 120, progress = null, active = false, onSeek, label, className = ''}: {
  peaks: number[] | null; bars?: number; progress?: number | null; active?: boolean;
  onSeek?: (fraction: number) => void; label: string; className?: string;
}) {
  const values = useMemo(() => peaks?.length ? downsample(peaks, bars) : null, [peaks, bars]);
  const played = progress == null ? -1 : progress * (values?.length ?? 0);
  const seek = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onSeek) return;
    const box = e.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)));
  };
  const keys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onSeek || progress == null) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation();
      onSeek(Math.max(0, Math.min(1, progress + (e.key === 'ArrowRight' ? 0.02 : -0.02))));
    }
  };
  return <div className={`sgm-wave ${active ? 'is-active' : ''} ${onSeek ? 'is-seekable' : ''} ${className}`}
    role={onSeek ? 'slider' : 'img'} aria-label={label} tabIndex={onSeek ? 0 : undefined}
    aria-valuemin={onSeek ? 0 : undefined} aria-valuemax={onSeek ? 100 : undefined} aria-valuenow={onSeek ? Math.round((progress ?? 0) * 100) : undefined}
    onPointerDown={onSeek ? seek : undefined} onKeyDown={onSeek ? keys : undefined}>
    {values ? <svg viewBox={`0 0 ${values.length} 100`} preserveAspectRatio="none" aria-hidden="true">
      {values.map((v, i) => {
        const h = Math.max(4, v / 1000 * 96);
        return <rect key={i} x={i + 0.18} y={50 - h / 2} width={0.64} height={h} rx={0.3} className={i < played ? 'played' : ''}/>;
      })}
    </svg> : <span className="sgm-wave-empty">波形暂不可用</span>}
  </div>;
}
