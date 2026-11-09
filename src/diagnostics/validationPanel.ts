import type { AnnotationRequestDiagnostics } from "./types.ts";
import type {
  ClickValidationResult,
  LiveCapture,
  SamplesValidationResult,
  ValidationReport,
} from "./coordinateValidation.ts";
import { projectPoint, serializeReport } from "./coordinateValidation.ts";
import { DIAGNOSTIC_CSS_COLORS as COLORS } from "./clusterPalette.ts";

/**
 * Development-only Coordinate Validation Panel (Task 2.1C UI).
 *
 * A compact, collapsible DOM panel plus a separate full-window overlay
 * canvas. Everything renders on demand (button presses, request selection,
 * window resize) — there is no render loop and no interaction with the
 * production annotation pipeline. All heavy state lives in the records and
 * the pure validation core; this class only renders it.
 */

/** Everything the panel needs from the diagnostics owner. */
export interface ValidationPanelHost {
  list(): AnnotationRequestDiagnostics[];
  last(): AnnotationRequestDiagnostics | null;
  validateReprojection(requestIndex: number): ClickValidationResult;
  validateSamples(requestIndex: number): SamplesValidationResult;
  exportValidation(requestIndex: number): ValidationReport | null;
  captureLiveState(): LiveCapture | null;
}

const MONO = "ui-monospace, Menlo, monospace";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", {
    font: `11px ${MONO}`,
    padding: "4px 8px",
    margin: "2px",
    background: "rgba(60, 65, 75, 0.9)",
    color: COLORS.panelText,
    border: "1px solid rgba(255, 255, 255, 0.18)",
    borderRadius: "4px",
    cursor: "pointer",
  }, label);
  node.addEventListener("click", onClick);
  return node;
}

const fmt = (value: number | null | undefined, digits = 3): string =>
  value === null || value === undefined || !Number.isFinite(value) ? "n/a" : value.toFixed(digits);

function matrixText(matrix: readonly number[] | null): string {
  if (!matrix) return "(not captured)";
  const rows: string[] = [];
  for (let r = 0; r < 4; r++) {
    rows.push([0, 4, 8, 12].map((c) => matrix[c + r].toFixed(4)).join("  "));
  }
  return rows.join("\n");
}

export class CoordinateValidationPanel {
  readonly root: HTMLDivElement;
  readonly overlayCanvas: HTMLCanvasElement;
  private readonly overlayContext: CanvasRenderingContext2D;
  private readonly host: ValidationPanelHost;
  private readonly body: HTMLDivElement;
  private readonly requestSelect: HTMLSelectElement;
  private readonly cameraSection: HTMLDivElement;
  private readonly resultsSection: HTMLDivElement;
  private readonly statusLine: HTMLDivElement;
  private live: LiveCapture | null = null;
  private selectedRequestIndex: number | null = null;
  private lastClickResult: ClickValidationResult | null = null;
  private lastSamplesResult: SamplesValidationResult | null = null;
  private overlayVisible = true;
  private collapsed = false;
  private disposed = false;

  private readonly onResize = (): void => {
    this.resizeOverlay();
    this.redrawOverlay();
  };

  constructor(host: ValidationPanelHost) {
    this.host = host;
    const root = el("div", {
      position: "fixed",
      top: "12px",
      right: "12px",
      width: "430px",
      maxHeight: "86vh",
      overflowY: "auto",
      zIndex: "960",
      background: "rgba(10, 12, 16, 0.92)",
      color: COLORS.panelText,
      font: `11px ${MONO}`,
      border: "1px solid rgba(255, 255, 255, 0.18)",
      borderRadius: "6px",
      boxShadow: "0 4px 16px rgba(0, 0, 0, 0.5)",
    });
    root.id = "coordinate-validation-panel";

    const header = el("div", {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      padding: "6px 8px",
      borderBottom: "1px solid rgba(255, 255, 255, 0.12)",
      position: "sticky",
      top: "0",
      background: "rgba(10, 12, 16, 0.95)",
    });
    header.appendChild(el("strong", { flex: "1" }, "Coordinate Validation [dev]"));
    const collapseButton = button("–", () => {
      this.setCollapsed(!this.collapsed);
    });
    collapseButton.style.padding = "2px 7px";
    const hideButton = button("×", () => this.setVisible(false));
    hideButton.style.padding = "2px 7px";
    header.append(collapseButton, hideButton);
    root.appendChild(header);

    this.body = el("div", { padding: "8px" });
    root.appendChild(this.body);

    const selectRow = el("div", { marginBottom: "6px" });
    selectRow.appendChild(el("span", { marginRight: "6px", color: COLORS.panelDim }, "request:"));
    this.requestSelect = el("select", {
      font: `11px ${MONO}`,
      color: COLORS.panelText,
      background: "rgba(40, 44, 52, 0.95)",
      border: "1px solid rgba(255, 255, 255, 0.18)",
      borderRadius: "3px",
      maxWidth: "100%",
    });
    this.requestSelect.addEventListener("change", () => {
      this.selectedRequestIndex = Number(this.requestSelect.value) || null;
      this.refreshLiveCapture();
      this.renderCameraComparison();
      this.clearResults();
    });
    selectRow.appendChild(this.requestSelect);
    this.body.appendChild(selectRow);

    this.cameraSection = el("div", { marginBottom: "8px" });
    this.body.appendChild(this.cameraSection);

    const actions = el("div", { marginBottom: "8px" });
    actions.append(
      button("Validate Click-Hit Reprojection", () => this.runClickValidation()),
      button("Validate All Sampling Hits", () => this.runSamplesValidation()),
      button("Export JSON", () => this.exportJson()),
      button("Copy JSON", () => void this.copyJson()),
      button("Refresh live camera", () => {
        this.refreshLiveCapture();
        this.renderCameraComparison();
      }),
      button(this.overlayButtonLabel(), () => this.toggleOverlay()),
    );
    this.body.appendChild(actions);

    this.statusLine = el("div", { color: COLORS.panelDim, marginBottom: "6px" });
    this.body.appendChild(this.statusLine);

    this.resultsSection = el("div", {});
    this.body.appendChild(this.resultsSection);

    this.root = root;
    document.body.appendChild(root);
    root.style.display = "none";

    const canvas = document.createElement("canvas");
    canvas.id = "coordinate-validation-overlay";
    Object.assign(canvas.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "100vw",
      height: "100vh",
      pointerEvents: "none",
      zIndex: "955",
    });
    document.body.appendChild(canvas);
    this.overlayCanvas = canvas;
    this.overlayContext = canvas.getContext("2d")!;
    this.resizeOverlay();
    window.addEventListener("resize", this.onResize);

    this.refreshRequests();
  }

  // ------------------------------------------------------------------
  // Public control
  // ------------------------------------------------------------------

  get isVisible(): boolean {
    return this.root.style.display !== "none";
  }

  setVisible(visible: boolean): void {
    if (this.disposed) return;
    this.root.style.display = visible ? "block" : "none";
    if (visible) {
      this.refreshRequests();
      this.refreshLiveCapture();
      this.renderCameraComparison();
      this.redrawOverlay();
    } else {
      this.overlayCanvas.style.display = "none";
    }
  }

  toggle(): boolean {
    this.setVisible(!this.isVisible);
    return this.isVisible;
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.body.style.display = collapsed ? "none" : "block";
  }

  toggleOverlay(): boolean {
    this.overlayVisible = !this.overlayVisible;
    this.overlayCanvas.style.display = this.overlayVisible && this.isVisible ? "block" : "none";
    this.redrawOverlay();
    return this.overlayVisible;
  }

  /** Drop cached results (e.g. the selected request was cleared away). */
  onRecordsChanged(): void {
    if (this.disposed) return;
    this.refreshRequests();
    this.clearResults();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("resize", this.onResize);
    this.overlayCanvas.remove();
    this.root.remove();
  }

  // ------------------------------------------------------------------
  // Data plumbing
  // ------------------------------------------------------------------

  private selectedRequest(): AnnotationRequestDiagnostics | null {
    const requests = this.host.list();
    if (this.selectedRequestIndex !== null) {
      const found = requests.find((request) => request.index === this.selectedRequestIndex);
      if (found) return found;
    }
    return this.host.last();
  }

  private refreshRequests(): void {
    const requests = this.host.list();
    const previous = this.selectedRequestIndex;
    this.requestSelect.replaceChildren(
      ...requests.map((request) => {
        const option = document.createElement("option");
        option.value = String(request.index);
        const labels = request.detections.map((detection) => detection.label).join(", ");
        option.textContent =
          `#${request.index} ${request.source} ${request.startedAt.slice(11, 19)}` +
          (labels ? ` [${labels}]` : "");
        return option;
      }),
    );
    const last = this.host.last();
    this.selectedRequestIndex =
      previous !== null && requests.some((request) => request.index === previous)
        ? previous
        : (last?.index ?? null);
    if (this.selectedRequestIndex !== null) this.requestSelect.value = String(this.selectedRequestIndex);
    this.requestSelect.disabled = requests.length === 0;
    if (requests.length === 0) {
      const option = document.createElement("option");
      option.textContent = "(no diagnostic requests yet)";
      this.requestSelect.appendChild(option);
    }
  }

  private refreshLiveCapture(): void {
    this.live = this.host.captureLiveState();
  }

  private clearResults(): void {
    this.lastClickResult = null;
    this.lastSamplesResult = null;
    this.resultsSection.replaceChildren();
    this.statusLine.textContent = "";
    this.redrawOverlay();
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  private runClickValidation(): void {
    const request = this.selectedRequest();
    if (!request) {
      this.statusLine.textContent = "no request selected";
      return;
    }
    this.refreshLiveCapture();
    this.renderCameraComparison();
    this.lastClickResult = this.host.validateReprojection(request.index);
    this.renderClickResult();
    this.redrawOverlay();
  }

  private runSamplesValidation(): void {
    const request = this.selectedRequest();
    if (!request) {
      this.statusLine.textContent = "no request selected";
      return;
    }
    this.refreshLiveCapture();
    this.renderCameraComparison();
    this.lastSamplesResult = this.host.validateSamples(request.index);
    if (this.lastClickResult === null) {
      this.lastClickResult = this.host.validateReprojection(request.index);
      this.renderClickResult();
    }
    this.renderSamplesResult();
    this.redrawOverlay();
  }

  private exportJson(): void {
    const request = this.selectedRequest();
    if (!request) {
      this.statusLine.textContent = "no request selected";
      return;
    }
    this.refreshLiveCapture();
    const report = this.host.exportValidation(request.index);
    if (!report) {
      this.statusLine.textContent = "report unavailable";
      return;
    }
    const blob = new Blob([serializeReport(report)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `coordinate-validation-request-${request.index}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    this.statusLine.textContent = `exported request #${request.index} report`;
  }

  private async copyJson(): Promise<void> {
    const request = this.selectedRequest();
    if (!request) {
      this.statusLine.textContent = "no request selected";
      return;
    }
    this.refreshLiveCapture();
    const report = this.host.exportValidation(request.index);
    if (!report) {
      this.statusLine.textContent = "report unavailable";
      return;
    }
    try {
      await navigator.clipboard.writeText(serializeReport(report));
      this.statusLine.textContent = `copied request #${request.index} report to clipboard`;
    } catch {
      this.statusLine.textContent = "clipboard copy failed (export JSON instead)";
    }
  }

  private overlayButtonLabel(): string {
    return `Overlay: ${this.overlayVisible ? "on" : "off"}`;
  }

  // ------------------------------------------------------------------
  // Feature A rendering: camera state comparison
  // ------------------------------------------------------------------

  private renderCameraComparison(): void {
    const request = this.selectedRequest();
    const snapshot = request?.click?.cameraSnapshot ?? null;
    const live = this.live;
    this.cameraSection.replaceChildren();

    const title = el("div", { marginBottom: "4px", color: COLORS.panelDim }, "camera state (click time vs now)");
    this.cameraSection.appendChild(title);

    if (!snapshot && !live) {
      this.cameraSection.appendChild(
        el("div", { color: COLORS.panelDim }, "no click-time snapshot and no live capture available"),
      );
      return;
    }

    const table = document.createElement("table");
    Object.assign(table.style, {
      width: "100%",
      borderCollapse: "collapse" as const,
      font: `10px ${MONO}`,
      marginBottom: "4px",
    });
    const headRow = document.createElement("tr");
    headRow.append(
      ...["", "click time", "validation time", "Δ"].map((text) => {
        const th = document.createElement("th");
        th.textContent = text;
        Object.assign(th.style, {
          textAlign: "left" as const,
          color: COLORS.panelDim,
          padding: "1px 4px",
          borderBottom: "1px solid rgba(255, 255, 255, 0.15)",
        });
        return th;
      }),
    );
    table.appendChild(headRow);

    const rows: Array<[string, string, string, string]> = [];
    if (snapshot && live) {
      const a = snapshot.camera;
      const b = live.camera;
      rows.push([
        "position",
        `(${fmt(a.position.x)}, ${fmt(a.position.y)}, ${fmt(a.position.z)})`,
        `(${fmt(b.position.x)}, ${fmt(b.position.y)}, ${fmt(b.position.z)})`,
        fmt(Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y, b.position.z - a.position.z)),
      ]);
      rows.push([
        "quaternion",
        `(${fmt(a.quaternion.x, 2)}, ${fmt(a.quaternion.y, 2)}, ${fmt(a.quaternion.z, 2)}, ${fmt(a.quaternion.w, 2)})`,
        `(${fmt(b.quaternion.x, 2)}, ${fmt(b.quaternion.y, 2)}, ${fmt(b.quaternion.z, 2)}, ${fmt(b.quaternion.w, 2)})`,
        "",
      ]);
      rows.push(["fov", fmt(a.fov, 1), fmt(b.fov, 1), fmt(b.fov !== null && a.fov !== null ? b.fov - a.fov : null, 1)]);
      rows.push(["aspect", fmt(a.aspect), fmt(b.aspect), fmt(b.aspect !== null && a.aspect !== null ? b.aspect - a.aspect : null)]);
      rows.push(["near / far", `${fmt(a.near)} / ${fmt(a.far)}`, `${fmt(b.near)} / ${fmt(b.far)}`, ""]);
      rows.push(["camera type", a.cameraType, b.cameraType, a.cameraType === b.cameraType ? "same" : "CHANGED"]);
      rows.push([
        "canvas rect",
        `${fmt(snapshot.viewport.rectLeft, 0)},${fmt(snapshot.viewport.rectTop, 0)} ${fmt(snapshot.viewport.rectWidth, 0)}x${fmt(snapshot.viewport.rectHeight, 0)}`,
        `${fmt(live.viewport.rectLeft, 0)},${fmt(live.viewport.rectTop, 0)} ${fmt(live.viewport.rectWidth, 0)}x${fmt(live.viewport.rectHeight, 0)}`,
        "",
      ]);
      rows.push([
        "buffer / dpr",
        `${snapshot.viewport.bufferWidth}x${snapshot.viewport.bufferHeight} @ ${snapshot.viewport.devicePixelRatio}`,
        `${live.viewport.bufferWidth}x${live.viewport.bufferHeight} @ ${live.viewport.devicePixelRatio}`,
        "",
      ]);
    } else if (snapshot) {
      const a = snapshot.camera;
      rows.push(["position", `(${fmt(a.position.x)}, ${fmt(a.position.y)}, ${fmt(a.position.z)})`, "n/a", ""]);
      rows.push(["fov / aspect", `${fmt(a.fov, 1)} / ${fmt(a.aspect)}`, "n/a", ""]);
      rows.push(["camera type", a.cameraType, "n/a", ""]);
      rows.push([
        "canvas rect",
        `${fmt(snapshot.viewport.rectLeft, 0)},${fmt(snapshot.viewport.rectTop, 0)} ${fmt(snapshot.viewport.rectWidth, 0)}x${fmt(snapshot.viewport.rectHeight, 0)}`,
        "n/a",
        "",
      ]);
    } else {
      const b = live!.camera;
      rows.push(["position", "n/a (no click snapshot)", `(${fmt(b.position.x)}, ${fmt(b.position.y)}, ${fmt(b.position.z)})`, ""]);
      rows.push(["fov / aspect", "n/a", `${fmt(b.fov, 1)} / ${fmt(b.aspect)}`, ""]);
      rows.push(["camera type", "n/a", b.cameraType, ""]);
    }
    for (const [label, clickValue, liveValue, delta] of rows) {
      const tr = document.createElement("tr");
      for (const [text, isLabel] of [[label, true], [clickValue, false], [liveValue, false], [delta, false]] as const) {
        const cell = document.createElement("td");
        cell.textContent = text;
        Object.assign(cell.style, {
          padding: "1px 4px",
          verticalAlign: "top" as const,
          color: isLabel ? COLORS.panelDim : COLORS.panelText,
          borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
          whiteSpace: "nowrap" as const,
        });
        tr.appendChild(cell);
      }
      table.appendChild(tr);
    }
    this.cameraSection.appendChild(table);

    if (snapshot) {
      const details = el("details", { marginTop: "2px" });
      const summary = el("summary", { cursor: "pointer", color: COLORS.panelDim }, "matrices (world / world⁻¹ / projection)");
      const pre = el("pre", {
        font: `9px ${MONO}`,
        whiteSpace: "pre" as const,
        color: COLORS.panelText,
        margin: "4px 0",
      });
      pre.textContent =
        `click-time worldMatrix:\n${matrixText(snapshot.camera.worldMatrix)}\n\n` +
        `click-time inverseWorldMatrix:\n${matrixText(snapshot.camera.inverseWorldMatrix)}\n\n` +
        `click-time projectionMatrix:\n${matrixText(snapshot.camera.projectionMatrix)}` +
        (live
          ? `\n\nvalidation-time worldMatrix:\n${matrixText(live.camera.worldMatrix)}\n\n` +
            `validation-time projectionMatrix:\n${matrixText(live.camera.projectionMatrix)}`
          : "");
      details.append(summary, pre);
      this.cameraSection.appendChild(details);
      if (snapshot.splat) {
        const splatLine = el("div", { color: COLORS.panelDim }, this.splatSummary(snapshot.splat));
        this.cameraSection.appendChild(splatLine);
      }
    }
  }

  private splatSummary(splat: { position: { x: number; y: number; z: number }; quaternion: { x: number; y: number; z: number; w: number }; scale: { x: number; y: number; z: number } }): string {
    return (
      `splat (click time): position (${fmt(splat.position.x)}, ${fmt(splat.position.y)}, ${fmt(splat.position.z)}) ` +
      `scale (${fmt(splat.scale.x)}, ${fmt(splat.scale.y)}, ${fmt(splat.scale.z)}) ` +
      `quat (${fmt(splat.quaternion.x, 2)}, ${fmt(splat.quaternion.y, 2)}, ${fmt(splat.quaternion.z, 2)}, ${fmt(splat.quaternion.w, 2)})`
    );
  }

  // ------------------------------------------------------------------
  // Features B/C rendering: results
  // ------------------------------------------------------------------

  private renderClickResult(): void {
    const result = this.lastClickResult;
    if (!result) return;
    this.clearResultNodes("click-result");
    const box = el("div", {
      border: "1px solid rgba(255, 255, 255, 0.14)",
      borderRadius: "4px",
      padding: "6px",
      marginBottom: "6px",
    }, "");
    box.classList.add("click-result");
    box.appendChild(el("div", { marginBottom: "3px" }, "click-hit reprojection"));
    if (result.status === "unavailable") {
      box.appendChild(el("div", { color: "#ff8095" }, `unavailable: ${result.reason}`));
      this.resultsSection.appendChild(box);
      return;
    }
    const lines: string[] = [];
    lines.push(`original:   u=${fmt(result.original?.u, 4)} v=${fmt(result.original?.v, 4)} (client ${result.original?.clientX ?? "?"},${result.original?.clientY ?? "?"})`);
    if (result.projected?.normalized) {
      lines.push(`projected:  u=${fmt(result.projected.normalized.u, 4)} v=${fmt(result.projected.normalized.v, 4)}`);
      lines.push(`error:      ${fmt(result.errors?.normalized, 5)} normalized / ${fmt(result.errors?.pixels, 1)} px`);
      lines.push(`behind camera: ${result.projected.behindCamera} · outside clip volume: ${result.projected.outsideClipVolume} · view z=${fmt(result.projected.viewZ)}`);
    } else {
      lines.push("projected:  (point behind camera — projection undefined)");
      lines.push(`behind camera: true`);
    }
    if (result.rayConsistency) {
      lines.push(`ray consistency: hit is ${fmt(result.rayConsistency.offset, 5)} from origin + direction × distance`);
    }
    if (result.spaceHypothesis) {
      const hypothesis = result.spaceHypothesis;
      lines.push(`space hypothesis: world err=${fmt(hypothesis.worldError, 5)} splat-local err=${fmt(hypothesis.splatLocalError, 5)} → ${hypothesis.verdict}`);
    }
    box.appendChild(el("pre", { whiteSpace: "pre" as const, margin: "0" }, lines.join("\n")));
    this.resultsSection.appendChild(box);
  }

  private renderSamplesResult(): void {
    const result = this.lastSamplesResult;
    if (!result) return;
    this.clearResultNodes("samples-result");
    const box = el("div", {
      border: "1px solid rgba(255, 255, 255, 0.14)",
      borderRadius: "4px",
      padding: "6px",
      marginBottom: "6px",
    }, "");
    box.classList.add("samples-result");
    box.appendChild(el("div", { marginBottom: "3px" }, "sampling-hit reprojection"));
    if (result.status === "unavailable") {
      box.appendChild(el("div", { color: "#ffb35c" }, `projection unavailable: ${result.reason}`));
    }

    const counts = el("pre", { whiteSpace: "pre" as const, margin: "0 0 4px" }, [
      `cells: ${result.totalCells} (hits ${result.hitCells}, misses ${result.missCells})`,
      `projected: ${result.projectedCells} · behind camera: ${result.behindCameraCells}`,
      `camera unavailable: ${result.cameraUnavailableCells} · ray inconsistent: ${result.rayInconsistentCells}`,
    ].join("\n"));
    box.appendChild(counts);

    if (result.normalizedErrorStats && result.pixelErrorStats) {
      const stats = el("pre", { whiteSpace: "pre" as const, margin: "0 0 4px" }, [
        "normalized error:  mean " + fmt(result.normalizedErrorStats.mean, 5) +
          " · median " + fmt(result.normalizedErrorStats.median, 5) +
          " · max " + fmt(result.normalizedErrorStats.max, 5) +
          " · p95 " + fmt(result.normalizedErrorStats.p95, 5),
        "pixel error:       mean " + fmt(result.pixelErrorStats.mean, 1) +
          " · median " + fmt(result.pixelErrorStats.median, 1) +
          " · max " + fmt(result.pixelErrorStats.max, 1) +
          " · p95 " + fmt(result.pixelErrorStats.p95, 1),
      ].join("\n"));
      box.appendChild(stats);
    }

    const table = document.createElement("table");
    Object.assign(table.style, {
      width: "100%",
      borderCollapse: "collapse" as const,
      font: `10px ${MONO}`,
    });
    table.appendChild(this.sampleHeaderRow(["r/c", "original", "projected", "err norm", "err px", "view z", "status"]));
    const maxRows = 500;
    const fragment = document.createDocumentFragment();
    const rowsToShow = result.rows.slice(0, maxRows);
    for (const row of rowsToShow) {
      const tr = document.createElement("tr");
      const cells = [
        `${row.row},${row.col}`,
        `${fmt(row.originalU, 3)},${fmt(row.originalV, 3)}`,
        row.projectedU === null ? "—" : `${fmt(row.projectedU, 3)},${fmt(row.projectedV!, 3)}`,
        row.normalizedError === null ? "—" : fmt(row.normalizedError, 4),
        row.pixelError === null ? "—" : fmt(row.pixelError, 1),
        row.viewZ === null ? "—" : fmt(row.viewZ, 2),
        row.status,
      ];
      for (const text of cells) {
        const td = document.createElement("td");
        td.textContent = text;
        Object.assign(td.style, {
          padding: "0 4px",
          whiteSpace: "nowrap" as const,
          borderBottom: "1px solid rgba(255, 255, 255, 0.05)",
          color: row.status === "ok" ? COLORS.panelText : row.status === "miss" ? COLORS.panelDim : "#ffb35c",
        });
        tr.appendChild(td);
      }
      fragment.appendChild(tr);
    }
    table.appendChild(fragment);
    if (result.rows.length > maxRows) {
      const note = el("div", { color: COLORS.panelDim, marginTop: "2px" }, `(+${result.rows.length - maxRows} more rows — see Export JSON)`);
      box.appendChild(note);
    }
    const scroller = el("div", { maxHeight: "220px", overflowY: "auto" });
    scroller.appendChild(table);
    box.appendChild(scroller);
    this.resultsSection.appendChild(box);
  }

  private sampleHeaderRow(labels: readonly string[]): HTMLTableRowElement {
    const tr = document.createElement("tr");
    for (const text of labels) {
      const th = document.createElement("th");
      th.textContent = text;
      Object.assign(th.style, {
        textAlign: "left" as const,
        position: "sticky" as const,
        top: "0",
        background: "rgba(10, 12, 16, 1)",
        color: COLORS.panelDim,
        padding: "1px 4px",
      });
      tr.appendChild(th);
    }
    return tr;
  }

  private clearResultNodes(className: string): void {
    for (const node of [...this.resultsSection.children]) {
      if ((node as HTMLElement).classList?.contains(className)) node.remove();
    }
  }

  // ------------------------------------------------------------------
  // Feature D: visual comparison overlay
  // ------------------------------------------------------------------

  private resizeOverlay(): void {
    const dpr = window.devicePixelRatio || 1;
    this.overlayCanvas.width = Math.round(window.innerWidth * dpr);
    this.overlayCanvas.height = Math.round(window.innerHeight * dpr);
    this.overlayContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Redraw the frozen-click vs reprojected overlay. Frozen coordinates and
   * click-time reprojections come from the diagnostic records; "live"
   * projections use the camera captured at the last redraw (labelled as
   * such — this is a frozen drawing, not a render loop).
   */
  private redrawOverlay(): void {
    if (this.disposed) return;
    const ctx = this.overlayContext;
    const width = window.innerWidth;
    const height = window.innerHeight;
    ctx.clearRect(0, 0, width, height);
    this.overlayCanvas.style.display =
      this.overlayVisible && this.isVisible ? "block" : "none";
    if (!this.overlayVisible || !this.isVisible) return;

    const request = this.selectedRequest();
    const snapshot = request?.click?.cameraSnapshot ?? null;
    if (!request) return;

    const rectOf = (viewport: { rectLeft: number; rectTop: number; rectWidth: number; rectHeight: number }) => ({
      x: (u: number) => viewport.rectLeft + u * viewport.rectWidth,
      y: (v: number) => viewport.rectTop + v * viewport.rectHeight,
    });

    // Live projection of the click hit, with the camera captured at the last
    // redraw (clearly labelled — NOT the click-time reprojection).
    const liveMap = this.live
      ? rectOf(this.live.viewport)
      : null;

    // --- Original + reprojected sampling cells ---
    if (this.lastSamplesResult && snapshot) {
      const map = rectOf(snapshot.viewport);
      ctx.lineWidth = 1;
      for (const row of this.lastSamplesResult.rows) {
        if (row.status === "miss" || row.projectedU === null) continue;
        const ox = map.x(row.originalU);
        const oy = map.y(row.originalV);
        const px = map.x(row.projectedU);
        const py = map.y(row.projectedV!);
        // Original cell centre: hollow cyan circle.
        ctx.strokeStyle = "#33e0ff";
        ctx.beginPath();
        ctx.arc(ox, oy, 3, 0, Math.PI * 2);
        ctx.stroke();
        // Reprojected hit: filled cyan square.
        ctx.fillStyle = "rgba(51, 224, 255, 0.85)";
        ctx.fillRect(px - 2.5, py - 2.5, 5, 5);
        // Error vector, orange.
        if (Math.hypot(px - ox, py - oy) > 0.5) {
          ctx.strokeStyle = "rgba(255, 165, 0, 0.7)";
          ctx.beginPath();
          ctx.moveTo(ox, oy);
          ctx.lineTo(px, py);
          ctx.stroke();
        }
      }
    }

    // --- Original click + reprojected click hit ---
    const click = request.click;
    if (click && snapshot) {
      const map = rectOf(snapshot.viewport);
      const cx = map.x(click.normalizedX);
      const cy = map.y(click.normalizedY);
      ctx.strokeStyle = COLORS.clickHit;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - 14, cy);
      ctx.lineTo(cx + 14, cy);
      ctx.moveTo(cx, cy - 14);
      ctx.lineTo(cx, cy + 14);
      ctx.stroke();

      if (this.lastClickResult?.projected?.normalized) {
        const { u, v } = this.lastClickResult.projected.normalized;
        const px = map.x(u);
        const py = map.y(v);
        // Error vector.
        ctx.strokeStyle = "#ffa500";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(px, py);
        ctx.stroke();
        // Reprojected click hit: magenta filled square.
        ctx.fillStyle = "#ff44ff";
        ctx.fillRect(px - 4, py - 4, 8, 8);
      }

      // Live projection of the click hit with the last-redraw camera — grey ×,
      // clearly distinct from the frozen click-time markers above.
      if (this.lastClickResult?.hit && this.live && liveMap) {
        const liveProjection = projectPoint(this.lastClickResult.hit.position, this.live.camera);
        if (liveProjection.normalized) {
          const lx = liveMap.x(liveProjection.normalized.u);
          const ly = liveMap.y(liveProjection.normalized.v);
          ctx.strokeStyle = "rgba(190, 196, 204, 0.9)";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(lx - 6, ly - 6);
          ctx.lineTo(lx + 6, ly + 6);
          ctx.moveTo(lx + 6, ly - 6);
          ctx.lineTo(lx - 6, ly + 6);
          ctx.stroke();
        }
      }
    }

    this.drawOverlayLegend();
  }

  private drawOverlayLegend(): void {
    const ctx = this.overlayContext;
    const lines: Array<[string, string]> = [
      ["#ffd400", "original click (frozen click-time 2D)"],
      ["#ff44ff", "reprojected click hit (click-time camera)"],
      ["#33e0ff", "sample cells: original ○ / reprojected ▪"],
      ["#ffa500", "error vectors (original → projected)"],
      ["#bec4cc", "live click-hit projection (camera at last redraw)"],
    ];
    ctx.font = `11px ${MONO}`;
    const padding = 8;
    let maxWidth = 0;
    for (const [, text] of lines) maxWidth = Math.max(maxWidth, ctx.measureText(text).width);
    const lineHeight = 16;
    const boxHeight = lines.length * lineHeight + padding * 2;
    const top = window.innerHeight - boxHeight - 12;
    ctx.fillStyle = "rgba(10, 12, 16, 0.82)";
    ctx.fillRect(12, top, maxWidth + padding * 2 + 14, boxHeight);
    let y = top + padding + 4;
    for (const [color, text] of lines) {
      ctx.fillStyle = color;
      ctx.fillRect(12 + padding, y - 8, 10, 3);
      ctx.fillStyle = COLORS.panelText;
      ctx.fillText(text, 12 + padding + 14, y);
      y += lineHeight;
    }
  }
}
