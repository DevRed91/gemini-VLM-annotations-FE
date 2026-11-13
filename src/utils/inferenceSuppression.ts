/** True only for the explicit development demo opt-in. */
export function isDemoInferenceSuppressed(search: string, development: boolean): boolean {
  if (!development) return false;
  const params = new URLSearchParams(search);
  return params.get("demo") === "1" && params.get("inference") === "off";
}

/** Keeps the request callback entirely unstarted when inference is disabled. */
export function dispatchGeminiInference(
  enabled: boolean,
  dispatch: () => Promise<void>,
): Promise<void> {
  if (!enabled) return Promise.resolve();
  return dispatch();
}
