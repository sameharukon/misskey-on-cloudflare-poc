/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Misskey-compatible ID helpers. Default scheme for existing DBs is aidx.
 * Do not change ID scheme for existing databases (README: Compatibility).
 */

export {
  TIME2000,
  AIDX_LENGTH,
  aidxRegExp,
  genAidx,
  parseAidx,
  parseAidxFull,
  isSafeAidxT,
  parseBigInt36,
  setAidxNodeId,
  getAidxNodeId,
  resetAidxCounter,
} from "./aidx.js";

import { genAidx as _genAidx, parseAidx as _parseAidx } from "./aidx.js";

/** Convenience: genAidx from Date (uses Date.getTime()). */
export function genAidxFromDate(date: Date = new Date()): string {
  return _genAidx(date.getTime());
}

/** Parse time from aidx; null if shape is wrong. */
export function parseAidxTime(id: string): Date | null {
  if (!/^[0-9a-z]{16}$/.test(id)) return null;
  return _parseAidx(id).date;
}
