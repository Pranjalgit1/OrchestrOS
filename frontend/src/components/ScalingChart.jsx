import { useEffect, useRef, useState } from "react";
import { buildChart, hoverTimes, nearestTimeIndex, pointAt, tooltipLeft } from "../scaling.chart.js";

const TOOLTIP_WIDTH = 210;

/** Width of an element in CSS pixels, following resizes. `fallback` is used before layout (and in tests). */
function useElementWidth(fallback) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const update = () => {
      const next = Math.round(element.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Interactive time-series chart drawn at its real pixel size, so tick labels
 * and axis titles stay readable at every width. Series share one time axis
 * and one value axis. Hovering (or arrow keys when focused) snaps to the
 * nearest measured sample; each series then shows its own nearest sample, or
 * N/A when it has none there. Nothing is interpolated.
 *
 * `series`: [{ key, label, className, points: [{ t, v }], dashed?, fill? }]. Lines only by
 * default; `fill: true` shades under a line and `showPoints` marks every sample.
 */
export function ScalingChart({
  series, metric, xLabel = "Time since start", height = 280, threshold = null, ariaLabel, initialWidth = 720,
  showPoints = false,
}) {
  const [ref, width] = useElementWidth(initialWidth);
  const [hover, setHover] = useState(-1);
  const chart = buildChart(series, {
    width, height, fixedMax: metric.fixedMax ?? null, integer: metric.integer ?? false,
    step: metric.step ?? false, threshold,
  });
  const times = hoverTimes(series);
  const active = hover >= 0 && hover < times.length ? times[hover] : null;
  const cursorX = active === null ? null
    : Math.round((chart.plot.left + (active / chart.xMax) * chart.plot.width) * 10) / 10;
  const readings = active === null ? [] : chart.lines.map((line) => ({ line, point: pointAt(line.points, active) }));
  const tooltipWidth = Math.min(TOOLTIP_WIDTH, width - 8);

  const moveTo = (clientX) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setHover(nearestTimeIndex(times, chart.timeAt(clientX - box.left)));
  };
  const onKeyDown = (event) => {
    if (times.length === 0) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      setHover((current) => Math.max(0, Math.min(times.length - 1, (current < 0 ? 0 : current + delta))));
    } else if (event.key === "Home") {
      setHover(0);
    } else if (event.key === "End") {
      setHover(times.length - 1);
    } else if (event.key === "Escape") {
      setHover(-1);
    }
  };

  return (
    <div className="sc-chart" ref={ref} tabIndex={0} role="group"
      aria-label={`${ariaLabel} Use the left and right arrow keys to read values.`}
      onKeyDown={onKeyDown} onBlur={() => setHover(-1)}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}
        onPointerMove={(event) => moveTo(event.clientX)} onPointerDown={(event) => moveTo(event.clientX)}
        onPointerLeave={() => setHover(-1)}>
        {chart.yTicks.map((tick) => (
          <g key={`y${tick.value}`}>
            <line className="sc-grid" x1={chart.plot.left} x2={chart.plot.right} y1={tick.y} y2={tick.y} />
            <text className="sc-tick" x={chart.plot.left - 8} y={tick.y} textAnchor="end" dominantBaseline="middle">
              {metric.fixedMax ? `${tick.value}%` : tick.value}
            </text>
          </g>
        ))}
        {chart.xTicks.map((tick) => (
          <text key={`x${tick.value}`} className="sc-tick" x={tick.x} y={chart.plot.bottom + 18} textAnchor="middle">
            {tick.value}s
          </text>
        ))}
        <text className="sc-axis-title" x={chart.plot.left + chart.plot.width / 2} y={height - 6} textAnchor="middle">
          {xLabel}
        </text>
        {chart.thresholdY !== null ? (
          <line className="sc-threshold" x1={chart.plot.left} x2={chart.plot.right}
            y1={chart.thresholdY} y2={chart.thresholdY} />
        ) : null}
        {chart.lines.map((line) => (
          <g key={line.key} className={`sc-series ${line.className}`}>
            {line.area && line.fill === true ? <path className="sc-series-area" d={line.area} /> : null}
            <path className={`sc-series-line${line.dashed ? " is-dashed" : ""}`} d={line.path} />
            {showPoints ? line.points.map((point, index) => (
              <circle key={index} className="sc-series-point" cx={point.x} cy={point.y} r={2.5} />
            )) : null}
          </g>
        ))}
        {cursorX !== null ? (
          <g className="sc-cursor">
            <line x1={cursorX} x2={cursorX} y1={chart.plot.top} y2={chart.plot.bottom} />
            {readings.map(({ line, point }) => (point ? (
              <circle key={line.key} className={`sc-series-focus ${line.className}`} cx={point.x} cy={point.y} r={5} />
            ) : null))}
          </g>
        ) : null}
        {/* Captures the pointer over the plot only, so axis labels never steal hover. */}
        <rect className="sc-hit" x={chart.plot.left} y={chart.plot.top} width={chart.plot.width}
          height={chart.plot.height} />
      </svg>
      {active !== null ? (
        <div className="sc-tooltip" role="status" style={{ left: tooltipLeft(cursorX, tooltipWidth, width),
          top: chart.plot.top + 6, width: tooltipWidth }}>
          <strong>{active.toFixed(1)}s</strong>
          {readings.map(({ line, point }) => (
            <span key={line.key} className={line.className}>
              <i aria-hidden="true" />
              {line.label}
              <b>{point ? metric.format(point.v) : "N/A"}</b>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
