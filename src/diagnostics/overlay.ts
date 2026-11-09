import { DIAGNOSTIC_CSS_COLORS, colorCss } from "./clusterPalette.ts";
import type { AnnotationRequestDiagnostics, DetectionDiagnostics, Vec3Record } from "./types.ts";

/**
 * Development-only screen-space overlay (Task 1 instrumentation).
 *
 * Renders a frozen copy of the frame that was sent to Gemini, with the raw
 * and sanitized detection boxes, the screen-space sample grid (hits/misses),
 * the click position, and a legend listing every DBSCAN cluster with its size
 * and centroid. The overlay is a plain 2D canvas above the WebGL canvas with
 * pointer-events disabled; it never affects interaction.
 */
export class DiagnosticOverlay {
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private visible = true;
  private hasContent = false;
  private lastRequest: AnnotationRequestDiagnostics | null = null;
  private renderToken = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.id = "annotation-diagnostics-overlay";
    Object.assign(this.canvas.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "100vw",
      height: "100vh",
      pointerEvents: "none",
      zIndex: "950",
    });
    document.body.appendChild(this.canvas);
    this.context = this.canvas.getContext("2d")!;
    this.resize();
    window.addEventListener("resize", () => {
      this.resize();
      if (this.lastRequest) void this.render(this.lastRequest);
    });
  }

  get isVisible(): boolean {
    return this.visible;
  }

  get hasRenderedContent(): boolean {
    return this.hasContent;
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.canvas.style.display = visible ? "block" : "none";
  }

  clear(): void {
    this.lastRequest = null;
    this.hasContent = false;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  async render(request: AnnotationRequestDiagnostics): Promise<void> {
    this.lastRequest = request;
    const token = ++this.renderToken;
    const image = await this.loadImage(request.snapshotDataUrl);
    // A newer render superseded this one while the image decoded.
    if (token !== this.renderToken) return;
    this.draw(request, image);
    this.hasContent = true;
  }

  private loadImage(dataUrl: string | null): Promise<HTMLImageElement | null> {
    if (!dataUrl) return Promise.resolve(null);
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = dataUrl;
    });
  }

  private draw(request: AnnotationRequestDiagnostics, image: HTMLImageElement | null): void {
    const ctx = this.context;
    const width = window.innerWidth;
    const height = window.innerHeight;
    ctx.clearRect(0, 0, width, height);

    if (image) {
      // Frozen Gemini view, dimmed so overlays stay readable.
      ctx.globalAlpha = 0.45;
      ctx.drawImage(image, 0, 0, width, height);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
      ctx.fillRect(0, 0, width, height);
    }

    this.drawClick(request, width, height);
    request.detections.forEach((record, index) => {
      this.drawDetectionBoxes(record, index, width, height);
    });
    this.drawLegend(request, width);
    this.drawHints(height);
  }

  private drawClick(request: AnnotationRequestDiagnostics, width: number, height: number): void {
    const click = request.click;
    if (!click) return;
    const x = click.normalizedX * width;
    const y = click.normalizedY * height;
    const ctx = this.context;
    ctx.strokeStyle = DIAGNOSTIC_CSS_COLORS.clickHit;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 16, y);
    ctx.lineTo(x + 16, y);
    ctx.moveTo(x, y - 16);
    ctx.lineTo(x, y + 16);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawDetectionBoxes(
    record: DetectionDiagnostics,
    index: number,
    width: number,
    height: number,
  ): void {
    const ctx = this.context;

    // Raw Gemini box: dashed magenta.
    if (record.rawBox) {
      this.strokeBox(record.rawBox, width, height, DIAGNOSTIC_CSS_COLORS.rawBox, 2, [6, 4]);
    }
    // Sanitized box: solid cyan.
    if (record.sanitizedBox) {
      this.strokeBox(record.sanitizedBox, width, height, DIAGNOSTIC_CSS_COLORS.sanitizedBox, 2);
    }

    // Sample grid: green cells hit the splat, red cells missed.
    const sampling = record.sampling;
    const box = record.sanitizedBox;
    if (sampling && box) {
      const [ymin, xmin, ymax, xmax] = box;
      const boxWidth = (xmax - xmin) * width;
      const boxHeight = (ymax - ymin) * height;
      const cellWidth = boxWidth / sampling.gridSize;
      const cellHeight = boxHeight / sampling.gridSize;
      for (const cell of sampling.cells) {
        ctx.fillStyle = cell.hit
          ? DIAGNOSTIC_CSS_COLORS.sampleHitFill
          : DIAGNOSTIC_CSS_COLORS.sampleMissFill;
        ctx.fillRect(
          (xmin * width) + cell.col * cellWidth,
          (ymin * height) + cell.row * cellHeight,
          cellWidth,
          cellHeight,
        );
      }
      ctx.strokeStyle = DIAGNOSTIC_CSS_COLORS.gridOutline;
      ctx.lineWidth = 1;
      for (let line = 1; line < sampling.gridSize; line++) {
        ctx.beginPath();
        ctx.moveTo((xmin * width) + line * cellWidth, ymin * height);
        ctx.lineTo((xmin * width) + line * cellWidth, ymax * height);
        ctx.moveTo(xmin * width, (ymin * height) + line * cellHeight);
        ctx.lineTo(xmax * width, (ymin * height) + line * cellHeight);
        ctx.stroke();
      }
    }

    // Detection label above the sanitized box.
    if (box) {
      const label = `#${index} "${record.label}"`;
      ctx.font = "bold 13px ui-monospace, Menlo, monospace";
      const labelWidth = ctx.measureText(label).width + 12;
      ctx.fillStyle = "rgba(8, 10, 14, 0.85)";
      ctx.fillRect(box[1] * width, Math.max(0, box[0] * height - 22), labelWidth, 18);
      ctx.fillStyle = DIAGNOSTIC_CSS_COLORS.sanitizedBox;
      ctx.fillText(label, box[1] * width + 6, Math.max(13, box[0] * height - 9));
    }
  }

  private strokeBox(
    box: readonly [number, number, number, number],
    width: number,
    height: number,
    color: string,
    lineWidth: number,
    dash?: number[],
  ): void {
    const ctx = this.context;
    const [ymin, xmin, ymax, xmax] = box;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    if (dash) ctx.setLineDash(dash);
    ctx.strokeRect(xmin * width, ymin * height, (xmax - xmin) * width, (ymax - ymin) * height);
    ctx.restore();
  }

  private vecText(v: Vec3Record | null): string {
    if (!v) return "(none)";
    return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
  }

  private drawLegend(request: AnnotationRequestDiagnostics, width: number): void {
    const ctx = this.context;
    const lineHeight = 16;
    const lines: Array<{ text: string; color?: string; swatch?: number; indent?: boolean }> = [];
    const head = recordHead(request);
    lines.push({ text: head.text, color: head.color });
    const click = request.click;
    if (click) {
      lines.push({
        text: `click (${click.normalizedX.toFixed(3)}, ${click.normalizedY.toFixed(3)}) -> ` +
          (click.hit
            ? `hit at ${click.hit.distance.toFixed(2)} m ${this.vecText(click.hit.position)}`
            : "NO SPLAT INTERSECTION"),
        color: click.hit ? DIAGNOSTIC_CSS_COLORS.clickHit : DIAGNOSTIC_CSS_COLORS.sampleMissFill,
      });
    } else {
      lines.push({ text: "no click (inject seam)", color: DIAGNOSTIC_CSS_COLORS.panelDim });
    }
    request.detections.forEach((record, index) => {
      lines.push({ text: "" });
      this.pushDetectionLines(record, index, lines);
    });
    if (request.detections.length === 0) {
      lines.push({ text: "no detections yet", color: DIAGNOSTIC_CSS_COLORS.panelDim });
    }

    ctx.font = "12px ui-monospace, Menlo, monospace";
    let panelWidth = 0;
    for (const line of lines) {
      panelWidth = Math.max(panelWidth, ctx.measureText(line.text).width);
    }
    const padding = 10;
    panelWidth += padding * 2 + 26;
    const panelHeight = lines.length * lineHeight + padding * 2;
    ctx.fillStyle = DIAGNOSTIC_CSS_COLORS.panelBackground;
    ctx.fillRect(12, 12, Math.min(panelWidth, width - 24), panelHeight);

    let y = 12 + padding + 4;
    for (const line of lines) {
      if (line.text) {
        if (line.swatch !== undefined) {
          ctx.fillStyle = colorCss(line.swatch);
          ctx.fillRect(12 + padding, y - 9, 10, 10);
        }
        ctx.fillStyle = line.color ?? DIAGNOSTIC_CSS_COLORS.panelText;
        ctx.fillText(line.text, 12 + padding + (line.swatch !== undefined ? 16 : 0), y);
      }
      y += lineHeight;
    }
  }

  private pushDetectionLines(
    record: DetectionDiagnostics,
    index: number,
    lines: Array<{ text: string; color?: string; swatch?: number }>,
  ): void {
    const dim = DIAGNOSTIC_CSS_COLORS.panelDim;
    lines.push({
      text: `d#${index} "${record.label}" anchor=${record.anchor?.source ?? "none"}` +
        (record.failures.length > 0
          ? ` failures=[${record.failures.map((failure) => failure.stage).join(", ")}]`
          : ""),
      color: record.anchor ? DIAGNOSTIC_CSS_COLORS.anchor : dim,
    });
    for (const failure of record.failures) {
      lines.push({
        text: `  FAILED ${failure.stage}: ${failure.reason}`,
        color: DIAGNOSTIC_CSS_COLORS.anchor,
      });
    }
    lines.push({
      text: `box raw=${boxText(record.rawBox)} sanitized=${boxText(record.sanitizedBox)}`,
      color: dim,
    });
    if (record.sampling) {
      const { gridSize, hitCount, missCount } = record.sampling;
      lines.push({
        text: `grid ${gridSize}x${gridSize}: hits ${hitCount}, misses ${missCount}`,
        color: hitCount > 0 ? DIAGNOSTIC_CSS_COLORS.panelText : DIAGNOSTIC_CSS_COLORS.anchor,
      });
    }
    if (record.clustering) {
      for (const cluster of record.clustering.clusters) {
        lines.push({
          text: `C#${cluster.index} ${cluster.size} pts centroid ${this.vecText(cluster.centroid)}` +
            ` extent ${cluster.extent.x.toFixed(2)}x${cluster.extent.y.toFixed(2)}x${cluster.extent.z.toFixed(2)}` +
            (cluster.isSelected ? "  [SELECTED]" : ""),
          color: cluster.isSelected ? DIAGNOSTIC_CSS_COLORS.panelText : dim,
          swatch: cluster.colorHex,
        });
      }
      lines.push({
        text: `noise: ${record.clustering.noiseIndices.length} pts` +
          (record.clustering.libraryNoiseIndices.length !== record.clustering.noiseIndices.length
            ? ` (library noise list: ${record.clustering.libraryNoiseIndices.length})`
            : ""),
        color: DIAGNOSTIC_CSS_COLORS.noise,
      });
    }
    if (record.measurement) {
      lines.push({
        text: `measured centroid ${this.vecText(record.measurement.centroid)}`,
        color: DIAGNOSTIC_CSS_COLORS.selectedCentroid,
      });
    }
    if (record.obb) {
      lines.push({
        text: `OBB ${record.obb.method} centre ${this.vecText(record.obb.position)}`,
        color: DIAGNOSTIC_CSS_COLORS.obb,
      });
    }
    if (record.lift) {
      lines.push({
        text: `lift: ${record.lift.selectedSplats}/${record.lift.numSplats} splats`,
        color: dim,
      });
    }
    if (record.anchor) {
      lines.push({
        text: `anchor ${this.vecText(record.anchor.position)} (${record.anchor.source})`,
        color: DIAGNOSTIC_CSS_COLORS.anchor,
      });
    }
  }

  private drawHints(height: number): void {
    const ctx = this.context;
    const text =
      "[dev] D: toggle diagnostics · O: toggle overlay · V: coordinate validation · window.__sl.diagnostics.last() for data";
    ctx.font = "12px ui-monospace, Menlo, monospace";
    const metrics = ctx.measureText(text);
    ctx.fillStyle = DIAGNOSTIC_CSS_COLORS.panelBackground;
    ctx.fillRect(12, height - 28, metrics.width + 16, 20);
    ctx.fillStyle = DIAGNOSTIC_CSS_COLORS.panelDim;
    ctx.fillText(text, 20, height - 14);
  }
}

function boxText(box: readonly number[] | null): string {
  if (!box) return "(rejected)";
  return `[${box.map((value) => value.toFixed(3)).join(", ")}]`;
}

function recordHead(request: AnnotationRequestDiagnostics): { text: string; color: string } {
  const base = `[annotation-diagnostics] request #${request.index} (${request.source})`;
  const failures = request.detections.filter((record) => record.failures.length > 0).length;
  if (failures > 0) {
    return { text: `${base} — ${failures}/${request.detections.length} detections failed`, color: DIAGNOSTIC_CSS_COLORS.anchor };
  }
  return { text: base, color: DIAGNOSTIC_CSS_COLORS.panelText };
}
