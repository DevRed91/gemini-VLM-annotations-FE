// Bundle entry for scripts/phase4-validate.mjs (kept outside src/ so tsc ignores it).
export { fitOBB } from "../src/utils/obbFit";
export {
  default as GeometricContextManager,
  adaptiveEps,
  filterDepthOutliers,
} from "../src/GeometricContextManager/GeometricContextManager";
export * as THREE from "three";
