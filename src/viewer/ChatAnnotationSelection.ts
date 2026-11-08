/**
 * Viewer-owned chat selection state.
 *
 * This is deliberately a small, dependency-free state core rather than a
 * parallel selection system: `SplatViewer` supplies the current annotation IDs,
 * owns all visual updates, and is the only public API surface. Chat code can
 * request IDs, but never resolve or manipulate annotation visuals.
 */
export class ChatAnnotationSelection {
  private selected: ReadonlySet<string> = new Set<string>();

  /**
   * Replaces the selection with current, valid annotation IDs in request order.
   * Invalid/stale IDs and duplicates are ignored; malformed input is rejected.
   */
  set(
    annotationIds: readonly unknown[],
    validAnnotationIds: ReadonlySet<string>,
  ): string[] {
    if (!Array.isArray(annotationIds)) {
      throw new TypeError("annotationIds must be an array of annotation IDs");
    }

    const next = new Set<string>();
    for (const annotationId of annotationIds) {
      if (typeof annotationId !== "string") continue;
      if (validAnnotationIds.has(annotationId)) next.add(annotationId);
    }

    this.selected = next;
    return this.getSelectedIds();
  }

  clear(): boolean {
    if (this.selected.size === 0) return false;
    this.selected = new Set<string>();
    return true;
  }

  remove(annotationId: string): boolean {
    if (!this.selected.has(annotationId)) return false;
    const next = new Set(this.selected);
    next.delete(annotationId);
    this.selected = next;
    return true;
  }

  has(annotationId: string): boolean {
    return this.selected.has(annotationId);
  }

  getSelectedIds(): string[] {
    return [...this.selected];
  }
}
