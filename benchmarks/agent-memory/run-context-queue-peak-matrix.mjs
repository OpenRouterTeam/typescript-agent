import { runRetentionPeakMatrix } from './retention-peak-matrix.mjs';

runRetentionPeakMatrix(new URL('./measure-context-queue-case.mjs', import.meta.url), [
  'array-shift',
  'head-index',
]);
