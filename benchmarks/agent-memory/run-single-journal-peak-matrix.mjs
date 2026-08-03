import { runRetentionPeakMatrix } from './retention-peak-matrix.mjs';

runRetentionPeakMatrix(new URL('./measure-single-journal-case.mjs', import.meta.url), [
  'legacy-double',
  'single-journal',
]);
