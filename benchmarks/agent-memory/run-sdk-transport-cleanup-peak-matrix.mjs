import { runRetentionPeakMatrix } from './retention-peak-matrix.mjs';

runRetentionPeakMatrix(new URL('./measure-sdk-transport-cleanup-case.mjs', import.meta.url), [
  'legacy-sdk-stream',
  'released-sdk-stream',
]);
