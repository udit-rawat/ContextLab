'use client';

import { useId, useState } from 'react';

/**
 * Cost against answer quality, one point per strategy.
 *
 * Form: a scatter, because the question is a trade-off between two measures
 * and the thing worth seeing is which strategies are dominated. Cost uses a log
 * scale -- the strategies span roughly 30x, and on a linear axis the three cheap
 * ones collapse into a single blob against the wall.
 *
 * Colour is not the identity channel here: every point is directly labelled.
 * The default categorical palette validates only three slots under the
 * all-pairs rule that scatter charts trigger, so the three retrieval strategies
 * take the three validated hues and full stuffing -- the naive baseline, and the
 * odd one out -- takes neutral ink.
 */

export interface ChartPoint {
  strategy: string;
  label: string;
  cost: number;
  quality: number;
  /** Rendered into the tooltip. */
  detail: string;
  onFrontier: boolean;
}

const W = 720;
const H = 420;
const M = { top: 28, right: 92, bottom: 56, left: 64 };

export function ParetoChart({ points, yLabel, yMax }: { points: ChartPoint[]; yLabel: string; yMax: number }) {
  const uid = useId().replace(/:/g, '');
  const [hover, setHover] = useState<number | null>(null);

  const costs = points.map((p) => p.cost).filter((c) => c > 0);
  const loX = Math.log10(Math.min(...costs) * 0.6);
  const hiX = Math.log10(Math.max(...costs) * 1.6);

  const px = (c: number) => M.left + ((Math.log10(c) - loX) / (hiX - loX)) * (W - M.left - M.right);
  const py = (q: number) => H - M.bottom - (q / yMax) * (H - M.top - M.bottom);

  // Decade ticks across the cost range.
  const xTicks: number[] = [];
  for (let e = Math.floor(loX); e <= Math.ceil(hiX); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (Math.log10(v) >= loX && Math.log10(v) <= hiX) xTicks.push(v);
    }
  }
  const yTicks = Array.from({ length: 6 }, (_, i) => (yMax / 5) * i);

  const frontier = [...points].filter((p) => p.onFrontier).sort((a, b) => a.cost - b.cost);

  return (
    <figure className="viz-root not-prose m-0">
      <style>{`
        .viz-${uid} { --surface-1:#fcfcfb; --grid:#e6e5e1; --axis:#b9b8b2;
          --ink-1:#0b0b0b; --ink-2:#52514e; --ink-3:#84837d;
          --s-topk:#2a78d6; --s-rerank:#eb6834; --s-skeleton:#1baf7a; --s-full:#6b6a65; }
        @media (prefers-color-scheme: dark) {
          :root:not([data-theme="light"]) .viz-${uid} { --surface-1:#1a1a19; --grid:#2f2f2c; --axis:#4d4c48;
            --ink-1:#ffffff; --ink-2:#c3c2b7; --ink-3:#8f8e86;
            --s-topk:#3987e5; --s-rerank:#d95926; --s-skeleton:#199e70; --s-full:#9a998f; }
        }
        :root[data-theme="dark"] .viz-${uid} { --surface-1:#1a1a19; --grid:#2f2f2c; --axis:#4d4c48;
          --ink-1:#ffffff; --ink-2:#c3c2b7; --ink-3:#8f8e86;
          --s-topk:#3987e5; --s-rerank:#d95926; --s-skeleton:#199e70; --s-full:#9a998f; }
      `}</style>

      <div className={`viz-${uid} overflow-x-auto`}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px]" role="img"
             aria-label={`${yLabel} against cost per query, one point per context strategy`}>
          <rect x={0} y={0} width={W} height={H} fill="var(--surface-1)" />

          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={M.left} x2={W - M.right} y1={py(t)} y2={py(t)} stroke="var(--grid)" strokeWidth={1} />
              <text x={M.left - 10} y={py(t) + 4} textAnchor="end" fontSize={11} fill="var(--ink-3)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {yMax <= 1 ? t.toFixed(1) : t.toFixed(0)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <g key={`x${t}`}>
              <line x1={px(t)} x2={px(t)} y1={M.top} y2={H - M.bottom} stroke="var(--grid)" strokeWidth={1} />
              <text x={px(t)} y={H - M.bottom + 18} textAnchor="middle" fontSize={11} fill="var(--ink-3)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                ${t < 0.01 ? t.toFixed(4) : t.toFixed(3)}
              </text>
            </g>
          ))}

          <line x1={M.left} x2={W - M.right} y1={H - M.bottom} y2={H - M.bottom} stroke="var(--axis)" strokeWidth={1} />
          <line x1={M.left} x2={M.left} y1={M.top} y2={H - M.bottom} stroke="var(--axis)" strokeWidth={1} />

          <text x={(M.left + W - M.right) / 2} y={H - 12} textAnchor="middle" fontSize={12} fill="var(--ink-2)">
            mean cost per query (USD, log scale)
          </text>
          <text x={16} y={(M.top + H - M.bottom) / 2} textAnchor="middle" fontSize={12} fill="var(--ink-2)"
                transform={`rotate(-90 16 ${(M.top + H - M.bottom) / 2})`}>
            {yLabel}
          </text>

          {frontier.length > 1 && (
            <polyline
              points={frontier.map((p) => `${px(p.cost)},${py(p.quality)}`).join(' ')}
              fill="none" stroke="var(--axis)" strokeWidth={1.5} strokeDasharray="5 4"
            />
          )}

          {points.map((p, i) => {
            const color = `var(--s-${p.strategy === 'full-stuff' ? 'full' : p.strategy === 'top-k' ? 'topk' : p.strategy})`;
            const x = px(p.cost);
            const y = py(p.quality);
            const right = x < W - M.right - 130;
            return (
              <g key={p.strategy} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <circle cx={x} cy={y} r={18} fill="transparent" />
                <circle cx={x} cy={y} r={hover === i ? 9 : 7} fill={color} stroke="var(--surface-1)" strokeWidth={2} />
                <text x={right ? x + 14 : x - 14} y={y - 12} textAnchor={right ? 'start' : 'end'}
                      fontSize={12} fontWeight={600} fill="var(--ink-1)">{p.label}</text>
                <text x={right ? x + 14 : x - 14} y={y + 2} textAnchor={right ? 'start' : 'end'}
                      fontSize={11} fill="var(--ink-3)" style={{ fontVariantNumeric: 'tabular-nums' }}>{p.detail}</text>
              </g>
            );
          })}
        </svg>
      </div>

      <figcaption className="mt-3 text-sm opacity-70">
        Dashed line marks the Pareto frontier: strategies that nothing else beats on both cost and quality at once.
      </figcaption>
    </figure>
  );
}
